'use client';

import { useEffect, useRef, useState } from 'react';
import BuyMeACoffee from './BuyMeACoffee';

// The CORS proxy also handles the actual video download:
// - googlevideo.com has no CORS headers, so the browser can't fetch it directly
// - The stream URL is IP-signed to Cloudflare's IP (because extraction went
//   through the proxy), so only Cloudflare can fetch it anyway
const PROXY = 'https://ytpultimadownloader.robertpetersonkyle2.workers.dev/';

// Module-level ffmpeg singleton — loaded once, reused across downloads
let _ffmpegInstance = null;

// Load the UMD build from /public via a script tag so webpack never touches it.
// The UMD build creates a same-origin classic worker (/814.ffmpeg.js) that
// uses importScripts() to load ffmpeg-core — no blob-URL / module-import issues.
async function loadFFmpegScript() {
  if (typeof window === 'undefined' || window.FFmpegWASM) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/ffmpeg.umd.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load /ffmpeg.umd.js'));
    document.head.appendChild(s);
  });
}

async function loadFFmpegOnce(onStatus) {
  if (_ffmpegInstance) return _ffmpegInstance;
  onStatus('Loading video merger (first time ~30 MB, cached after)...');
  await loadFFmpegScript();
  const ff      = new window.FFmpegWASM.FFmpeg();
  // UMD worker (/814.ffmpeg.js) uses importScripts() to load ffmpeg-core from
  // unpkg — no webpack involvement, no blob-URL tricks needed.
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.9/dist/umd';
  await ff.load({
    coreURL: `${baseURL}/ffmpeg-core.js`,
    wasmURL: `${baseURL}/ffmpeg-core.wasm`,
  });
  _ffmpegInstance = ff;
  return ff;
}

const FORMATS = [
  { value: 'mp4',  label: 'MP4  (video)',  group: 'Video' },
  { value: 'mkv',  label: 'MKV  (video)',  group: 'Video' },
  { value: 'mov',  label: 'MOV  (video)',  group: 'Video' },
  { value: 'avi',  label: 'AVI  (video)',  group: 'Video' },
  { value: 'flv',  label: 'FLV  (video)',  group: 'Video' },
  { value: '3gp',  label: '3GP  (video)',  group: 'Video' },
  { value: 'm4a',  label: 'M4A  (audio)',  group: 'Audio' },
  { value: 'mp3',  label: 'MP3  (audio)',  group: 'Audio' },
  { value: 'aac',  label: 'AAC  (audio)',  group: 'Audio' },
  { value: 'opus', label: 'Opus (audio)',  group: 'Audio' },
  { value: 'wav',  label: 'WAV  (audio)',  group: 'Audio' },
  { value: 'flac', label: 'FLAC (audio)',  group: 'Audio' },
];

const STATUS = {
  BOOTING:     'booting',    // worker spawned, Pyodide loading
  READY:       'ready',      // idle, waiting for user input
  EXTRACTING:  'extracting', // yt-dlp running
  DOWNLOADING: 'downloading',// browser fetch in progress
  ERROR:       'error',
};

