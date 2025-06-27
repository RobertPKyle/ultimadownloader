'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { label: 'Download single Youtube Video', path: '/' },
  { label: 'Download Tweet/X Video', path: '/twitter' },
  { label: 'Download Instagram video', path: '/instagram' },
  { label: 'Download TikTok video', path: '/tiktok' },
  { label: 'Download Reddit video', path: '/reddit' },
  { label: 'Download Facebook video', path: '/facebook' },
  { label: 'Download Twitch video', path: '/twitch' },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav style={{ marginTop: '1rem', marginBottom: '2rem' }}>
      <ul style={{ display: 'flex', gap: '1.5rem', listStyle: 'none', padding: 0 }}>
        {tabs.map(({ label, path }) => (
          <li key={path}>
            <Link
              href={path}
              style={{
                textDecoration: 'none',
                color: pathname === path ? '#0070f3' : '#444',
                fontWeight: pathname === path ? 'bold' : 'normal',
                borderBottom: pathname === path ? '2px solid #0070f3' : 'none',
                paddingBottom: '0.25rem'
              }}
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
