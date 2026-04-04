'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { label: 'YouTube', path: '/' },
  { label: 'Twitter / X', path: '/twitter' },
  { label: 'Instagram', path: '/instagram' },
  { label: 'TikTok', path: '/tiktok' },
  { label: 'Reddit', path: '/reddit' },
  { label: 'Facebook', path: '/facebook' },
  { label: 'Twitch', path: '/twitch' },
  { label: 'Rumble', path: '/rumble' },
  { label: 'Odysee', path: '/odysee' },
  { label: 'Kick', path: '/kick' },
  { label: 'Vimeo', path: '/vimeo' },
  { label: 'Dailymotion', path: '/dailymotion' },
  { label: 'Nebula', path: '/nebula' },
  { label: 'DLive', path: '/dlive' },
  { label: 'Tumblr', path: '/tumblr' },
  { label: 'Internet Archive', path: '/archive' },
  { label: 'Flickr', path: '/flickr' },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav style={{ marginTop: '1rem', marginBottom: '2rem' }}>
      <ul style={{
        display: 'flex',
        gap: '0.4rem',
        listStyle: 'none',
        padding: 0,
        flexWrap: 'wrap',
        justifyContent: 'center',
      }}>
        {tabs.map(({ label, path }) => {
          const active = pathname === path;
          return (
            <li key={path}>
              <Link
                href={path}
                style={{
                  textDecoration: 'none',
                  display: 'inline-block',
                  padding: '0.3rem 0.8rem',
                  borderRadius: '4px',
                  fontSize: '0.9rem',
                  fontFamily: 'inherit',
                  border: `1px solid ${active ? '#C8922A' : '#2A3550'}`,
                  backgroundColor: active ? '#C8922A' : 'transparent',
                  color: active ? '#0A0C14' : '#8B7D6B',
                  fontWeight: active ? 'bold' : 'normal',
                  transition: 'all 0.15s ease',
                }}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
