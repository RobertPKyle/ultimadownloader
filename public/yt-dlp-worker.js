/**
 * Web Worker: Pyodide + yt-dlp running entirely in the browser.
 *
 * Architecture:
 *  - yt-dlp uses raw sockets (http.client → socket.connect) which don't
 *    exist in browsers. Pyodide's urllib patch only affects the *default*
 *    opener; yt-dlp builds its own and bypasses it.
 *  - Fix: replace ydl.urlopen with a Python function that uses synchronous
 *    XMLHttpRequest (allowed in Web Workers, not in the main thread).
 *  - Both fetch AND XMLHttpRequest are patched to route through the
 *    Cloudflare CORS proxy so cross-origin requests succeed.
 */

const PROXY = 'https://ytpultimadownloader.robertpetersonkyle2.workers.dev/';

let pyodide = null;
let ready   = false;

const shouldProxy = (url) =>
  typeof url === 'string' &&
  (url.startsWith('http://') || url.startsWith('https://')) &&
  !url.startsWith(PROXY);

const proxied = (url) => PROXY + '?url=' + encodeURIComponent(url);

function installProxyInterceptors() {
  // 1. Patch fetch — used by Pyodide's async urllib and micropip.
  const _origFetch = self.fetch.bind(self);
  self.fetch = (input, init = {}) => {
    const url =
      typeof input === 'string' ? input
      : input instanceof URL    ? input.href
      : input.url;
    if (shouldProxy(url)) return _origFetch(proxied(url), init);
    return _origFetch(input, init);
  };

  // 2. Patch XMLHttpRequest — used by our synchronous Python urlopen below.
  //    Synchronous XHR is deprecated on the main thread but fully supported
  //    inside Web Workers.
  const _OrigXHR = self.XMLHttpRequest;
  class ProxiedXHR extends _OrigXHR {
    open(method, url, async = true, user, password) {
      const target = shouldProxy(url) ? proxied(url) : url;
      return super.open(method, target, async, user, password);
    }
  }
  self.XMLHttpRequest = ProxiedXHR;
}

async function init() {
  try {
    postStatus('Loading Python runtime (~30 MB, cached after first load)...');

    importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js');
    pyodide = await loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/',
    });

    postStatus('Installing yt-dlp...');
    await pyodide.loadPackage(['micropip', 'ssl']);
    await pyodide.runPythonAsync(`
import micropip
await micropip.install('yt-dlp')
    `);

    // Install AFTER package loading so Pyodide's CDN requests aren't proxied.
    installProxyInterceptors();

    // Define the synchronous XHR-based urlopen that we'll inject into yt-dlp.
    await pyodide.runPythonAsync(`
import js, io
from yt_dlp.networking.common import Response
from yt_dlp.networking.exceptions import HTTPError, TransportError

def _pyodide_urlopen(req):
    """
    Replacement for YoutubeDL.urlopen.
    Uses synchronous XMLHttpRequest (allowed in Web Workers).
    XHR.open() is patched in JS to route through the CORS proxy.
    """
    url    = req.url
    method = req.method
    data   = req.data

    js.console.log(f"[yt-dlp] {method} {url}")

    xhr = js.XMLHttpRequest.new()
    xhr.open(method, url, False)   # False = synchronous

    for key, val in req.headers.items():
        if key.lower() == 'origin':
            # Browser XHR forbids setting Origin directly.
            # Pass it via a custom header; the Cloudflare Worker injects it.
            try:
                xhr.setRequestHeader('X-Override-Origin', str(val))
            except Exception:
                pass
        else:
            try:
                xhr.setRequestHeader(key, str(val))
            except Exception:
                pass

    # arraybuffer: browser auto-decompresses gzip/br, gives us raw bytes.
    # We must strip Content-Encoding from the response headers so yt-dlp
    # doesn't try to decompress already-decompressed content.
    xhr.responseType = 'arraybuffer'

    if data is not None:
        if isinstance(data, (bytes, bytearray, memoryview)):
            xhr.send(js.Uint8Array.new(bytes(data)))
        else:
            xhr.send(data)
    else:
        xhr.send()

    status = xhr.status

    # status == 0 means the XHR failed before getting a response
    # (network error, CORS block, or proxy unreachable)
    if status == 0:
        raise TransportError(cause=Exception(
            f"XHR status 0 for {url} — likely CORS block or proxy unreachable"
        ))

    final_url = xhr.responseURL or url
    content   = bytes(js.Uint8Array.new(xhr.response)) if xhr.response else b''

    js.console.log(f"[yt-dlp] → {status} ({len(content)} bytes) {final_url}")
    # Log a preview of the response so we can see what YouTube is returning
    js.console.log(f"[yt-dlp] preview: {content[:300].decode('utf-8', errors='replace')}")

    # Parse response headers
    headers = {}
    for line in (xhr.getAllResponseHeaders() or '').strip().split('\\r\\n'):
        if ':' in line:
            k, _, v = line.partition(':')
            headers[k.strip()] = v.strip()

    # Browser auto-decompresses; remove encoding headers so yt-dlp doesn't
    # try to decompress a second time.
    headers.pop('content-encoding', None)
    headers.pop('Content-Encoding', None)
    headers.pop('content-length', None)
    headers.pop('Content-Length', None)

    resp = Response(fp=io.BytesIO(content), url=final_url,
                    headers=headers, status=status)

    if status >= 400:
        raise HTTPError(resp)

    return resp
    `);

    ready = true;
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Init failed: ' + err.message });
  }
}

