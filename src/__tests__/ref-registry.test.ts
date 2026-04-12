import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RefRegistry } from '../android/ref-registry.js';
import { parseUiAutomatorXml } from '../android/tree-parser.js';
import { ElementNotFoundError } from '../errors.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

function loadTree(name: string) {
  const xml = readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
  return parseUiAutomatorXml(xml);
}

describe('RefRegistry', () => {
  it('rebuild assigns refs from a fresh tree', () => {
    const registry = new RefRegistry();
    const tree = loadTree('login-screen.xml');
    const result = registry.rebuild(tree);

    expect(result.fingerprint).toMatch(/^[0-9a-z]{6}$/);
    expect(result.refCount).toBeGreaterThan(0);
    expect(registry.size).toBe(result.refCount);
  });

  it('refs use per-prefix counters', () => {
    const registry = new RefRegistry();
    const tree = loadTree('login-screen.xml');
    const result = registry.rebuild(tree);

    // login fixture has 2 EditTexts, 1 Button, 1 CheckBox, 1 clickable TextView
    // → @f1 @f2 @b1 @c1 @l1
    expect(result.refMap.has('@f1')).toBe(true);
    expect(result.refMap.has('@f2')).toBe(true);
    expect(result.refMap.has('@b1')).toBe(true);
    expect(result.refMap.has('@c1')).toBe(true);
    expect(result.refMap.has('@l1')).toBe(true);
  });

  it('resolve returns the underlying node', () => {
    const registry = new RefRegistry();
    const tree = loadTree('login-screen.xml');
    registry.rebuild(tree);

    const signIn = registry.resolve('@b1');
    expect(signIn.text).toBe('Sign in');
    expect(signIn.role).toBe('button');
  });

  it('resolve throws ElementNotFoundError with stale-ref message on unknown ref', () => {
    const registry = new RefRegistry();
    const tree = loadTree('login-screen.xml');
    registry.rebuild(tree);

    expect(() => registry.resolve('@b99')).toThrow(ElementNotFoundError);
    try {
      registry.resolve('@b99');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      expect(msg).toContain('@b99');
      expect(msg).toContain('stale');
      expect(msg).toContain('agentest_get_ui_tree');
    }
  });

  it('rebuild clears the previous refMap', () => {
    const registry = new RefRegistry();
    const login = loadTree('login-screen.xml');
    const home = loadTree('home-screen.xml');

    registry.rebuild(login);
    expect(registry.size).toBeGreaterThan(0);

    registry.rebuild(home);
    // After rebuild, login refs are gone
    expect(() => registry.resolve('@f1')).toThrow(ElementNotFoundError);
  });

  it('clear() drops all state', () => {
    const registry = new RefRegistry();
    registry.rebuild(loadTree('login-screen.xml'));
    expect(registry.size).toBeGreaterThan(0);

    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.fingerprint).toBe('');
    expect(registry.text).toBe('');
  });

  it('fingerprint is stable across rebuilds of the same tree', () => {
    const registry = new RefRegistry();
    const tree = loadTree('login-screen.xml');

    const a = registry.rebuild(tree).fingerprint;
    const b = registry.rebuild(tree).fingerprint;
    expect(a).toBe(b);
  });

  it('fingerprint differs between distinct screens', () => {
    const registry = new RefRegistry();
    const login = registry.rebuild(loadTree('login-screen.xml')).fingerprint;
    const home = registry.rebuild(loadTree('home-screen.xml')).fingerprint;

    expect(login).not.toBe(home);
  });
});
