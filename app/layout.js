import './globals.css';
import NavBar from './components/NavBar';

export const metadata = {
  title: 'Ultima Downloader',
  description: 'Rip videos from all over the internet',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div style={{ padding: '2rem' }}>
          <h1 style={{ textAlign: 'center', marginBottom: '1rem' }}>Ultima Downloader</h1>
          <NavBar />
          {children}
        </div>
      </body>
    </html>
  );
}