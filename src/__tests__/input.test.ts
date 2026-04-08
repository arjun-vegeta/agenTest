import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAssertion, resolveTarget } from '../android/input.js';
import { parseUiAutomatorXml } from '../android/tree-parser.js';
import { ElementNotFoundError } from '../errors.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

function loadTree(name: string) {
  const xml = readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
  return parseUiAutomatorXml(xml);
}

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

describe('resolveTarget', () => {
  it('resolves element by id', () => {
    const tree = loadTree('login-screen.xml');
    const element = resolveTarget(tree, { id: 'email' });

    expect(element.resourceId).toContain('email');
    expect(element.center.x).toBe(540);
    expect(element.center.y).toBe(312);
  });

  it('resolves element by text', () => {
    const tree = loadTree('login-screen.xml');
    const element = resolveTarget(tree, { text: 'Sign in' });

    expect(element.role).toBe('button');
  });

  it('resolves element by className + index', () => {
    const tree = loadTree('login-screen.xml');
    const element = resolveTarget(tree, {
      className: 'android.widget.EditText',
      index: 1,
    });

    expect(element.resourceId).toContain('password');
    expect(element.password).toBe(true);
  });

  it('throws ElementNotFoundError when no match', () => {
    const tree = loadTree('login-screen.xml');

    expect(() => resolveTarget(tree, { id: 'nonexistent' })).toThrow(ElementNotFoundError);
  });

  it('throws ElementNotFoundError for empty selector', () => {
    const tree = loadTree('login-screen.xml');

    expect(() => resolveTarget(tree, {})).toThrow(ElementNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// checkAssertion — assert_visible
// ---------------------------------------------------------------------------

describe('checkAssertion — assert_visible', () => {
  it('passes when element exists', () => {
    const tree = loadTree('login-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_visible',
      target: { id: 'email' },
    });

    expect(result.passed).toBe(true);
    expect(result.message).toContain('Element found');
  });

  it('fails when element does not exist', () => {
    const tree = loadTree('login-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_visible',
      target: { id: 'home_screen' },
    });

    expect(result.passed).toBe(false);
    expect(result.message).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// checkAssertion — assert_not_visible
// ---------------------------------------------------------------------------

describe('checkAssertion — assert_not_visible', () => {
  it('passes when element does not exist', () => {
    const tree = loadTree('login-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_not_visible',
      target: { id: 'home_screen' },
    });

    expect(result.passed).toBe(true);
    expect(result.message).toContain('correctly not present');
  });

  it('fails when element exists', () => {
    const tree = loadTree('login-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_not_visible',
      target: { id: 'email' },
    });

    expect(result.passed).toBe(false);
    expect(result.message).toContain('unexpectedly found');
  });
});

// ---------------------------------------------------------------------------
// checkAssertion — assert_text_equals
// ---------------------------------------------------------------------------

describe('checkAssertion — assert_text_equals', () => {
  it('passes on exact text match', () => {
    const tree = loadTree('login-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_text_equals',
      target: { id: 'sign_in_button' },
      value: 'Sign in',
    });

    expect(result.passed).toBe(true);
  });

  it('fails on text mismatch', () => {
    const tree = loadTree('login-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_text_equals',
      target: { id: 'sign_in_button' },
      value: 'Log in',
    });

    expect(result.passed).toBe(false);
    expect(result.message).toContain('Expected text "Log in" but got "Sign in"');
  });

  it('fails when target element not found', () => {
    const tree = loadTree('login-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_text_equals',
      target: { id: 'nonexistent' },
      value: 'anything',
    });

    expect(result.passed).toBe(false);
    expect(result.message).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// checkAssertion — assert_text_contains
// ---------------------------------------------------------------------------

describe('checkAssertion — assert_text_contains', () => {
  it('passes on substring match', () => {
    const tree = loadTree('home-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_text_contains',
      target: { id: 'welcome_text' },
      value: 'Welcome',
    });

    expect(result.passed).toBe(true);
  });

  it('passes on email substring match', () => {
    const tree = loadTree('home-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_text_contains',
      target: { id: 'welcome_text' },
      value: 'user@test.com',
    });

    expect(result.passed).toBe(true);
  });

  it('fails when substring not found', () => {
    const tree = loadTree('home-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_text_contains',
      target: { id: 'welcome_text' },
      value: 'admin',
    });

    expect(result.passed).toBe(false);
    expect(result.message).toContain('Expected text to contain "admin"');
  });

  it('fails when target element not found', () => {
    const tree = loadTree('login-screen.xml');
    const result = checkAssertion(tree, {
      action: 'assert_text_contains',
      target: { id: 'nonexistent' },
      value: 'anything',
    });

    expect(result.passed).toBe(false);
    expect(result.message).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// checkAssertion — non-assertion actions pass
// ---------------------------------------------------------------------------

describe('checkAssertion — non-assertion', () => {
  it('returns passed for tap actions', () => {
    const tree = loadTree('login-screen.xml');
    const result = checkAssertion(tree, {
      action: 'tap',
      target: { id: 'email' },
    });

    expect(result.passed).toBe(true);
  });
});
