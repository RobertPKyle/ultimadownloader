'use client';

import { useState } from 'react';
import BuyMeACoffee from './components/BuyMeACoffee';

export default function HomePage() {
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState('mp4');

  const handleSubmit = async (e) => {
    e.preventDefault();

    try {
      const response = await fetch('https://cop-vii-ng-scotland.trycloudflare.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, format }),
      });

      if (!response.ok) {
        alert('Download failed');
        return;
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `video.${format}`;
      a.click();
      a.remove();
    } catch (err) {
      console.error('Error downloading:', err);
    }
  };

  const formats = [
    // Video formats
    'mp4', 'webm', 'mkv', 'flv', 'avi', 'mov', '3gp', 'ogv',
    // Audio formats
    'mp3', 'm4a', 'wav', 'aac', 'flac', 'opus', 'vorbis'
  ];

  return (
  <main>
      <form onSubmit={handleSubmit} style={{ marginTop: '1rem' }}>
        <label style={{ fontSize: '1.2rem' }}>
          I want to download{' '}
          <input
            type="text"
            placeholder="YouTube URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{
              width: '300px',
              padding: '0.4rem',
              fontSize: '1rem',
              margin: '0 0.5rem',
              borderRadius: '4px',
              border: '1px solid #ccc'
            }}
          />
          in the{' '}
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            style={{
              padding: '0.4rem',
              fontSize: '1rem',
              borderRadius: '4px',
              border: '1px solid #ccc',
              marginLeft: '0.5rem'
            }}
          >
            {formats.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </select>{' '}
          format.
        </label>

        <br /><br />

        <button
          type="submit"
          style={{
            padding: '0.6rem 1.2rem',
            fontSize: '1rem',
            borderRadius: '4px',
            border: 'none',
            backgroundColor: '#0070f3',
            color: 'white',
            cursor: 'pointer'
          }}
        >
          Download Video
        </button>
        <div style={{ marginTop: '2rem' }}>
      <BuyMeACoffee />
    </div>
     <p style={{ fontSize: '1rem', lineHeight: '1.5' }}>
            This tool is for personal, educational, and fair-use only. You are responsible for
            complying with the terms of the platforms from which you download content. We do not host
            or distribute any copyrighted material.
          </p>
      </form>
   </main>
  );
}
