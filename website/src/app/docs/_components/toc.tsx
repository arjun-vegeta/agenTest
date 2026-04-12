'use client';

import { useEffect, useState } from 'react';

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

export function DocsTOC({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = useState<string>('');

  useEffect(() => {
    if (items.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the first heading that's currently in view
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      {
        rootMargin: '-80px 0px -70% 0px',
        threshold: 0,
      },
    );

    items.forEach((item) => {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <aside className="hidden xl:block fixed top-14 right-0 w-[240px] h-[calc(100vh-3.5rem)] overflow-y-auto py-12 pr-8 pl-6">
      <div className="font-mono text-[10px] tracking-[0.25em] uppercase text-accent/70 border border-accent/20 inline-block px-3 py-1 rounded-sm bg-accent/[0.04] mb-6">
        [ON_THIS_PAGE]
      </div>
      <nav>
        <ul className="space-y-2 border-l border-border/40">
          {items.map((item) => {
            const isActive = activeId === item.id;
            return (
              <li key={item.id} style={{ paddingLeft: `${(item.level - 2) * 12 + 16}px` }}>
                <a
                  href={`#${item.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    const el = document.getElementById(item.id);
                    if (el) {
                      const top = el.getBoundingClientRect().top + window.scrollY - 80;
                      window.scrollTo({ top, behavior: 'smooth' });
                      history.replaceState(null, '', `#${item.id}`);
                    }
                  }}
                  className={`block py-1 -ml-px border-l-2 pl-3 text-[12px] tracking-[0.02em] font-light transition-colors ${
                    isActive
                      ? 'border-accent text-accent'
                      : 'border-transparent text-text-muted hover:text-fg/70'
                  }`}
                >
                  {item.text}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
