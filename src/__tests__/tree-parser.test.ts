import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boundsCenter,
  findElements,
  parseBounds,
  parseUiAutomatorXml,
  serializeTreeForLlm,
} from '../android/tree-parser.js';
import { TreeParseError } from '../errors.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
}

// ---------------------------------------------------------------------------
// parseBounds
// ---------------------------------------------------------------------------

describe('parseBounds', () => {
  it('parses valid bounds string', () => {
    const bounds = parseBounds('[48,240][1032,384]');
    expect(bounds).toEqual({ left: 48, top: 240, right: 1032, bottom: 384 });
  });

  it('parses zero-origin bounds', () => {
    const bounds = parseBounds('[0,0][1080,1920]');
    expect(bounds).toEqual({ left: 0, top: 0, right: 1080, bottom: 1920 });
  });

  it('throws on invalid format', () => {
    expect(() => parseBounds('invalid')).toThrow(TreeParseError);
    expect(() => parseBounds('[0,0]')).toThrow(TreeParseError);
    expect(() => parseBounds('')).toThrow(TreeParseError);
  });
});

// ---------------------------------------------------------------------------
// boundsCenter
// ---------------------------------------------------------------------------

describe('boundsCenter', () => {
  it('computes center of a bounds rect', () => {
    const center = boundsCenter({ left: 48, top: 240, right: 1032, bottom: 384 });
    expect(center).toEqual({ x: 540, y: 312 });
  });

  it('computes center of full screen', () => {
    const center = boundsCenter({ left: 0, top: 0, right: 1080, bottom: 1920 });
    expect(center).toEqual({ x: 540, y: 960 });
  });
});

// ---------------------------------------------------------------------------
// parseUiAutomatorXml — login screen fixture
// ---------------------------------------------------------------------------

describe('parseUiAutomatorXml', () => {
  it('parses login screen fixture into a tree', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);

    expect(tree.className).toBe('android.widget.FrameLayout');
    expect(tree.role).toBe('container');
    expect(tree.bounds).toEqual({ left: 0, top: 0, right: 1080, bottom: 1920 });
    expect(tree.packageName).toBe('com.example.myapp');
  });

  it('finds the email field in login screen', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const emails = findElements(tree, { id: 'email' });

    expect(emails).toHaveLength(1);
    expect(emails[0]?.resourceId).toBe('com.example.myapp:id/email');
    expect(emails[0]?.role).toBe('text_field');
    expect(emails[0]?.text).toBe('Email');
    expect(emails[0]?.clickable).toBe(true);
    expect(emails[0]?.focused).toBe(true);
    expect(emails[0]?.actions).toContain('tap');
    expect(emails[0]?.actions).toContain('type');
  });

  it('finds the password field and marks it as password', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    // "id/password" is more specific — "password" alone also matches "forgot_password"
    const passwords = findElements(tree, { id: 'id/password' });

    expect(passwords).toHaveLength(1);
    expect(passwords[0]?.password).toBe(true);
    expect(passwords[0]?.role).toBe('text_field');
  });

  it('finds the sign in button', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const buttons = findElements(tree, { id: 'sign_in_button' });

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.text).toBe('Sign in');
    expect(buttons[0]?.role).toBe('button');
    expect(buttons[0]?.clickable).toBe(true);
    expect(buttons[0]?.actions).toContain('tap');
  });

  it('finds the checkbox and identifies it as checkable', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const checkboxes = findElements(tree, { id: 'remember_me' });

    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]?.role).toBe('check_box');
    expect(checkboxes[0]?.checkable).toBe(true);
    expect(checkboxes[0]?.checked).toBe(false);
    expect(checkboxes[0]?.actions).toContain('check');
  });

  it('computes correct center coordinates for sign in button', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const buttons = findElements(tree, { id: 'sign_in_button' });

    // bounds: [48,744][1032,888] → center: (540, 816)
    expect(buttons[0]?.center).toEqual({ x: 540, y: 816 });
  });

  it('throws on empty XML', () => {
    expect(() => parseUiAutomatorXml('')).toThrow(TreeParseError);
  });

  it('throws on XML missing hierarchy', () => {
    expect(() => parseUiAutomatorXml('<root></root>')).toThrow(TreeParseError);
  });

  it('throws on hierarchy with no nodes', () => {
    expect(() => parseUiAutomatorXml('<hierarchy rotation="0"></hierarchy>')).toThrow(
      TreeParseError,
    );
  });

  it('parses home screen fixture', () => {
    const xml = loadFixture('home-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const welcomes = findElements(tree, { id: 'welcome_text' });

    expect(welcomes).toHaveLength(1);
    expect(welcomes[0]?.text).toBe('Welcome, user@test.com');
  });
});

