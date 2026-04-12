'use client';

import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { Img } from './_components/img';
import { motion, AnimatePresence, useInView, useScroll, useTransform } from 'framer-motion';
import {
  Copy,
  Check,
  ArrowDown,
  Package,
  Layers,
  Cpu,
  Terminal,
  Smartphone,
  Zap,
} from 'lucide-react';

/* ═══ spring configs ═══ */
const snappy = { type: 'spring' as const, stiffness: 300, damping: 30 };
const gentle = { type: 'spring' as const, stiffness: 100, damping: 20 };

/* ═══ shared variants ═══ */
const blurUp = {
  hidden: { opacity: 0, y: 30, filter: 'blur(8px)' },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { delay: i * 0.1, duration: 0.6, ease: 'easeOut' as const },
  }),
};

const slideLeft = {
  hidden: { opacity: 0, x: -40 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { delay: i * 0.12, ...gentle },
  }),
};

const scaleIn = {
  hidden: { opacity: 0, scale: 0.92 },
  visible: (i: number) => ({
    opacity: 1,
    scale: 1,
    transition: { delay: i * 0.1, ...snappy },
  }),
};

/* ═══ tiny components ═══ */

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 2000);
      }}
      className="p-1.5 rounded hover:bg-white/10 transition-colors"
      aria-label="Copy"
    >
      <AnimatePresence mode="wait">
        {ok ? (
          <motion.div
            key="y"
            initial={{ scale: 0, rotate: -90 }}
            animate={{ scale: 1, rotate: 0 }}
            exit={{ scale: 0 }}
            transition={{ ...snappy }}
          >
            <Check className="w-3.5 h-3.5 text-accent" />
          </motion.div>
        ) : (
          <motion.div
            key="n"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={{ duration: 0.1 }}
          >
            <Copy className="w-3.5 h-3.5 text-text-dim" />
          </motion.div>
        )}
      </AnimatePresence>
    </button>
  );
}

function Tag({ children }: { children: string }) {
  return (
    <span className="inline-block font-mono text-[10px] tracking-[0.25em] uppercase text-accent/70 border border-accent/20 px-3 py-1 rounded-sm bg-accent/[0.04]">
      [{children}]
    </span>
  );
}

function useAnimateInView(amount = 0.3) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, amount });
  return { ref, inView };
}

/* ═══════════════════════════════════════════════════════════════ */
/*  NAVBAR                                                       */
/* ═══════════════════════════════════════════════════════════════ */

