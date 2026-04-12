'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';

const NAV_SECTIONS: Array<{
  label: string;
  links: Array<{ label: string; href: string }>;
}> = [
  {
    label: 'GET_STARTED',
    links: [
      { label: 'Setup', href: '/docs/setup' },
      { label: 'Examples', href: '/docs/examples' },
    ],
  },
  {
    label: 'REFERENCE',
    links: [
      { label: 'Architecture', href: '/docs/architecture' },
      { label: 'MCP Tools', href: '/docs/mcp-tools' },
      { label: 'Type System', href: '/docs/type-system' },
    ],
  },
];

const ALL_LINKS = NAV_SECTIONS.flatMap((s) => s.links);

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed top-14 left-0 bottom-0 w-[260px] border-r border-border/40 bg-bg/60 backdrop-blur-md z-30 flex-col overflow-y-auto">
        <div className="px-8 pt-10 pb-6">
          <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-text-muted">
            [DOCUMENTATION]
          </span>
        </div>

        <nav className="px-4 pb-12 flex flex-col gap-8">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="flex flex-col gap-1">
              <div className="px-4 pb-2">
                <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-text-muted/70">
                  {section.label}
                </span>
              </div>

              {section.links.map((link) => {
                const active = pathname === link.href;
                return (
                  <motion.div
                    key={link.href}
                    whileHover={{ x: 2 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                  >
                    <Link
                      href={link.href}
                      className={[
                        'group relative block px-4 py-2 text-[13px] font-light tracking-[0.04em] transition-colors',
                        active ? 'text-accent' : 'text-fg/55 hover:text-fg',
                      ].join(' ')}
                    >
                      {active && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-px bg-accent" />
                      )}
                      {link.label}
                    </Link>
                  </motion.div>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* Mobile dropdown nav */}
      <div className="md:hidden sticky top-14 z-30 border-b border-border/40 bg-bg/80 backdrop-blur-md">
        <div className="px-6 py-3 flex items-center gap-3">
          <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-text-muted shrink-0">
            [DOCS]
          </span>
          <select
            value={pathname}
            onChange={(e) => {
              window.location.href = e.target.value;
            }}
            className="flex-1 bg-transparent border border-border/50 rounded-sm pl-3 pr-8 py-1.5 font-mono text-[11px] tracking-[0.1em] uppercase text-fg/80 focus:outline-none focus:border-accent/60 appearance-none bg-no-repeat bg-[right_0.75rem_center] bg-[length:14px_14px]"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' stroke='%2371717a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' viewBox='0 0 24 24'><polyline points='6 9 12 15 18 9'/></svg>\")",
            }}
          >
            {ALL_LINKS.map((link) => (
              <option key={link.href} value={link.href} className="bg-bg">
                {link.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </>
  );
}
