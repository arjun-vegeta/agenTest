import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="grain min-h-screen bg-bg text-fg flex items-center justify-center px-6 relative overflow-hidden">
      {/* glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-accent/5 rounded-full blur-[160px] -z-10" />

      <div className="relative z-10 max-w-xl w-full text-center">
        {/* tag */}
        <div className="inline-block font-mono text-[10px] tracking-[0.25em] uppercase text-accent/70 border border-accent/20 px-3 py-1 rounded-sm bg-accent/[0.04] mb-10">
          [ERROR_404]
        </div>

        {/* big 404 */}
        <div
          className="font-mono text-accent/30 text-[140px] md:text-[180px] leading-none tracking-[0.02em] select-none"
          style={{ fontFeatureSettings: '"liga" 0' }}
        >
          404
        </div>

        {/* heading */}
        <h1 className="mt-8 text-2xl md:text-3xl font-light tracking-[0.02em] leading-snug">
          Page not found. <span className="text-accent">Wrong endpoint.</span>
        </h1>

        <p className="mt-5 text-text-dim text-[14px] leading-relaxed tracking-[0.04em] max-w-md mx-auto">
          The path you requested doesn&apos;t exist on this server. It may have moved, or you may
          have followed a stale link.
        </p>

        {/* status lines */}
        <div className="mt-8 font-mono text-[10px] tracking-[0.2em] uppercase text-text-muted space-y-1">
          <div>&gt; status: 404</div>
          <div>&gt; resource: not_found</div>
          <div>&gt; action: redirect_required</div>
        </div>

        {/* actions */}
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Link
            href="/"
            className="font-mono text-[11px] tracking-[0.18em] uppercase border border-accent/30 px-5 py-2.5 text-accent/80 hover:bg-accent/10 hover:text-accent transition-all rounded-sm"
          >
            [HOME]
          </Link>
          <Link
            href="/docs"
            className="font-mono text-[11px] tracking-[0.18em] uppercase border border-border/50 px-5 py-2.5 text-text-dim hover:border-accent/30 hover:text-accent transition-all rounded-sm"
          >
            [DOCS]
          </Link>
        </div>
      </div>
    </main>
  );
}
