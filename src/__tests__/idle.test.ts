import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdbClient } from '../android/adb.js';
import { detectLoadingIndicators, waitForIdle } from '../android/idle.js';
import { parseUiAutomatorXml } from '../android/tree-parser.js';
import type { UnifiedUINode } from '../types.js';
import { MockShellExecutor } from './mock-shell.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
}

// ---------------------------------------------------------------------------
// waitForIdle
// ---------------------------------------------------------------------------

describe('waitForIdle', () => {
  it('returns tree after consecutive stable snapshots', async () => {
    const shell = new MockShellExecutor();
    const loginXml = loadFixture('login-screen.xml');

    shell.when('uiautomator dump', 'OK');
    shell.when('cat /sdcard/window_dump.xml', loginXml);

    const adb = new AdbClient(shell);
    const result = await waitForIdle(adb, {
      timeoutMs: 5000,
      pollIntervalMs: 10,
      requiredStableCount: 2,
      waitForLoadingIndicators: false,
      maxLoadingWaitMs: 0,
    });

    expect(result.tree.packageName).toBe('com.example.myapp');
    expect(result.loadingDetected).toBe(false);
    const dumpCalls = shell.getCallsMatching('uiautomator dump');
    expect(dumpCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('returns last tree on timeout without throwing', async () => {
    const shell = new MockShellExecutor();
    let callCount = 0;
    const loginXml = loadFixture('login-screen.xml');
    const homeXml = loadFixture('home-screen.xml');

    shell.when('uiautomator dump', 'OK');
    const originalExec = shell.exec.bind(shell);
    shell.exec = async (command, options) => {
      if (command.includes('cat /sdcard/window_dump.xml')) {
        callCount++;
        return callCount % 2 === 0 ? homeXml : loginXml;
      }
      return originalExec(command, options);
    };

    const adb = new AdbClient(shell);
    const result = await waitForIdle(adb, {
      timeoutMs: 200,
      pollIntervalMs: 10,
      requiredStableCount: 2,
      waitForLoadingIndicators: false,
      maxLoadingWaitMs: 0,
    });

    expect(result.tree).toBeDefined();
    expect(result.tree.children.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// detectLoadingIndicators
// ---------------------------------------------------------------------------

describe('detectLoadingIndicators', () => {
  it('detects ProgressBar class', () => {
    const node: UnifiedUINode = {
      id: '0',
      resourceId: '',
      className: 'android.widget.ProgressBar',
      role: 'progress_bar',
      text: '',
      description: '',
      packageName: 'com.example',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      center: { x: 50, y: 50 },
      index: 0,
      enabled: true,
      focused: false,
      selected: false,
      checked: false,
      checkable: false,
      clickable: false,
      scrollable: false,
      longClickable: false,
      password: false,
      actions: [],
      children: [],
    };

    const indicators = detectLoadingIndicators(node);
    expect(indicators.length).toBeGreaterThan(0);
    expect(indicators[0]).toContain('ProgressBar');
  });

  it('detects shimmer layout', () => {
    const node: UnifiedUINode = {
      id: '0',
      resourceId: '',
      className: 'com.facebook.shimmer.ShimmerFrameLayout',
      role: 'container',
      text: '',
      description: '',
      packageName: 'com.example',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      center: { x: 50, y: 50 },
      index: 0,
      enabled: true,
      focused: false,
      selected: false,
      checked: false,
      checkable: false,
      clickable: false,
      scrollable: false,
      longClickable: false,
      password: false,
      actions: [],
      children: [],
    };

    const indicators = detectLoadingIndicators(node);
    expect(indicators.length).toBeGreaterThan(0);
    expect(indicators[0]).toContain('Shimmer');
  });

  it('detects "Loading..." text', () => {
    const node: UnifiedUINode = {
      id: '0',
      resourceId: '',
      className: 'android.widget.TextView',
      role: 'text_view',
      text: 'Loading...',
      description: '',
      packageName: 'com.example',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      center: { x: 50, y: 50 },
      index: 0,
      enabled: true,
      focused: false,
      selected: false,
      checked: false,
      checkable: false,
      clickable: false,
      scrollable: false,
      longClickable: false,
      password: false,
      actions: [],
      children: [],
    };

    const indicators = detectLoadingIndicators(node);
    expect(indicators.length).toBeGreaterThan(0);
    expect(indicators[0]).toContain('Loading...');
  });

  it('detects loading description', () => {
    const node: UnifiedUINode = {
      id: '0',
      resourceId: '',
      className: 'android.widget.ImageView',
      role: 'image',
      text: '',
      description: 'Loading spinner',
      packageName: 'com.example',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      center: { x: 50, y: 50 },
      index: 0,
      enabled: true,
      focused: false,
      selected: false,
      checked: false,
      checkable: false,
      clickable: false,
      scrollable: false,
      longClickable: false,
      password: false,
      actions: [],
      children: [],
    };

    const indicators = detectLoadingIndicators(node);
    expect(indicators.length).toBeGreaterThan(0);
    expect(indicators[0]).toContain('spinner');
  });

  it('detects loading indicators nested in children', () => {
    const loginXml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(loginXml);

    // Login screen has no loaders
    const indicators = detectLoadingIndicators(tree);
    expect(indicators).toHaveLength(0);
  });

  it('returns empty for clean screens', () => {
    const loginXml = loadFixture('login-screen.xml');
    const tree = parseUiAutomatorXml(loginXml);
    const indicators = detectLoadingIndicators(tree);
    expect(indicators).toHaveLength(0);
  });
});
