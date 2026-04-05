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

    postStatus('Installing yt-dlp + gallery-dl...');
    await pyodide.loadPackage(['micropip', 'ssl', 'sqlite3']);
    await pyodide.runPythonAsync(`
import micropip
await micropip.install(['yt-dlp', 'gallery-dl', 'requests'])
    `);

    // Install AFTER package loading so Pyodide's CDN requests aren't proxied.
    installProxyInterceptors();

    // Core XHR helper — used by both yt-dlp and gallery-dl patches.
    await pyodide.runPythonAsync(`
import js, io

# Forbidden XHR headers the browser silently drops — skip them.
_XHR_SKIP = frozenset([
    'host', 'content-length', 'transfer-encoding', 'connection',
    'te', 'trailer', 'upgrade', 'accept-encoding',
])

def _do_xhr(method, url, headers, body):
    """Synchronous XHR routed through the CORS proxy (via JS patch)."""
    xhr = js.XMLHttpRequest.new()
    xhr.open(method, url, False)   # False = synchronous

    for key, val in (headers or {}).items():
        k = key.lower()
        if k in _XHR_SKIP:
            continue
        if k == 'origin':
            try: xhr.setRequestHeader('X-Override-Origin', str(val))
            except Exception: pass
        elif k == 'cookie':
            try: xhr.setRequestHeader('X-Override-Cookie', str(val))
            except Exception: pass
        elif k == 'referer':
            try: xhr.setRequestHeader('X-Override-Referer', str(val))
            except Exception: pass
        elif k == 'user-agent':
            try: xhr.setRequestHeader('X-Override-User-Agent', str(val))
            except Exception: pass
        else:
            try: xhr.setRequestHeader(key, str(val))
            except Exception: pass

    xhr.responseType = 'arraybuffer'

    if body is not None:
        if isinstance(body, (bytes, bytearray, memoryview)):
            xhr.send(js.Uint8Array.new(bytes(body)))
        else:
            xhr.send(str(body))
    else:
        xhr.send()

    return xhr

def _parse_xhr_headers(xhr):
    headers = {}
    for line in (xhr.getAllResponseHeaders() or '').strip().split('\\r\\n'):
        if ':' in line:
            k, _, v = line.partition(':')
            headers[k.strip()] = v.strip()
    # Browser auto-decompresses; strip these so libraries don't double-decompress.
    for h in ('content-encoding', 'Content-Encoding', 'content-length', 'Content-Length'):
        headers.pop(h, None)
    return headers
    `);

    // ── yt-dlp patch ─────────────────────────────────────────────────────────
    await pyodide.runPythonAsync(`
from yt_dlp.networking.common import Response
from yt_dlp.networking.exceptions import HTTPError, TransportError

def _pyodide_urlopen(req):
    js.console.log(f"[yt-dlp] {req.method} {req.url}")
    xhr = _do_xhr(req.method, req.url, dict(req.headers), req.data)
    status = xhr.status
    if status == 0:
        raise TransportError(cause=Exception(f"XHR status 0 for {req.url}"))
    content   = bytes(js.Uint8Array.new(xhr.response)) if xhr.response else b''
    final_url = xhr.responseURL or req.url
    js.console.log(f"[yt-dlp] -> {status} ({len(content)} bytes)")
    resp = Response(fp=io.BytesIO(content), url=final_url,
                    headers=_parse_xhr_headers(xhr), status=status)
    if status >= 400:
        raise HTTPError(resp)
    return resp
    `);

    // ── gallery-dl patch (replaces requests.Session.send globally) ────────────
    await pyodide.runPythonAsync(`
import requests
from requests.models import Response as RResponse
from requests.structures import CaseInsensitiveDict

def _gdl_session_send(self, prep, **kwargs):
    js.console.log(f"[gallery-dl] {prep.method} {prep.url}")
    xhr = _do_xhr(prep.method, prep.url, dict(prep.headers), prep.body)
    status = xhr.status

    r = RResponse()
    r.status_code = status
    r.url = xhr.responseURL or prep.url
    r.request = prep
    r.headers = CaseInsensitiveDict(_parse_xhr_headers(xhr))
    r._content = bytes(js.Uint8Array.new(xhr.response)) if xhr.response else b''
    r.encoding  = 'utf-8'
    return r

requests.Session.send = _gdl_session_send
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

      let targetUrl = url.trim();
      // Reddit workaround
      if (targetUrl.includes('reddit.com/r/') && !targetUrl.endsWith('.json')) {
        targetUrl = targetUrl.split('?')[0].replace(/\/$/, '') + '/.json';
      }

      // If it's a site that uses complex DASH/HLS (like Reddit or Dailymotion) or has aggressive anti-bot (like Rumble),
      // browser fetch/Pyodide will often fail. Jump straight to server-side extraction.
      if (targetUrl.includes('reddit.com') || targetUrl.includes('v.redd.it') || targetUrl.includes('rumble.com') || targetUrl.includes('dailymotion.com')) {
         throw new Error('COMPLEX_SITE_FALLBACK');
      }


      pyodide.globals.set('_url', targetUrl);
      pyodide.globals.set('_fmt', format);

      const resultJson = await pyodide.runPythonAsync(`
import json, urllib.parse
from yt_dlp import YoutubeDL

AUDIO_FMTS = {'mp3', 'm4a', 'aac', 'opus', 'wav', 'flac'}
is_audio   = _fmt in AUDIO_FMTS

if is_audio:
    ydl_format = 'bestaudio/best'
else:
    # Prefer mp4 for video to avoid VP9/WebM which needs transcoding for MP4 container
    if _fmt == 'mp4':
        ydl_format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
    else:
        ydl_format = 'bestvideo+bestaudio/best'

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

# Determine extractor based on domain
_domain = urllib.parse.urlparse(_url).netloc.lower()
js.console.log(f"[router] domain={_domain!r}")

# gallery-dl is only better for pure image galleries (Instagram, Facebook albums)
# For video sites like TikTok, Twitter, and YouTube, yt-dlp is far superior.
_use_gdl = (
    _domain.replace('www.', '') in {'instagram.com', 'instagr.am', 'facebook.com', 'fb.com'}
    and not any(x in _url.lower() for x in ['/video/', '/reel/', '/tv/', 'watch?v='])
)

# ── gallery-dl path ───────────────────────────────────────────────────────────
if _use_gdl:
    from gallery_dl import extractor as gdl_extractor
    from gallery_dl.extractor.message import Message
    import gallery_dl.config as gdl_config

    gdl_config.set(('extractor',), 'user-agent', UA)
    gdl_config.set(('extractor',), 'retries', 2)

    extr = gdl_extractor.find(_url)
    if extr is None:
        raise RuntimeError(f'gallery-dl: no extractor found for {_url}')

    # Collect all URLs the extractor yields
    VIDEO_EXTS = {'mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi', 'flv'}
    AUDIO_EXTS = {'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac'}
    candidates = []

    for msg in extr:
        if msg[0] == Message.Url:
            _, u, kw = msg
            candidates.append((u, dict(kw)))

    if not candidates:
        raise RuntimeError('gallery-dl: no URLs found')

    # Prefer video, then audio, then anything
    def _score(item):
        u, kw = item
        ext = (kw.get('extension') or u.rsplit('.', 1)[-1].split('?')[0]).lower()
        if ext in VIDEO_EXTS: return 2
        if ext in AUDIO_EXTS: return 1
        return 0

    best_url, best_kw = sorted(candidates, key=_score, reverse=True)[0]
    b_ext = (best_kw.get('extension') or best_url.rsplit('.', 1)[-1].split('?')[0]).lower()
    title = (best_kw.get('title') or best_kw.get('description') or 'download')[:200]

    _result = json.dumps({
        'streamUrl':       best_url,
        'streamHeaders':   {'Referer': _url, 'User-Agent': UA},
        'audioUrl':        None,
        'audioHeaders':    {},
        'needsMerge':      False,
        'title':           title,
        'ext':             b_ext if b_ext in VIDEO_EXTS | AUDIO_EXTS else 'mp4',
        'audioExt':        'm4a',
        'requestedFormat': _fmt,
        'filesize':        best_kw.get('filesize'),
    })

# ── yt-dlp path ───────────────────────────────────────────────────────────────
else:
    ydl_opts = {
        'format':         ydl_format,
        'quiet':          True,
        'no_warnings':    True,
        'noplaylist':     True,
        'socket_timeout': 30,
        'http_headers': {
            'User-Agent':      UA,
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        'extractor_args': {
            'youtube': {
                'player_client': ['android'],
                'player_skip':   ['webpage', 'configs'],
            },
        },
    }

    with YoutubeDL(ydl_opts) as ydl:
        ydl.urlopen = _pyodide_urlopen
        info = ydl.extract_info(_url, download=False)

    # Resolve stream URLs — may be one (pre-merged) or two (video + audio).
    # Also carry the http_headers yt-dlp specifies per-format — many sites
    # (Twitter, Vimeo, Dailymotion …) require Referer / Authorization headers
    # when downloading; we've been silently dropping them until now.
    stream_url     = None
    stream_headers = {}
    audio_url      = None
    audio_headers  = {}
    needs_merge    = False
    ext            = _fmt
    audio_ext      = 'm4a'

    def _fmt_headers(fmt):
        return dict(fmt.get('http_headers') or {})

    if info.get('requested_formats') and len(info['requested_formats']) >= 2:
        needs_merge = True
        for fmt in info['requested_formats']:
            has_video = fmt.get('vcodec', 'none') != 'none'
            has_audio = fmt.get('acodec', 'none') != 'none'
            if has_video and not stream_url:
                stream_url     = fmt['url']
                stream_headers = _fmt_headers(fmt)
                ext            = fmt.get('ext', 'mp4')
            elif has_audio and not has_video and not audio_url:
                audio_url     = fmt['url']
                audio_headers = _fmt_headers(fmt)
                audio_ext     = fmt.get('ext', 'm4a')
    elif info.get('requested_formats') and len(info['requested_formats']) == 1:
        f              = info['requested_formats'][0]
        stream_url     = f['url']
        stream_headers = _fmt_headers(f)
        ext            = f.get('ext', _fmt)
    elif 'url' in info:
        stream_url     = info['url']
        stream_headers = _fmt_headers(info)
        ext            = info.get('ext', _fmt)
    elif info.get('formats'):
        chosen         = next((f for f in reversed(info['formats']) if f.get('url')), info['formats'][-1])
        stream_url     = chosen['url']
        stream_headers = _fmt_headers(chosen)
        ext            = chosen.get('ext', _fmt)

    if not stream_url:
        raise RuntimeError('yt-dlp returned no downloadable URL.')

    # If it's an HLS/m3u8 playlist, browser fetchBinary will fail.
    # We must force a server-side fallback so yt-dlp can download the segments.
    if '.m3u8' in stream_url.lower() or 'm3u8' in ext.lower():
         raise RuntimeError('HLS_PLAYLIST_FALLBACK')

    _result = json.dumps({
        'streamUrl':       stream_url,
        'streamHeaders':   stream_headers,
        'audioUrl':        audio_url,
        'audioHeaders':    audio_headers,
        'needsMerge':      needs_merge,
        'title':           info.get('title', 'download'),
        'ext':             ext,
        'audioExt':        audio_ext,
        'requestedFormat': _fmt,
        'filesize':        info.get('filesize') or info.get('filesize_approx'),
    })

_result
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
