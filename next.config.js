/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // Apply to all routes — needed for SharedArrayBuffer (ffmpeg.wasm)
        source: '/(.*)',
        headers: [
          // COOP: prevents cross-origin windows from sharing a browsing context group
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          // COEP credentialless: enables SharedArrayBuffer without blocking CDN resources
          // (less strict than require-corp — cross-origin fetches work as long as they
          //  have CORS headers, which jsdelivr / unpkg / googlevideo all do via proxy)
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