// ---------------------------------------------------------------------------
// findElements — selector strategies
// ---------------------------------------------------------------------------

describe('findElements', () => {
  it('finds by exact text', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const results = findElements(tree, { text: 'Sign in' });

    expect(results).toHaveLength(1);
    expect(results[0]?.role).toBe('button');
  });

  it('finds by text substring', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const results = findElements(tree, { textContains: 'Forgot' });

    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe('Forgot Password?');
  });

  it('finds by className', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const results = findElements(tree, { className: 'android.widget.EditText' });

    expect(results).toHaveLength(2); // email + password
  });

  it('selects by index when multiple matches', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);

    const first = findElements(tree, { className: 'android.widget.EditText', index: 0 });
    const second = findElements(tree, { className: 'android.widget.EditText', index: 1 });

    expect(first).toHaveLength(1);
    expect(first[0]?.resourceId).toContain('email');

    expect(second).toHaveLength(1);
    expect(second[0]?.resourceId).toContain('password');
  });

  it('returns empty for non-existent index', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const results = findElements(tree, { className: 'android.widget.EditText', index: 5 });

    expect(results).toHaveLength(0);
  });

  it('returns empty when no criteria match', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const results = findElements(tree, { id: 'nonexistent_element' });

    expect(results).toHaveLength(0);
  });

  it('returns empty when no criteria specified', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const results = findElements(tree, {});

    expect(results).toHaveLength(0);
  });

  it('combines multiple criteria with AND logic', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);

    // EditText with text "Email" — should match only the email field
    const results = findElements(tree, {
      className: 'android.widget.EditText',
      text: 'Email',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.resourceId).toContain('email');
  });

  it('id selector uses substring match', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);

    // "email" should match "com.example.myapp:id/email"
    const results = findElements(tree, { id: 'email' });
    expect(results).toHaveLength(1);

    // Full resource-id also works
    const full = findElements(tree, { id: 'com.example.myapp:id/email' });
    expect(full).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// serializeTreeForLlm
// ---------------------------------------------------------------------------

describe('serializeTreeForLlm', () => {
  it('produces compact output with only non-default fields', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const emails = findElements(tree, { id: 'email' });
    const serialized = serializeTreeForLlm(emails[0]!);

    // Should have: id, role, text, bounds, focused, actions
    expect(serialized.id).toBe('com.example.myapp:id/email');
    expect(serialized.role).toBe('text_field');
    expect(serialized.text).toBe('Email');
    expect(serialized.bounds).toBe('[48,240][1032,384]');
    expect(serialized.focused).toBe(true);
    expect(serialized.actions).toContain('tap');
    expect(serialized.actions).toContain('type');

    // Should NOT have: enabled (true is default), checked, selected
    expect(serialized.enabled).toBeUndefined();
    expect(serialized.checked).toBeUndefined();
    expect(serialized.selected).toBeUndefined();
  });

  it('includes password flag for password fields', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const passwords = findElements(tree, { id: 'password' });
    const serialized = serializeTreeForLlm(passwords[0]!);

    expect(serialized.password).toBe(true);
  });

  it('serializes children recursively', () => {
    const xml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(xml);
    const serialized = serializeTreeForLlm(tree);

    expect(serialized.children).toBeDefined();
    expect(serialized.children!.length).toBeGreaterThan(0);
  });
});