export default function UniversalDownloader() {
  const workerRef  = useRef(null);
  const [phase, setPhase]     = useState(STATUS.BOOTING);
  const [msg, setMsg]         = useState('Loading Python runtime...');
  const [url, setUrl]         = useState('');
  const [format, setFormat]   = useState('mp4');
  const [progress, setProgress] = useState(null); // { loaded, total } or null
  const [result, setResult]   = useState(null);   // { title, ext, filesize }

  useEffect(() => {
    const worker = new Worker('/yt-dlp-worker.js');
    workerRef.current = worker;

    worker.onmessage = async ({ data }) => {
      switch (data.type) {
        case 'status':
          setMsg(data.message);
          break;

        case 'ready':
          setPhase(STATUS.READY);
          setMsg('');
          break;

        case 'extracted':
          setPhase(STATUS.DOWNLOADING);
          setMsg('Downloading...');
          setProgress(null);
          await streamDownload(data.data);
          break;

        case 'error':
          setPhase(STATUS.ERROR);
          setMsg(data.message);
          break;
      }
    };

    worker.onerror = (e) => {
      setPhase(STATUS.ERROR);
      setMsg('Worker error: ' + e.message);
    };

    return () => worker.terminate();
  }, []);

  // Fetch a URL via the CORS proxy and return a Uint8Array.
  async function fetchBinary(url, label) {
    const proxied  = PROXY + '?url=' + encodeURIComponent(url);
    const response = await fetch(proxied);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${label}`);

    const total  = parseInt(response.headers.get('content-length') || '0', 10);
    const reader = response.body.getReader();
    const chunks = [];
    let loaded   = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      if (total) setProgress({ loaded, total });
    }

    // Combine chunks into a single Uint8Array
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  function triggerDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl; a.download = filename; a.click(); a.remove();
    URL.revokeObjectURL(blobUrl);
  }

  const MIME = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    flv: 'video/x-flv', avi: 'video/x-msvideo', mov: 'video/quicktime',
    '3gp': 'video/3gpp', ogv: 'video/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
    opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac',
  };

  // ffmpeg args per audio output format
  const AUDIO_CODECS = {
    mp3:  ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'],
    aac:  ['-vn', '-c:a', 'aac', '-b:a', '192k'],
    wav:  ['-vn', '-c:a', 'pcm_s16le'],
    flac: ['-vn', '-c:a', 'flac'],
    opus: ['-vn', '-c:a', 'libopus', '-b:a', '128k'],
  };

  // Containers that accept H264+AAC with -c copy (no re-encode needed)
  const COPY_SAFE = new Set(['mp4', 'mkv', 'mov', 'avi', 'flv', '3gp', 'm4v']);

  function toError(err) {
    if (err instanceof Error) return err;
    if (typeof err === 'string') return new Error(err);
    try { return new Error(JSON.stringify(err)); } catch { return new Error(String(err)); }
  }

  async function ffExec(ff, args) {
    const code = await ff.exec(args);
    if (code !== 0) throw new Error(`ffmpeg error (exit ${code}) — ${args.join(' ')}`);
  }

  async function streamDownload({ streamUrl, audioUrl, needsMerge, title, ext, audioExt = 'm4a', requestedFormat }) {
    try {
      const filename = sanitizeFilename(title);
      const outFmt   = requestedFormat || ext;
      const isAudio  = outFmt in AUDIO_CODECS;

      console.log('[streamDownload] requestedFormat:', requestedFormat, '| ext:', ext, '| audioExt:', audioExt, '| outFmt:', outFmt, '| needsMerge:', needsMerge);

      if (isAudio) {
        // ── Audio transcode: mp3 / aac / wav / flac / opus ────────────────────
        // Use audioUrl if available (cleaner audio stream), else streamUrl
        const srcUrl = (audioUrl && needsMerge) ? audioUrl : streamUrl;
        const srcExt = (audioUrl && needsMerge) ? audioExt : ext;
        setMsg('Downloading audio stream...');
        const audioData = await fetchBinary(srcUrl, 'audio');

        const ff = await loadFFmpegOnce(setMsg);
        ff.off('progress');
        ff.on('progress', ({ progress: p }) =>
          setMsg(`Converting → ${outFmt.toUpperCase()}... ${Math.round((p || 0) * 100)}%`));

        await ff.writeFile(`input.${srcExt}`, audioData);
        await ffExec(ff, ['-i', `input.${srcExt}`, ...AUDIO_CODECS[outFmt], `output.${outFmt}`]);

        const out = await ff.readFile(`output.${outFmt}`);
        triggerDownload(
          new Blob([out.buffer], { type: MIME[outFmt] || 'audio/mpeg' }),
          `${filename}.${outFmt}`,
        );

      } else if (needsMerge && audioUrl) {
        // ── HD video: merge separate video + audio streams ────────────────────
        setMsg('Downloading video stream...');
        const videoData = await fetchBinary(streamUrl, 'video');
        setMsg('Downloading audio stream...');
        setProgress(null);
        const audioData = await fetchBinary(audioUrl, 'audio');

        const ff = await loadFFmpegOnce(setMsg);
        ff.off('progress');
        ff.on('progress', ({ progress: p }) =>
          setMsg(`Merging → ${outFmt.toUpperCase()}... ${Math.round((p || 0) * 100)}%`));

        await ff.writeFile(`video.${ext}`,      videoData);
        await ff.writeFile(`audio.${audioExt}`, audioData);

        // mkv accepts any codec with -c copy; other containers may need it too.
        // Use mkv as intermediate if outFmt isn't copy-safe, then remux.
        const mergeExt = COPY_SAFE.has(outFmt) ? outFmt : 'mkv';
        await ffExec(ff, [
          '-i', `video.${ext}`,
          '-i', `audio.${audioExt}`,
          '-c', 'copy',
          `merged.${mergeExt}`,
        ]);

        let finalData;
        if (mergeExt === outFmt) {
          finalData = await ff.readFile(`merged.${mergeExt}`);
        } else {
          // Remux mkv → target container
          await ffExec(ff, ['-i', `merged.${mergeExt}`, '-c', 'copy', `output.${outFmt}`]);
          finalData = await ff.readFile(`output.${outFmt}`);
        }

        triggerDownload(
          new Blob([finalData.buffer], { type: MIME[outFmt] || 'video/mp4' }),
          `${filename}.${outFmt}`,
        );

      } else {
        // ── Direct download (single pre-merged stream) ────────────────────────
        setMsg('Downloading...');
        const data = await fetchBinary(streamUrl, 'media');

        // If the stream's container already matches what was requested, save directly.
        // Otherwise remux through ffmpeg (e.g. download came as webm, user wants mkv).
        if (ext === outFmt || outFmt === 'm4a') {
          triggerDownload(
            new Blob([data], { type: MIME[outFmt] || 'application/octet-stream' }),
            `${filename}.${outFmt}`,
          );
        } else {
          setMsg(`Converting → ${outFmt.toUpperCase()}...`);
          const ff = await loadFFmpegOnce(setMsg);
          ff.off('progress');
          await ff.writeFile(`input.${ext}`, data);
          await ffExec(ff, ['-i', `input.${ext}`, '-c', 'copy', `output.${outFmt}`]);
          const out = await ff.readFile(`output.${outFmt}`);
          triggerDownload(
            new Blob([out.buffer], { type: MIME[outFmt] || 'application/octet-stream' }),
            `${filename}.${outFmt}`,
          );
        }
      }

      setResult({ title, ext: outFmt });
      setPhase(STATUS.READY);
      setMsg('');
      setProgress(null);
    } catch (rawErr) {
      const err = toError(rawErr);
      setPhase(STATUS.ERROR);
      setMsg('Download failed: ' + err.message);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (phase !== STATUS.READY || !url.trim()) return;
    setResult(null);
    setPhase(STATUS.EXTRACTING);
    setMsg('Fetching video info...');
    workerRef.current.postMessage({ type: 'extract', url: url.trim(), format });
  }

  function handleRetry() {
    setPhase(STATUS.READY);
    setMsg('');
  }

  const busy = phase === STATUS.BOOTING || phase === STATUS.EXTRACTING || phase === STATUS.DOWNLOADING;

  return (
    <main>
      {/* ── Status banner ── */}
      {(phase === STATUS.BOOTING || busy) && (
        <div style={styles.statusBar}>
          <Spinner />
          <span style={{ marginLeft: '0.6rem' }}>{msg}</span>
          {progress && (
            <span style={{ marginLeft: '0.6rem', fontSize: '0.9rem', color: '#8B7D6B' }}>
              {formatBytes(progress.loaded)}
              {progress.total ? ` / ${formatBytes(progress.total)}` : ''}
            </span>
          )}
        </div>
      )}

      {phase === STATUS.ERROR && (
        <div style={styles.errorBar}>
          <strong>Error:</strong> {msg}
          <button onClick={handleRetry} style={styles.retryBtn}>Try again</button>
        </div>
      )}

      {result && phase === STATUS.READY && (
        <div style={styles.successBar}>
          Downloaded: <strong>{result.title}.{result.ext}</strong>
          {result.filesize ? ` (${formatBytes(result.filesize)})` : ''}
        </div>
      )}

      {/* ── Form ── */}
      <form onSubmit={handleSubmit} style={{ marginTop: '1.5rem' }}>
        <label style={{ fontSize: '1.15rem', lineHeight: 2 }}>
          I want to download{' '}
          <input
            type="text"
            placeholder="Paste any video URL..."
            value={url}
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            style={styles.input}
          />
          {' '}in{' '}
          <select
            value={format}
            disabled={busy}
            onChange={(e) => setFormat(e.target.value)}
            style={styles.select}
          >
            {FORMATS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          {' '}format.
        </label>

        <br /><br />

        <button
          type="submit"
          disabled={busy || phase === STATUS.BOOTING || !url.trim()}
          style={{
            ...styles.btn,
            backgroundColor: busy ? '#1A2438' : '#C8922A',
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          {phase === STATUS.EXTRACTING
            ? 'Extracting...'
            : phase === STATUS.DOWNLOADING
            ? 'Downloading...'
            : 'Download'}
        </button>

        <div style={{ marginTop: '2rem' }}><BuyMeACoffee /></div>

        <p style={styles.notice}>
          Powered by yt-dlp running in your browser via WebAssembly.
          No files touch our servers — everything happens locally.
          For personal, educational, and fair-use only.
        </p>

        {phase === STATUS.BOOTING && (
          <p style={styles.hint}>
            First load takes ~30 seconds while the Python runtime downloads.
            It is cached afterwards — subsequent loads are instant.
          </p>
        )}
      </form>
    </main>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span style={{
      display: 'inline-block',
      width: '14px',
      height: '14px',
      border: '2px solid #2A3550',
      borderTopColor: '#C8922A',
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
    }} />
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

function sanitizeFilename(name) {
  return (name || 'download').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200);
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = {
  input: {
    width: '320px',
    padding: '0.4rem 0.6rem',
    fontSize: '1rem',
    margin: '0 0.4rem',
    borderRadius: '6px',
    border: '1px solid #2A3550',
    backgroundColor: '#1A2438',
    color: '#E8DFCC',
    fontFamily: 'inherit',
  },
  select: {
    padding: '0.4rem 0.6rem',
    fontSize: '1rem',
    borderRadius: '6px',
    border: '1px solid #2A3550',
    marginLeft: '0.4rem',
    backgroundColor: '#1A2438',
    color: '#E8DFCC',
    fontFamily: 'inherit',
  },
  btn: {
    padding: '0.6rem 1.4rem',
    fontSize: '1rem',
    borderRadius: '6px',
    border: '1px solid #C8922A',
    color: '#0A0C14',
    fontWeight: 'bold',
    fontFamily: 'inherit',
    transition: 'background-color 0.2s, border-color 0.2s',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    padding: '0.7rem 1rem',
    backgroundColor: '#1A2D4D',
    border: '1px solid #2A3550',
    borderRadius: '8px',
    fontSize: '0.95rem',
    color: '#C8D8FF',
  },
  errorBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.8rem',
    padding: '0.7rem 1rem',
    backgroundColor: '#7A1A1A',
    border: '1px solid #5A1010',
    borderRadius: '8px',
    fontSize: '0.95rem',
    color: '#FFD5D5',
  },
  successBar: {
    padding: '0.7rem 1rem',
    backgroundColor: '#1A4D2E',
    border: '1px solid #2A6B40',
    borderRadius: '8px',
    fontSize: '0.95rem',
    color: '#C8FFDC',
  },
  retryBtn: {
    padding: '0.3rem 0.8rem',
    borderRadius: '4px',
    border: '1px solid #FFD5D5',
    background: 'none',
    color: '#FFD5D5',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontFamily: 'inherit',
  },
  notice: {
    marginTop: '1.5rem',
    fontSize: '0.9rem',
    color: '#8B7D6B',
    lineHeight: 1.5,
  },
  hint: {
    fontSize: '0.85rem',
    color: '#8B7D6B',
    fontStyle: 'italic',
    marginTop: '0.5rem',
  },
};
