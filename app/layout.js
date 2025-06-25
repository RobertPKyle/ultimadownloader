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
           <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
            <img 
              src="/ultimadownloaderlogo.png" 
              alt="Ultima Downloader Logo" 
              style={{ maxWidth: '300px', height: 'auto' }} 
            />
          </div>
          <NavBar />
          {children}
        </div>
      </body>
    </html>
  );
}