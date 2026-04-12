import type { Metadata } from 'next';
import { Host_Grotesk, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const hostGrotesk = Host_Grotesk({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['300', '400'],
});

export const metadata: Metadata = {
  title: 'AgenTest — MCP server for AI-driven mobile testing',
  description:
    'An MCP server that gives any AI coding agent the ability to test Android apps. Reads accessibility trees, injects input, syncs with React Native and Flutter.',
  openGraph: {
    title: 'AgenTest — MCP server for AI-driven mobile testing',
    description: 'An MCP server that gives any AI coding agent the ability to test Android apps.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${hostGrotesk.variable} ${jetbrainsMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col font-sans bg-bg text-fg">{children}</body>
    </html>
  );
}