function Navbar() {
  const links = [
    { label: 'Compare', href: '#compare' },
    { label: 'Frameworks', href: '#frameworks' },
    { label: 'Setup', href: '#setup' },
    { label: 'Docs', href: '/docs' },
  ];

  return (
    <motion.nav
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
      className="fixed top-0 inset-x-0 z-50 backdrop-blur-md bg-bg/60 border-b border-border/30"
    >
      <div className="max-w-7xl mx-auto px-6 md:px-12 h-14 flex items-center justify-between">
        {/* logo */}
        <a
          href="#"
          className="font-mono text-[13px] tracking-[0.2em] uppercase text-fg/80 hover:text-accent transition-colors"
        >
          agentest
        </a>

        {/* center links */}
        <div className="hidden md:flex items-center gap-8">
          {links.map((l) => {
            const isInternal = l.href.startsWith('/');
            const cls =
              'font-mono text-[11px] tracking-[0.2em] uppercase text-text-muted hover:text-accent transition-colors';
            return isInternal ? (
              <Link key={l.label} href={l.href} className={cls}>
                {l.label}
              </Link>
            ) : (
              <a
                key={l.label}
                href={l.href}
                target={l.href.startsWith('http') ? '_blank' : undefined}
                rel={l.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                className={cls}
              >
                {l.label}
              </a>
            );
          })}
        </div>

        {/* right CTA */}
        <a
          href="https://github.com/arjun-vegeta/agenTest"
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[10px] tracking-[0.18em] uppercase border border-accent/30 px-3 py-1.5 text-accent/80 hover:bg-accent/10 hover:text-accent transition-all rounded-sm"
        >
          [GITHUB]
        </a>
      </div>
    </motion.nav>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  HERO                                                         */
/* ═══════════════════════════════════════════════════════════════ */

type TermLine = {
  text: string;
  cls: string;
  delay?: number; // ms before this line appears (overrides default)
};

const TERMINAL_SCRIPT: TermLine[] = [
  // 1. User prompt
  { text: '> Test the login flow end to end.', cls: 'text-fg', delay: 400 },

  // 2. Connect — tool invocation + metadata + compact tree
  {
    text: '→ [mcp] agentest_connect { packageName: "com.example.myapp" }',
    cls: 'text-accent/70 mt-3',
    delay: 800,
  },
  { text: '  deviceId:        emulator-5554', cls: 'text-fg/55 mt-1', delay: 200 },
  { text: '  backend:         grpc', cls: 'text-fg/55', delay: 180 },
  { text: '  framework:       react_native', cls: 'text-fg/55', delay: 180 },
  { text: '  helperInstalled: true', cls: 'text-fg/55', delay: 180 },
  { text: '  frameworkSync:   ["hermes"]', cls: 'text-fg/55', delay: 200 },

  { text: 'screen 1080x1920 com.example.myapp #a1b2c3', cls: 'text-fg/60 mt-2', delay: 350 },
  { text: '  "Welcome"', cls: 'text-fg/50', delay: 180 },
  { text: '  @f1 input "Email"', cls: 'text-fg/50', delay: 180 },
  { text: '  @f2 input password', cls: 'text-fg/50', delay: 180 },
  { text: '  @c1 check "Remember me"', cls: 'text-fg/50', delay: 180 },
  { text: '  @b1 btn "Sign in"', cls: 'text-fg/50', delay: 180 },
  { text: '  @l1 link "Forgot Password?"', cls: 'text-fg/50', delay: 180 },

  // 3. Run flow — type email, password, tap sign in
  { text: '→ [mcp] agentest_run_flow', cls: 'text-accent/70 mt-3', delay: 900 },
  { text: '  [ type   @f1 "user@example.com",', cls: 'text-accent/60', delay: 250 },
  { text: '    type   @f2 "testpass#123",', cls: 'text-accent/60', delay: 250 },
  { text: '    tap    @b1 ]', cls: 'text-accent/60', delay: 250 },
  { text: '  3/3 passed  screenChanged: true  #d2e8f4', cls: 'text-accent/70 mt-1', delay: 600 },

  // 4. Get fresh tree — dashboard
  { text: '→ [mcp] agentest_get_ui_tree', cls: 'text-accent/70 mt-3', delay: 800 },
  { text: 'screen 1080x1920 com.example.myapp #d2e8f4', cls: 'text-fg/60 mt-1', delay: 350 },
  { text: '  "Welcome back"', cls: 'text-fg/50', delay: 180 },
  { text: '  @s1 scroll "Recent activity"', cls: 'text-fg/50', delay: 180 },
  { text: '  @b1 btn "Profile"', cls: 'text-fg/50', delay: 180 },
  { text: '  @b2 btn "Settings"', cls: 'text-fg/50', delay: 180 },

  // 5. AI: navigate to settings
  { text: '> Open settings and log out.', cls: 'text-fg mt-4', delay: 1100 },

  { text: '→ [mcp] agentest_run_flow', cls: 'text-accent/70 mt-2', delay: 700 },
  { text: '  [ tap @b2 ]', cls: 'text-accent/60', delay: 250 },
  { text: '  1/1 passed  screenChanged: true  #e9d4c1', cls: 'text-accent/70 mt-1', delay: 500 },

  { text: 'screen 1080x1920 com.example.myapp #e9d4c1', cls: 'text-fg/60 mt-2', delay: 350 },
  { text: '  "Settings"', cls: 'text-fg/50', delay: 180 },
  { text: '  @b1 btn "Account"', cls: 'text-fg/50', delay: 180 },
  { text: '  @b2 btn "Notifications"', cls: 'text-fg/50', delay: 180 },
  { text: '  @b3 btn "Log out"', cls: 'text-fg/50', delay: 180 },

  // 6. Log out + assert back at login
  { text: '→ [mcp] agentest_run_flow', cls: 'text-accent/70 mt-3', delay: 800 },
  { text: '  [ tap            @b3,', cls: 'text-accent/60', delay: 250 },
  { text: '    assert_visible { text: "Sign in" } ]', cls: 'text-accent/60', delay: 250 },
  { text: '  2/2 passed  screenChanged: true', cls: 'text-accent/70 mt-1', delay: 500 },

  // 7. AI summary
  { text: '> Login flow confirmed using AgenTest ✓', cls: 'text-fg mt-4', delay: 1200 },
];

const AGENTS = ['claude', 'codex', 'cursor', 'replit', 'antigravity'];

function AnimatedTerminal() {
  const [count, setCount] = useState(0);
  const [agentIdx, setAgentIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (count >= TERMINAL_SCRIPT.length) {
      // Loop after pause
      const restart = setTimeout(() => setCount(0), 5500);
      return () => clearTimeout(restart);
    }
    const base = TERMINAL_SCRIPT[count]?.delay ?? 250;
    const delay = Math.round(base * 1.2);
    const t = setTimeout(() => setCount((c) => c + 1), delay);
    return () => clearTimeout(t);
  }, [count]);

  // Flip agent name every 2.2s
  useEffect(() => {
    const t = setInterval(() => {
      setAgentIdx((i) => (i + 1) % AGENTS.length);
    }, 2200);
    return () => clearInterval(t);
  }, []);

  // Auto-scroll to bottom on new line
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [count]);

  const visible = TERMINAL_SCRIPT.slice(0, count);

  return (
    <div className="glass rounded-md overflow-hidden relative">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40">
        <div className="flex gap-1.5">
          {[0.4, 0.25, 0.15].map((o, i) => (
            <motion.div
              key={i}
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: `rgba(16,185,129,${o})` }}
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 2, repeat: Infinity, delay: i * 0.3 }}
            />
          ))}
        </div>
        <span className="ml-2 font-mono text-[9px] tracking-[0.25em] uppercase text-text-muted flex items-baseline gap-1.5">
          your ai agent —
          <AnimatePresence mode="wait">
            <motion.span
              key={AGENTS[agentIdx]}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="text-accent/80 inline-block"
            >
              {AGENTS[agentIdx]}
            </motion.span>
          </AnimatePresence>
        </span>
      </div>

      <div
        ref={scrollRef}
        className="p-5 font-mono text-[12px] leading-[2.1] h-[340px] overflow-y-auto bg-black/40 relative scroll-smooth"
        style={{ scrollbarWidth: 'none' }}
      >
        <style>{`.terminal-scroll::-webkit-scrollbar { display: none; }`}</style>
        {visible.map((line, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className={line.cls}
          >
            {line.text || '\u00A0'}
          </motion.div>
        ))}
        {count < TERMINAL_SCRIPT.length && (
          <motion.span
            className="inline-block w-[7px] h-[14px] bg-accent/80 align-middle ml-0.5"
            animate={{ opacity: [1, 0] }}
            transition={{ duration: 0.8, repeat: Infinity, repeatType: 'reverse' }}
          />
        )}
      </div>
    </div>
  );
}

