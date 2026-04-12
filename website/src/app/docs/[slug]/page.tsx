import { promises as fs } from 'fs';
import path from 'path';
import { notFound } from 'next/navigation';
import matter from 'gray-matter';
import type { Metadata } from 'next';
import { MarkdownRenderer } from '../_components/markdown-renderer';
import { DocsTOC } from '../_components/toc';
import { extractHeadings } from '../_components/extract-headings';

const DOC_SLUGS = ['setup', 'architecture', 'mcp-tools', 'type-system', 'examples'] as const;

type DocSlug = (typeof DOC_SLUGS)[number];

const SLUG_LABELS: Record<DocSlug, string> = {
  setup: 'Setup',
  architecture: 'Architecture',
  'mcp-tools': 'MCP Tools',
  'type-system': 'Type System',
  examples: 'Examples',
};

function isDocSlug(slug: string): slug is DocSlug {
  return (DOC_SLUGS as readonly string[]).includes(slug);
}

async function loadDoc(slug: DocSlug) {
  const filePath = path.join(process.cwd(), 'content', 'docs', `${slug}.md`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = matter(raw);
    return {
      content: parsed.content,
      data: parsed.data as { title?: string; description?: string },
    };
  } catch {
    return null;
  }
}

export function generateStaticParams() {
  return DOC_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!isDocSlug(slug)) return {};
  const doc = await loadDoc(slug);
  const label = SLUG_LABELS[slug];
  return {
    title: `${doc?.data?.title ?? label} — AgenTest Docs`,
    description: doc?.data?.description ?? `AgenTest documentation: ${label.toLowerCase()}.`,
  };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isDocSlug(slug)) {
    notFound();
  }

  const doc = await loadDoc(slug);
  if (!doc) {
    notFound();
  }

  const label = SLUG_LABELS[slug];
  const headings = extractHeadings(doc.content);

  return (
    <>
      <article>
        <div className="mb-10">
          <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent/70">
            [{label.toUpperCase().replace(/\s+/g, '_')}]
          </span>
        </div>
        <MarkdownRenderer content={doc.content} />
      </article>
      <DocsTOC items={headings} />
    </>
  );
}
