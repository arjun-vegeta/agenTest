'use client';

import { useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import { Copy, Check } from 'lucide-react';
import { Img } from '../../_components/img';

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    // @ts-expect-error react element children
    return extractText(node.props?.children);
  }
  return '';
}

function CodeBlockWithCopy({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = extractText(children);

  return (
    <div className="group relative my-6">
      <pre
        className="p-5 rounded-sm bg-[#0a0a0c] border border-border/40 overflow-x-auto text-[12.5px] text-fg/80"
        style={{
          fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          lineHeight: 1.2,
          fontFeatureSettings: '"liga" 0, "calt" 0',
        }}
      >
        {children}
      </pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        aria-label="Copy code"
        className="absolute top-2.5 right-2.5 p-1.5 rounded-sm border border-border/40 bg-bg/60 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity hover:border-accent/40 hover:text-accent text-text-muted"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-accent" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

const components: Components = {
  h1: ({ children, ...props }) => (
    <h1
      {...props}
      className="mt-2 mb-8 text-3xl md:text-4xl font-light tracking-[0.01em] text-fg leading-tight scroll-mt-24"
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2
      {...props}
      className="mt-16 mb-5 pb-3 border-b border-border/40 text-xl md:text-2xl font-light tracking-[0.02em] text-fg/95 scroll-mt-24"
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3
      {...props}
      className="mt-10 mb-4 text-base md:text-lg font-light tracking-[0.02em] text-fg/90 scroll-mt-24"
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4
      {...props}
      className="mt-8 mb-3 text-[15px] font-normal tracking-[0.02em] text-fg/85 scroll-mt-24"
    >
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="my-5 text-[14.5px] leading-[2] font-light tracking-[0.01em] text-fg/70">
      {children}
    </p>
  ),
  a: ({ children, href, ...props }) => (
    <a
      {...props}
      href={href}
      target={href?.startsWith('http') ? '_blank' : undefined}
      rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
      className="text-accent hover:text-accent/80 underline decoration-accent/30 hover:decoration-accent underline-offset-[3px] transition-colors"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-5 ml-5 list-disc marker:text-text-muted space-y-1.5 text-[14.5px] font-light text-fg/70">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-5 ml-5 list-decimal marker:text-text-muted space-y-1.5 text-[14.5px] font-light text-fg/70">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-[2] pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-6 pl-5 border-l-2 border-accent/60 text-fg/60 italic font-light bg-accent/[0.02] py-2 pr-4 rounded-r-sm">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-12 border-0 h-px bg-border/50" />,
  strong: ({ children }) => <strong className="font-medium text-fg/90">{children}</strong>,
  em: ({ children }) => <em className="italic text-fg/80">{children}</em>,
  code: ({ className, children, ...props }) => {
    // Detect block vs inline:
    // Block code is wrapped in <pre>, has a `language-*` className OR contains newlines.
    // Inline code is short, single-line, no newlines.
    const text = String(children ?? '');
    const hasLanguage = !!className && /language-/.test(className);
    const hasNewline = text.includes('\n');
    const isBlock = hasLanguage || hasNewline;

    if (isBlock) {
      return (
        <code {...props} className={className}>
          {children}
        </code>
      );
    }
    return (
      <code
        {...props}
        className="font-mono text-[12px] px-[5px] py-[1px] rounded-[3px] bg-accent/10 text-accent/90 border border-accent/15 [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <CodeBlockWithCopy>{children}</CodeBlockWithCopy>,
  table: ({ children }) => (
    <div className="my-6 overflow-x-auto rounded-sm border border-border/40">
      <table className="w-full border-collapse text-[13px] font-light">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-white/[0.02] border-b border-border/40">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="px-4 py-3 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-3 border-t border-border/30 text-fg/70">{children}</td>
  ),
  img: ({ src, alt }) => (
    <Img
      src={typeof src === 'string' ? src : undefined}
      alt={alt ?? ''}
      className="my-6 rounded-sm border border-border/50 max-w-full"
    />
  ),
};

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }], rehypeSlug]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