function Hero() {
  const containerRef = useRef(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end start'],
  });
  const terminalY = useTransform(scrollYProgress, [0, 1], [0, 80]);

  return (
    <section
      ref={containerRef}
      className="relative flex items-center px-6 md:px-12 overflow-hidden"
    >
      {/* glow */}
      <div className="absolute top-1/3 left-1/4 w-[600px] h-[600px] bg-accent/6 rounded-full blur-[180px] -z-10" />
      <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-accent/4 rounded-full blur-[140px] -z-10" />

      <div className="relative z-10 max-w-7xl mx-auto w-full grid lg:grid-cols-[1fr_1.1fr] gap-16 items-center pt-36 pb-24">
        {/* left */}
        <div>
          <motion.div custom={0} variants={blurUp} initial="hidden" animate="visible">
            <Tag>MCP_PROTOCOL</Tag>
          </motion.div>

          <motion.h1
            custom={1}
            variants={blurUp}
            initial="hidden"
            animate="visible"
            className="mt-7 text-4xl md:text-5xl lg:text-[3.5rem] font-light tracking-[0.02em] leading-[1.15]"
          >
            Test any app. <br className="hidden md:block" />
            <span className="text-accent">No test code.</span>
          </motion.h1>

          <motion.p
            custom={2}
            variants={blurUp}
            initial="hidden"
            animate="visible"
            className="mt-5 text-text-dim text-[15px] leading-relaxed max-w-md tracking-[0.04em] font-light"
          >
            An MCP server that gives any AI coding agent the ability to test Android apps against a
            real emulator.
          </motion.p>

          {/* status */}
          <motion.div
            custom={3}
            variants={blurUp}
            initial="hidden"
            animate="visible"
            className="mt-6 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-text-muted tracking-[0.2em]"
          >
            {['> zero_setup', '> zero_testIDs', '> zero_boilerplate'].map((s) => (
              <span key={s}>{s}</span>
            ))}
          </motion.div>

          {/* install */}
          <motion.div
            custom={4}
            variants={blurUp}
            initial="hidden"
            animate="visible"
            className="mt-8"
          >
            <motion.div
              whileHover={{ scale: 1.02, borderColor: 'rgba(16,185,129,0.3)' }}
              transition={snappy}
              className="inline-flex items-center gap-3 bg-white/[0.02] border border-border px-5 py-3 rounded-sm font-mono text-sm text-fg/70 tracking-[0.04em]"
            >
              <span className="text-accent">$</span>
              npm install -g agentest
              <CopyBtn text="npm install -g agentest" />
            </motion.div>
          </motion.div>

          {/* agents */}
          <motion.div
            custom={5}
            variants={blurUp}
            initial="hidden"
            animate="visible"
            className="mt-7 flex flex-wrap gap-2"
          >
            {['Claude Code', 'Cursor', 'Copilot', 'Codex'].map((a, i) => (
              <motion.span
                key={a}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.8 + i * 0.08, ...snappy }}
                whileHover={{
                  borderColor: 'rgba(16,185,129,0.25)',
                  color: 'rgba(228,228,231,0.8)',
                }}
                className="font-mono text-[10px] tracking-[0.18em] uppercase text-text-muted border border-border/50 px-3 py-1.5 rounded-sm cursor-default transition-colors"
              >
                {a}
              </motion.span>
            ))}
          </motion.div>
        </div>

        {/* right: terminal */}
        <motion.div
          style={{ y: terminalY }}
          initial={{ opacity: 0, x: 60, rotateY: -5 }}
          animate={{ opacity: 1, x: 0, rotateY: 0 }}
          transition={{
            duration: 1,
            delay: 0.3,
            ease: [0.22, 1, 0.36, 1] as unknown as [number, number, number, number],
          }}
        >
          <AnimatedTerminal />
        </motion.div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  COMPARISON                                                   */
