import type { Metadata, Viewport } from 'next';
import './globals.css';
import './site-templates.css';

export const metadata: Metadata = {
  title: 'Avzar',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any', type: 'image/x-icon' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
  },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#C2410C' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
