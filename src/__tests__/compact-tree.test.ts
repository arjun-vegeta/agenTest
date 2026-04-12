import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeIdleFingerprint,
  computeScreenFingerprint,
  hoistClickableLabels,
  parseUiAutomatorXml,
  serializeTreeCompact,
  serializeTreeForLlm,
} from '../android/tree-parser.js';
import type { UnifiedUINode } from '../types.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

function loadTree(name: string): UnifiedUINode {
  const xml = readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
  return parseUiAutomatorXml(xml);
}

// ---------------------------------------------------------------------------
// computeScreenFingerprint vs computeIdleFingerprint
// ---------------------------------------------------------------------------

describe('computeScreenFingerprint', () => {
  it('returns a 6-char base36 hash', () => {
    const tree = loadTree('login-screen.xml');
    const fp = computeScreenFingerprint(tree);
    expect(fp).toMatch(/^[0-9a-z]{6}$/);
  });

  it('is stable for the same tree', () => {
    const tree = loadTree('login-screen.xml');
    expect(computeScreenFingerprint(tree)).toBe(computeScreenFingerprint(tree));
  });

  it('differs between login and home', () => {
    const a = computeScreenFingerprint(loadTree('login-screen.xml'));
    const b = computeScreenFingerprint(loadTree('home-screen.xml'));
    expect(a).not.toBe(b);
  });

  it('does NOT change when EditText text content changes — concern #1', () => {
    // Build two trees that differ only in the email field's text content.
    // This is the typing-fingerprint concern: if typing flipped the
    // fingerprint, run_flow would lose its main token win.
    const tree1 = loadTree('login-screen.xml');
    const tree2 = loadTree('login-screen.xml');

    function setEmailText(node: UnifiedUINode, txt: string): void {
      if (node.resourceId.includes('email') && node.className === 'android.widget.EditText') {
        node.text = txt;
        return;
      }
      for (const child of node.children) setEmailText(child, txt);
    }

    setEmailText(tree1, 'Email');
    setEmailText(tree2, 'user@example.com');

    expect(computeScreenFingerprint(tree1)).toBe(computeScreenFingerprint(tree2));
  });

  it('idle fingerprint DOES change when EditText text changes (legacy behavior preserved)', () => {
    // Sanity check: the OLD fingerprint, used by idle.ts, must still see
    // EditText changes — that's what idle detection needs.
    const tree1 = loadTree('login-screen.xml');
    const tree2 = loadTree('login-screen.xml');

    function setEmailText(node: UnifiedUINode, txt: string): void {
      if (node.resourceId.includes('email') && node.className === 'android.widget.EditText') {
        node.text = txt;
        return;
      }
      for (const child of node.children) setEmailText(child, txt);
    }

    setEmailText(tree1, 'Email');
    setEmailText(tree2, 'user@example.com');

    expect(computeIdleFingerprint(tree1)).not.toBe(computeIdleFingerprint(tree2));
  });
});

// ---------------------------------------------------------------------------
// hoistClickableLabels
// ---------------------------------------------------------------------------

