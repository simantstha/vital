import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

const inter = localFont({
  src: './fonts/Inter-Variable.woff2',
  weight: '200 900',
  style: 'normal',
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = localFont({
  src: './fonts/JetBrainsMono-Variable.woff2',
  weight: '100 800',
  style: 'normal',
  variable: '--font-jetbrains',
  display: 'swap',
});

const instrumentSerif = localFont({
  src: './fonts/InstrumentSerif-Regular.woff2',
  weight: '400',
  style: 'normal',
  variable: '--font-instrument',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Vital — Personal Health Command Center',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
