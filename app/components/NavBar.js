'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { label: 'Download single Youtube Video', path: '/' },
  { label: 'Download Youtube playlist', path: '/playlist' },
  { label: 'Rip entire Youtube channel', path: '/channel' },
  { label: 'Download Tweet/X', path: '/twitter' },
  { label: 'Download Instagram video', path: '/instagram' },
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