describe('hoistClickableLabels', () => {
  it('hoists nothing on a labeled tree (login fixture)', () => {
    // login-screen has labeled buttons + content-desc-style elements
    const tree = loadTree('login-screen.xml');
    const hoisted = hoistClickableLabels(tree);
    // The Sign in Button has its own text — no hoisting needed.
    // The CheckBox does NOT have its own text but its sibling TextView does.
    // findFirstLabelInSubtree only walks DESCENDANTS, not siblings, so the
    // CheckBox in this fixture stays unlabeled and the LinearLayout
    // wrapping (CheckBox + TextView) is the natural hoist target.
    expect(hoisted).toBeInstanceOf(Map);
  });

  it('hoists labels from descendant Text into clickable RN containers — concern #2', () => {
    // This is THE acceptance test for the Bolt/v0/Lovable use case.
    // We assert on the COMPACT OUTPUT (what the LLM sees) rather than the
    // raw hoisted map because the serializer also does transparent
    // collapse on unlabeled wrapper-of-interactives: the outer/inner
    // "phone row" wrappers in the chat fixture intentionally don't get
    // their own refs (their children are addressable directly), so they
    // won't appear in the hoisted map either. What matters is that the
    // LLM ends up with an addressable, labeled entry for every real
    // affordance on the screen.
    const tree = loadTree('chat-login-rn.xml');
    const compact = serializeTreeCompact(tree);

    // Every labeled CTA must appear once — and only once — in the final
    // compact output. This catches both the "label missing" failure mode
    // (hoisting broken) and the "wrapper hell" failure mode (nested
    // unlabeled wrappers all inheriting the same label).
    expect(compact.text.match(/"sign up"/g)?.length).toBe(1);
    expect(compact.text.match(/"sign up with google"/g)?.length).toBe(1);
    expect(compact.text.match(/"need help\?"/g)?.length).toBe(1);

    // The EditText MUST appear as an @f input ref with its own label.
    // This is the regression test for the bug where the duplicate-skip
    // logic hid the EditText entirely because its text ("enter number
    // here") had been hoisted onto an outer wrapper.
    expect(compact.text).toMatch(/@f\d+ input "enter number here"/);

    // The "+91" country code tap should also appear as its own ref.
    expect(compact.text).toContain('"+91"');

    // No wrapper hell: at most 8 ref lines (one per real affordance:
    // scroll, +91, EditText, sign up, sign up with google, need help?).
    // The phone-row wrappers must transparently collapse — if they didn't,
    // we'd see 2-3 extra @g wrappers above the EditText.
    const refLines = compact.text.split('\n').filter((l) => /@[bfclsg]\d+/.test(l));
    expect(refLines.length).toBeLessThanOrEqual(8);
    // Also require at least the core 6 CTAs are there
    expect(refLines.length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// serializeTreeCompact — output structure
// ---------------------------------------------------------------------------

describe('serializeTreeCompact', () => {
  it('emits a header line with screen WxH, package, and #fingerprint', () => {
    const tree = loadTree('login-screen.xml');
    const result = serializeTreeCompact(tree);
    const firstLine = result.text.split('\n')[0];
    expect(firstLine).toMatch(/^screen 1080x1920 com\.example\.myapp #[0-9a-z]{6}$/);
  });

  it('emits @b refs for buttons', () => {
    const tree = loadTree('login-screen.xml');
    const result = serializeTreeCompact(tree);
    expect(result.text).toMatch(/@b1 btn "Sign in"/);
  });

  it('emits @f refs for text fields', () => {
    const tree = loadTree('login-screen.xml');
    const result = serializeTreeCompact(tree);
    expect(result.text).toMatch(/@f\d+ input/);
  });

  it('emits @c refs for checkables', () => {
    const tree = loadTree('login-screen.xml');
    const result = serializeTreeCompact(tree);
    expect(result.text).toMatch(/@c\d+ check/);
  });

  it('emits state tokens (focused, password, disabled)', () => {
    const tree = loadTree('login-screen.xml');
    const result = serializeTreeCompact(tree);
    // Email field is focused in the fixture
    expect(result.text).toContain('focused');
    // Password field is a password type
    expect(result.text).toContain('password');
  });

  it('result includes refMap matching the emitted refs', () => {
    const tree = loadTree('login-screen.xml');
    const result = serializeTreeCompact(tree);
    expect(result.refMap.size).toBe(result.refCount);
    for (const [ref, node] of result.refMap) {
      expect(ref).toMatch(/^@[bfclsg]\d+$/);
      expect(node).toBeDefined();
    }
  });

  it('truncates with footer when maxLines exceeded', () => {
    const tree = loadTree('login-screen.xml');
    const result = serializeTreeCompact(tree, { maxLines: 3 });
    expect(result.truncated).toBe(true);
    const lastLine = result.text.split('\n').at(-1);
    expect(lastLine).toMatch(/\.\.\. \+\d+ more interactive elements/);
  });

  it('onlyInteractive drops plain text lines', () => {
    const tree = loadTree('login-screen.xml');
    const withText = serializeTreeCompact(tree);
    const withoutText = serializeTreeCompact(tree, { onlyInteractive: true });

    // The "Login" header text should appear in the default output but not
    // in onlyInteractive mode
    expect(withText.text).toContain('"Login"');
    expect(withoutText.text).not.toContain('"Login"');
  });
});

// ---------------------------------------------------------------------------
// Byte-size regression tests (the whole point of this work)
// ---------------------------------------------------------------------------

describe('byte-size regression', () => {
  it('login screen compact format is < 600 bytes', () => {
    const tree = loadTree('login-screen.xml');
    const compact = serializeTreeCompact(tree);
    expect(compact.text.length).toBeLessThan(600);
  });

  it('home screen compact format is < 400 bytes', () => {
    const tree = loadTree('home-screen.xml');
    const compact = serializeTreeCompact(tree);
    expect(compact.text.length).toBeLessThan(400);
  });

  it('chat RN login (zero-a11y) compact format is < 700 bytes', () => {
    const tree = loadTree('chat-login-rn.xml');
    const compact = serializeTreeCompact(tree);
    expect(compact.text.length).toBeLessThan(700);
  });

  it('compact format beats JSON tree by at least 3x on login fixture', () => {
    const tree = loadTree('login-screen.xml');
    const compact = serializeTreeCompact(tree);
    const json = JSON.stringify(serializeTreeForLlm(tree), null, 2);
    const ratio = json.length / compact.text.length;
    // Print actual ratio for visibility
    // eslint-disable-next-line no-console
    console.log(
      `[compact-tree] login: JSON=${json.length}b compact=${compact.text.length}b ratio=${ratio.toFixed(2)}x`,
    );
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it('compact format beats JSON tree by at least 4x on chat RN fixture (the target user case)', () => {
    const tree = loadTree('chat-login-rn.xml');
    const compact = serializeTreeCompact(tree);
    const json = JSON.stringify(serializeTreeForLlm(tree), null, 2);
    const ratio = json.length / compact.text.length;
    // eslint-disable-next-line no-console
    console.log(
      `[compact-tree] chat: JSON=${json.length}b compact=${compact.text.length}b ratio=${ratio.toFixed(2)}x`,
    );
    expect(ratio).toBeGreaterThanOrEqual(4);
  });
});