self.onmessage = async ({ data }) => {
  const { type, url, format } = data;

  if (type === 'init') { await init(); return; }

  if (type === 'extract') {
    if (!ready) {
      self.postMessage({ type: 'error', message: 'Python runtime not ready yet.' });
      return;
    }

    try {
      postStatus('Fetching video info...');

      pyodide.globals.set('_url', url);
      pyodide.globals.set('_fmt', format);

      const resultJson = await pyodide.runPythonAsync(`
import json
from yt_dlp import YoutubeDL

# Use permissive selectors — ffmpeg handles all format/codec conversion.
# Pinning extensions (e.g. [ext=mp4]) is too strict with the android client
# and causes "Requested format is not available" errors.
AUDIO_FMTS = {'mp3', 'm4a', 'aac', 'opus', 'wav', 'flac'}

is_audio  = _fmt in AUDIO_FMTS
ydl_format = 'bestaudio/best' if is_audio else 'bestvideo+bestaudio/best'

ydl_opts = {
    'format':      ydl_format,
    'quiet':       True,
    'no_warnings': True,
    'noplaylist':  True,
    'extractor_args': {
        'youtube': {
            'player_client': ['android'],
            'player_skip':   ['webpage', 'configs'],
        }
    },
}

with YoutubeDL(ydl_opts) as ydl:
    ydl.urlopen = _pyodide_urlopen
    info = ydl.extract_info(_url, download=False)

# Resolve stream URLs — may be one (pre-merged) or two (video + audio)
stream_url = None
audio_url  = None
needs_merge = False
ext = _fmt

audio_ext = 'm4a'

if info.get('requested_formats') and len(info['requested_formats']) >= 2:
    needs_merge = True
    for fmt in info['requested_formats']:
        has_video = fmt.get('vcodec', 'none') != 'none'
        has_audio = fmt.get('acodec', 'none') != 'none'
        if has_video and not stream_url:
            stream_url = fmt['url']
            ext = fmt.get('ext', 'mp4')
        elif has_audio and not has_video and not audio_url:
            audio_url = fmt['url']
            audio_ext = fmt.get('ext', 'm4a')
elif info.get('requested_formats') and len(info['requested_formats']) == 1:
    stream_url = info['requested_formats'][0]['url']
    ext = info['requested_formats'][0].get('ext', _fmt)
elif 'url' in info:
    stream_url = info['url']
    ext = info.get('ext', _fmt)
elif info.get('formats'):
    chosen = next((f for f in reversed(info['formats']) if f.get('url')), info['formats'][-1])
    stream_url = chosen['url']
    ext = chosen.get('ext', _fmt)

if not stream_url:
    raise RuntimeError('yt-dlp returned no downloadable URL.')

json.dumps({
    'streamUrl':       stream_url,
    'audioUrl':        audio_url,
    'needsMerge':      needs_merge,
    'title':           info.get('title', 'download'),
    'ext':             ext,
    'audioExt':        audio_ext,
    'requestedFormat': _fmt,
    'filesize':        info.get('filesize') or info.get('filesize_approx'),
})
      `);

      self.postMessage({ type: 'extracted', data: JSON.parse(resultJson) });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};

function postStatus(message) {
  self.postMessage({ type: 'status', message });
}

init();
