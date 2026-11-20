import type { Metadata, Viewport } from 'next';
import { Lilita_One } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// The Mac app's own display face (its toasts and HUD), so the phone reads as the same village.
const display = Lilita_One({ weight: '400', subsets: ['latin'], variable: '--display' });

export const metadata: Metadata = {
  title: 'Village remote',
  description: 'Answer your builders from your phone.',
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: 'Village', statusBarStyle: 'default' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#6aa644' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={display.variable}>
      <body>{children}</body>
    </html>
  );
}
