import type { TocItem } from './toc';

/**
 * Extract h2/h3 headings from markdown content (server-safe).
 * Uses the same slugging algo as rehype-slug + github-slugger.
 */
export function extractHeadings(markdown: string): TocItem[] {
  const items: TocItem[] = [];
  const seen = new Map<string, number>();

  // Strip code blocks first so we don't pick up `## comments` inside code
  const stripped = markdown.replace(/```[\s\S]*?```/g, '');

  const lines = stripped.split('\n');
  for (const line of lines) {
    const match = /^(##)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].replace(/`([^`]+)`/g, '$1').trim();

    const baseSlug = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');

    const count = seen.get(baseSlug) ?? 0;
    seen.set(baseSlug, count + 1);
    const id = count === 0 ? baseSlug : `${baseSlug}-${count}`;

    items.push({ id, text, level });
  }

  return items;
}