/* ═══════════════════════════════════════════════════════════════ */

function Comparison() {
  const { ref, inView } = useAnimateInView(0.2);

  const tools = [
    {
      name: 'AgenTest',
      hi: true,
      lines: [
        'Natural language → AI executes tests',
        'Minimal setup, no test code',
        'Adapts to UI changes (AI-driven)',
        '~150–400ms / action',
      ],
    },
    {
      name: 'Appium',
      hi: false,
      lines: [
        'Code-based (Java/Python, WebDriver)',
        'Significant setup required',
        'Stable with good selectors, but can break on UI changes',
        '~1–3s / action',
      ],
    },
    {
      name: 'Maestro',
      hi: false,
      lines: [
        'YAML-based test flows (CLI)',
        'Lightweight setup',
        'More resilient, but not adaptive',
        '~400ms–1s / action',
      ],
    },
  ];

  return (
    <>
      <section ref={ref} id="compare" className="py-16 md:py-24 scroll-mt-16">
        <div className="px-6 md:px-12">
          <div className="max-w-7xl mx-auto">
            <motion.div
              custom={0}
              variants={blurUp}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
            >
              <Tag>COMPARISON</Tag>
            </motion.div>

            <motion.h2
              custom={1}
              variants={blurUp}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
              className="mt-5 md:mt-7 text-2xl md:text-4xl lg:text-5xl font-light tracking-[0.02em] leading-snug"
            >
              Not a test framework. <span className="text-accent">An execution layer.</span>
            </motion.h2>
            <motion.p
              custom={2}
              variants={blurUp}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
              className="mt-3 md:mt-4 text-text-dim text-[13px] leading-relaxed tracking-[0.04em]"
            >
              Appium and Maestro are great for QA teams. AgenTest is for developers shipping fast —
              especially apps built with code-gen tools.
            </motion.p>
          </div>
        </div>

        {/* full-width comparison columns */}
        <div className="mt-16 px-6 md:px-12">
          <div className="max-w-7xl mx-auto grid md:grid-cols-3 divide-x divide-border/30">
            {tools.map((t, i) => (
              <motion.div
                key={t.name}
                custom={i}
                variants={slideLeft}
                initial="hidden"
                animate={inView ? 'visible' : 'hidden'}
                className={`py-4 md:py-6 ${i === 0 ? 'md:pl-0 md:pr-6' : i === tools.length - 1 ? 'md:pl-6 md:pr-0' : 'md:px-6'} ${t.hi ? '' : 'opacity-50'}`}
              >
                <h3
                  className={`font-mono text-[11px] tracking-[0.25em] uppercase mb-4 md:mb-8 ${t.hi ? 'text-accent' : 'text-text-muted'}`}
                >
                  {t.name}
                </h3>
                <ul className="space-y-2 md:space-y-4">
                  {t.lines.map((l, j) => (
                    <li
                      key={j}
                      className="flex gap-2.5 md:gap-3 text-[13px] md:text-[14px] text-text-dim leading-snug md:leading-relaxed tracking-[0.04em] font-light"
                    >
                      {t.hi ? (
                        <span className="text-accent shrink-0 mt-0.5">&#10003;</span>
                      ) : (
                        <span className="w-1 h-1 rounded-full bg-text-muted mt-2.5 shrink-0" />
                      )}
                      {l}
                    </li>
                  ))}
                </ul>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  ZERO testID                                                  */
/* ═══════════════════════════════════════════════════════════════ */

function ZeroTestId() {
  const { ref, inView } = useAnimateInView(0.3);

  return (
    <>
      <section ref={ref} className="px-6 md:px-12 py-16 md:py-24 relative overflow-hidden">
        <div className="absolute right-0 top-0 w-1/3 h-full bg-gradient-to-l from-accent/[0.02] to-transparent -z-10" />
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-[1fr_1.3fr] gap-8 lg:gap-12 items-center">
            <div>
              <motion.div
                custom={0}
                variants={slideLeft}
                initial="hidden"
                animate={inView ? 'visible' : 'hidden'}
              >
                <Tag>FIBER_EXTRACTION</Tag>
              </motion.div>
              <motion.h2
                custom={1}
                variants={slideLeft}
                initial="hidden"
                animate={inView ? 'visible' : 'hidden'}
                className="mt-5 md:mt-7 text-2xl md:text-4xl lg:text-5xl font-light tracking-[0.02em] leading-snug"
              >
                Zero testIDs.
                <br />
                <span className="text-accent">Every button named.</span>
              </motion.h2>
              <motion.p
                custom={2}
                variants={slideLeft}
                initial="hidden"
                animate={inView ? 'visible' : 'hidden'}
                className="mt-3 md:mt-4 text-text-dim text-[13px] leading-relaxed max-w-sm tracking-[0.04em]"
              >
                Built with Cursor, Bolt, or v0? AgenTest extracts React component names from the
                Hermes runtime. Icon buttons just work.
              </motion.p>
            </div>

            {/* before / after side by side */}
            <div className="grid grid-cols-2 gap-3 md:gap-4">
              <motion.div
                custom={1}
                variants={scaleIn}
                initial="hidden"
                animate={inView ? 'visible' : 'hidden'}
                className="glass border-border/20 rounded-sm p-3 md:p-5 opacity-40"
              >
                <div className="font-mono text-[9px] tracking-[0.2em] uppercase text-text-muted mb-2 md:mb-3">
                  standard a11y
                </div>
                <pre className="font-mono text-[11px] md:text-[12px] leading-[2] md:leading-[2.4] text-text-muted">{`@b1 btn\n@b2 btn\n@b3 btn`}</pre>
              </motion.div>

              <motion.div
                custom={2}
                variants={scaleIn}
                initial="hidden"
                animate={inView ? 'visible' : 'hidden'}
                whileHover={{ scale: 1.02, boxShadow: '0 12px 40px rgba(16,185,129,0.12)' }}
                transition={snappy}
                className="glass border-accent/20 rounded-sm p-3 md:p-5 bg-accent/[0.02] shadow-xl shadow-accent/5"
              >
                <div className="font-mono text-[9px] tracking-[0.2em] uppercase text-accent mb-2 md:mb-3">
                  agentest + fiber
                </div>
                <pre className="font-mono text-[11px] md:text-[12px] leading-[2] md:leading-[2.4] text-fg/60">
                  {`@b1 btn `}
                  <span className="text-accent bg-accent/10 px-1.5 rounded-sm">
                    &quot;Phone&quot;
                  </span>
                  {`\n@b2 btn `}
                  <span className="text-accent bg-accent/10 px-1.5 rounded-sm">
                    &quot;Settings&quot;
                  </span>
                  {`\n@b3 btn `}
                  <span className="text-accent bg-accent/10 px-1.5 rounded-sm">
                    &quot;Microphone&quot;
                  </span>
                </pre>
              </motion.div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  TOOL INTEGRATIONS                                            */
/* ═══════════════════════════════════════════════════════════════ */

function Setup() {
  const { ref, inView } = useAnimateInView(0.15);

  const agents = [
    { name: 'Claude Code', logo: '/svgs/claude-color.svg' },
    { name: 'Cursor', logo: '/svgs/cursor.svg' },
    { name: 'Codex', logo: '/svgs/codex-color.svg' },
    { name: 'Replit', logo: '/svgs/replit-color.svg' },
    { name: 'Copilot', logo: '/svgs/githubcopilot.svg' },
    { name: 'Antigravity', logo: '/svgs/antigravity-color.svg' },
    { name: 'Qoder', logo: '/svgs/qoder-color.svg' },
  ];

  return (
    <section ref={ref} id="setup" className="px-6 md:px-12 py-16 md:py-24 scroll-mt-16">
      <div className="max-w-7xl mx-auto">
        {/* top row: heading left, description + button right */}
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-start">
          <div>
            <motion.div
              custom={0}
              variants={blurUp}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
            >
              <Tag>TOOL_INTEGRATIONS</Tag>
            </motion.div>
            <motion.h2
              custom={1}
              variants={blurUp}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
              className="mt-7 text-3xl md:text-4xl lg:text-5xl font-light tracking-[0.02em] leading-snug"
            >
              Connects to the
              <br />
              tools you <span className="text-accent">already use.</span>
            </motion.h2>
          </div>

          <div className="lg:pt-14">
            <motion.p
              custom={2}
              variants={blurUp}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
              className="text-text-dim text-[14px] leading-relaxed tracking-[0.04em] max-w-md"
            >
              AgenTest works with any MCP-compatible AI coding agent. Four lines of JSON in your
              agent&apos;s config and you&apos;re running. No SDK, no plugins, no setup.
            </motion.p>
            <motion.div
              custom={3}
              variants={blurUp}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
              whileHover={{ scale: 1.03 }}
              transition={snappy}
              className="inline-block mt-8"
            >
              <Link
                href="/docs/setup"
                className="inline-block font-mono text-[11px] tracking-[0.18em] uppercase border border-accent/30 px-5 py-2.5 text-accent/80 hover:bg-accent/10 hover:text-accent transition-all rounded-sm"
              >
                [STEPS_TO_ADD_MCP]
              </Link>
            </motion.div>
          </div>
        </div>

        {/* logos marquee */}
        <motion.div
          custom={4}
          variants={blurUp}
          initial="hidden"
          animate={inView ? 'visible' : 'hidden'}
          className="mt-20 pt-12 border-t border-border/30 -mx-6 md:-mx-12 overflow-hidden"
          style={{
            maskImage: 'linear-gradient(90deg, transparent, black 10%, black 90%, transparent)',
            WebkitMaskImage:
              'linear-gradient(90deg, transparent, black 10%, black 90%, transparent)',
          }}
        >
          <div className="marquee-track">
            {[0, 1].map((dup) => (
              <div key={dup} className="flex items-center shrink-0">
                {agents.map((a) => (
                  <div
                    key={`${dup}-${a.name}`}
                    className="flex flex-col items-center gap-3 cursor-default group px-12 md:px-16 shrink-0"
                  >
                    <Img
                      src={a.logo}
                      alt={a.name}
                      className="w-10 h-10 md:w-12 md:h-12 opacity-70 group-hover:opacity-100 transition-opacity"
                      style={{
                        filter: 'brightness(0) invert(0.45)',
                        transform: a.name === 'Codex' ? 'scale(1.3)' : undefined,
                      }}
                    />
                    <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-text-muted/70 group-hover:text-fg/60 transition-colors whitespace-nowrap">
                      {a.name}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  FRAMEWORK + ARCHITECTURE (combined, dense)                   */
/* ═══════════════════════════════════════════════════════════════ */

function FrameworkArch() {
  const { ref, inView } = useAnimateInView(0.2);

  const frameworks = [
    { name: 'React Native', level: 'full', detail: 'Hermes CDP + fiber labels' },
    { name: 'Flutter', level: 'full', detail: 'Dart VM Service + semantics' },
    { name: 'Native / Compose', level: 'good', detail: 'A11y tree + text hoisting' },
    { name: 'iOS', level: 'soon', detail: 'Coming soon' },
  ];

  const backends = [
    { icon: <Zap className="w-3.5 h-3.5" />, label: 'gRPC', sub: 'emulator' },
    { icon: <Terminal className="w-3.5 h-3.5" />, label: 'ADB', sub: 'universal' },
    { icon: <Smartphone className="w-3.5 h-3.5" />, label: 'Helper', sub: 'on-device' },
  ];

  return (
    <>
      <section ref={ref} id="frameworks" className="px-6 md:px-12 py-16 md:py-24 scroll-mt-16">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-12 items-stretch">
          {/* frameworks */}
          <div className="flex flex-col">
            <motion.div
              custom={0}
              variants={slideLeft}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
            >
              <Tag>FRAMEWORKS</Tag>
            </motion.div>
            <motion.h2
              custom={1}
              variants={slideLeft}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
              className="mt-7 text-2xl font-light tracking-[0.02em]"
            >
              Native sync with your stack.
            </motion.h2>
            <div className="mt-8 flex flex-col gap-2 flex-1">
              {frameworks.map((fw, i) => (
                <motion.div
                  key={fw.name}
                  custom={i + 2}
                  variants={slideLeft}
                  initial="hidden"
                  animate={inView ? 'visible' : 'hidden'}
                  whileHover={{
                    x: 4,
                    borderColor:
                      fw.level === 'full' ? 'rgba(16,185,129,0.25)' : 'rgba(255,255,255,0.06)',
                  }}
                  transition={snappy}
                  className="flex-1 flex items-center justify-between glass border-border/20 rounded-sm px-5 py-4 cursor-default"
                >
                  <div>
                    <div className="text-[13px] text-fg/70 tracking-[0.04em]">{fw.name}</div>
                    <div className="font-mono text-[10px] text-text-muted tracking-[0.04em]r mt-0.5">
                      {fw.detail}
                    </div>
                  </div>
                  <span
                    className={`font-mono text-[9px] tracking-[0.25em] uppercase px-2 py-0.5 rounded-sm ${
                      fw.level === 'soon'
                        ? 'text-fg/80 border border-border/50 bg-white/[0.04] italic'
                        : 'text-accent/70 border border-accent/15 bg-accent/[0.04]'
                    }`}
                  >
                    {fw.level}
                  </span>
                </motion.div>
              ))}
            </div>
          </div>

          {/* architecture */}
          <div>
            <motion.div
              custom={0}
              variants={blurUp}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
            >
              <Tag>ARCHITECTURE</Tag>
            </motion.div>
            <motion.h2
              custom={1}
              variants={blurUp}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
              className="mt-7 text-2xl font-light tracking-[0.02em]"
            >
              Under the hood.
            </motion.h2>
            <motion.div
              custom={2}
              variants={scaleIn}
              initial="hidden"
              animate={inView ? 'visible' : 'hidden'}
              className="mt-8 glass rounded-sm p-6 border-border/20"
            >
              <div className="flex flex-col items-center gap-2.5 font-mono text-[11px]">
                <motion.div
                  animate={{ y: [0, -3, 0] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                  className="border border-border/40 rounded-sm px-5 py-2.5 w-full text-center"
                >
                  <Cpu className="w-3.5 h-3.5 mx-auto mb-1 text-fg/30" />
                  <div className="text-fg/50 tracking-[0.04em]r">your ai agent</div>
                </motion.div>

                <ArrowDown className="w-3.5 h-3.5 text-accent/20" />

                <motion.div
                  animate={{
                    boxShadow: [
                      '0 0 0 rgba(16,185,129,0)',
                      '0 0 15px rgba(16,185,129,0.08)',
                      '0 0 0 rgba(16,185,129,0)',
                    ],
                  }}
                  transition={{ duration: 3, repeat: Infinity }}
                  className="border border-accent/20 bg-accent/[0.03] rounded-sm px-5 py-2.5 w-full text-center"
                >
                  <Layers className="w-3.5 h-3.5 mx-auto mb-1 text-accent/50" />
                  <div className="text-accent/70 tracking-[0.04em]r">agentest mcp server</div>
                  <div className="text-[9px] text-text-muted mt-0.5 tracking-[0.04em]r">
                    trees &middot; idle &middot; fibers &middot; input
                  </div>
                </motion.div>

                <ArrowDown className="w-3.5 h-3.5 text-accent/20" />

                <div className="grid grid-cols-3 gap-2 w-full">
                  {backends.map((b, i) => (
                    <motion.div
                      key={b.label}
                      animate={{ y: [0, -2, 0] }}
                      transition={{
                        duration: 2.5,
                        repeat: Infinity,
                        delay: i * 0.4,
                        ease: 'easeInOut',
                      }}
                      whileHover={{ borderColor: 'rgba(16,185,129,0.2)' }}
                      className="border border-border/30 rounded-sm p-2.5 text-center bg-black/20 cursor-default"
                    >
                      <div className="text-text-muted mx-auto mb-1 flex justify-center">
                        {b.icon}
                      </div>
                      <div className="text-fg/40 text-[10px] tracking-[0.04em]r">{b.label}</div>
                      <div className="text-text-muted/60 text-[8px] tracking-[0.04em]r mt-0.5">
                        {b.sub}
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </section>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  FOOTER                                                       */
/* ═══════════════════════════════════════════════════════════════ */

function Footer() {
  return (
    <>
      <footer className="px-6 md:px-12 mt-12 md:mt-16">
        <div className="max-w-7xl mx-auto py-12">
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 font-mono text-[10px] tracking-[0.2em] uppercase text-text-muted/50 mb-12">
            <span>&gt; open_source (MIT)</span>
            <span>&gt; android_ready</span>
            <span>&gt; ios_coming_soon</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <div className="col-span-2 md:col-span-1">
              <div className="font-mono text-[13px] tracking-[0.18em] uppercase text-fg/60">
                agentest
              </div>
              <p className="mt-2 text-[12px] text-text-muted leading-relaxed tracking-[0.04em] max-w-xs">
                MCP server for AI-driven mobile testing.
              </p>
            </div>

            <div>
              <div className="font-mono text-[9px] tracking-[0.25em] uppercase text-text-muted/60 mb-4">
                project
              </div>
              <ul className="space-y-2.5">
                <li>
                  <a
                    href="https://github.com/arjun-vegeta/agenTest"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-text-dim hover:text-accent transition-colors flex items-center gap-2 tracking-[0.04em]"
                  >
                    <Img src="/github.svg" alt="" className="w-3 h-3" /> GitHub
                  </a>
                </li>
                <li>
                  <a
                    href="https://www.npmjs.com/package/agentest"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-text-dim hover:text-accent transition-colors flex items-center gap-2 tracking-[0.04em]"
                  >
                    <Package className="w-3 h-3" /> npm
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <div className="font-mono text-[9px] tracking-[0.25em] uppercase text-text-muted/60 mb-4">
                resources
              </div>
              <ul className="space-y-2.5">
                {[
                  { label: 'Setup', href: '/docs/setup' },
                  { label: 'Architecture', href: '/docs/architecture' },
                  { label: 'MCP Tools', href: '/docs/mcp-tools' },
                  { label: 'Type System', href: '/docs/type-system' },
                  { label: 'Examples', href: '/docs/examples' },
                ].map((d) => (
                  <li key={d.label}>
                    <Link
                      href={d.href}
                      className="text-[12px] text-text-dim hover:text-accent transition-colors tracking-[0.04em]"
                    >
                      {d.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <div className="font-mono text-[9px] tracking-[0.25em] uppercase text-text-muted/60 mb-4">
                get started
              </div>
              <motion.div
                whileHover={{ borderColor: 'rgba(16,185,129,0.25)' }}
                transition={snappy}
                className="flex items-center gap-2 border border-border/30 px-3 py-2 rounded-sm bg-black/20"
              >
                <code className="font-mono text-[10px] text-accent/60 flex-1">
                  npm i -g agentest
                </code>
                <CopyBtn text="npm install -g agentest" />
              </motion.div>
            </div>
          </div>

          <div className="mt-10 pt-6 border-t border-border/20 flex flex-col sm:flex-row justify-between items-center gap-3">
            <p className="font-mono text-[10px] tracking-[0.25em] uppercase text-fg/50">
              built for the agentic age
            </p>
            <a
              href="https://github.com/arjun-vegeta"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[10px] tracking-[0.25em] uppercase text-fg/50 hover:text-accent transition-colors"
            >
              made by arjun
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE                                                         */
/* ═══════════════════════════════════════════════════════════════ */

export default function Home() {
  return (
    <main className="min-h-screen bg-bg grain">
      <Navbar />
      <Hero />
      <Comparison />
      <ZeroTestId />
      <Setup />
      <FrameworkArch />
      <Footer />
    </main>
  );
}
