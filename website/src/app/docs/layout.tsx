import Link from 'next/link';
import { DocsSidebar } from './_components/sidebar';
import 'highlight.js/styles/github-dark.css';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grain min-h-screen bg-bg text-fg">
      {/* Top navbar — mirrors main page navbar styling */}
      <nav className="fixed top-0 inset-x-0 z-40 backdrop-blur-md bg-bg/70 border-b border-border/40">
        <div className="px-6 md:px-8 h-14 flex items-center justify-between">
          <Link
            href="/"
            className="font-mono text-[13px] tracking-[0.2em] uppercase text-fg/80 hover:text-accent transition-colors"
          >
            agentest
          </Link>

          <div className="flex items-center gap-6">
            <Link
              href="/"
              className="hidden sm:inline font-mono text-[11px] tracking-[0.2em] uppercase text-text-muted hover:text-accent transition-colors"
            >
              Home
            </Link>
            <a
              href="https://github.com/arjun-vegeta/agenTest"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[10px] tracking-[0.18em] uppercase border border-accent/30 px-3 py-1.5 text-accent/80 hover:bg-accent/10 hover:text-accent transition-all rounded-sm"
            >
              [GITHUB]
            </a>
          </div>
        </div>
      </nav>

      <DocsSidebar />

      {/* Content */}
      <main className="md:ml-[260px] xl:mr-[240px] pt-14">
        <div className="max-w-4xl mx-auto px-6 md:px-12 lg:px-16 py-12 md:py-20">{children}</div>
      </main>
    </div>
  );
}
