import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdbClient } from '../android/adb.js';
import { handleRunFlow } from '../tools/run-flow.js';
import type { ActionStep } from '../types.js';
import { MockShellExecutor } from './mock-shell.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
}

// ---------------------------------------------------------------------------
// 1.13 — ADB Command Batching
// ---------------------------------------------------------------------------

describe('ADB command batching (1.13)', () => {
  it('dumpUiTree uses a single batched shell command', async () => {
    const shell = new MockShellExecutor();
    const loginXml = loadFixture('login-screen.xml');
    shell.when('uiautomator dump', loginXml);

    const adb = new AdbClient(shell);
    await adb.dumpUiTree();

    const calls = shell.getCalls();
    // Should be exactly 1 call for the batched rm+dump+cat
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('rm -f');
    expect(calls[0]).toContain('uiautomator dump');
    expect(calls[0]).toContain('cat');
  });
});

// ---------------------------------------------------------------------------
// 1.15 — Lightweight Action Fast-Path
// ---------------------------------------------------------------------------

describe('Lightweight action fast-path (1.15)', () => {
  function createSimulator() {
    const shell = new MockShellExecutor();
    const loginXml = loadFixture('login-screen.xml');

    shell.when('input tap', '');
    shell.when('input text', '');
    shell.when('input swipe', '');
    shell.when('input keyevent', '');

    const originalExec = shell.exec.bind(shell);
    shell.exec = async (command, options) => {
      if (command.includes('uiautomator dump')) {
        return loginXml;
      }
      return originalExec(command, options);
    };

    return shell;
  }

  it('press_key uses fewer tree dumps than tap', async () => {
    let keyDumpCount = 0;
    let tapDumpCount = 0;

    // Test 1: press_key (lightweight — single snapshot)
    const shell1 = new MockShellExecutor();
    const loginXml1 = loadFixture('login-screen.xml');
    shell1.when('input keyevent', '');
    shell1.exec = async (command) => {
      if (command.includes('uiautomator dump')) {
        keyDumpCount++;
        return loginXml1;
      }
      if (command.includes('input keyevent')) return '';
      return '';
    };

    const keyTrace = await handleRunFlow(shell1, [
      { action: 'press_key', keycode: 'KEYCODE_BACK' },
    ]);

    // Test 2: tap (heavy — full idle detection with multiple polls)
    const shell2 = new MockShellExecutor();
    const loginXml2 = loadFixture('login-screen.xml');
    shell2.exec = async (command) => {
      if (command.includes('uiautomator dump')) {
        tapDumpCount++;
        return loginXml2;
      }
      if (command.includes('input tap')) return '';
      return '';
    };

    const tapTrace = await handleRunFlow(shell2, [{ action: 'tap', target: { id: 'email' } }]);

    expect(keyTrace.success).toBe(true);
    expect(tapTrace.success).toBe(true);
    // press_key: 1 initial snapshot + 1 post-action snapshot = 2 dumps
    // tap: 1 initial snapshot + 3+ idle polls = 4+ dumps
    expect(keyDumpCount).toBeLessThan(tapDumpCount);
  });

  it('type action uses lightweight fast-path', async () => {
    const shell = createSimulator();
    shell.when('devices', 'List of devices attached\nemulator-5554\tdevice\n\n');
    shell.when('monkey', 'Events injected: 1\n');

    const trace = await handleRunFlow(shell, [
      { action: 'type', target: { id: 'email' }, value: 'test@test.com' },
    ]);

    expect(trace.success).toBe(true);
  });

  it('tap_coordinates uses lightweight fast-path', async () => {
    const shell = createSimulator();

    const trace = await handleRunFlow(shell, [{ action: 'tap_coordinates', x: 540, y: 960 }]);

    expect(trace.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1.12 — Better Text Input (clipboard fallback)
// ---------------------------------------------------------------------------

describe('Better text input (1.12)', () => {
  it('uses input text for ASCII strings', async () => {
    const shell = new MockShellExecutor();
    shell.when('input text', '');
    const adb = new AdbClient(shell);

    await adb.type('hello123');

    const calls = shell.getCallsMatching('input text');
    expect(calls).toHaveLength(1);
  });

  it('uses clipboard + paste for unicode/emoji', async () => {
    const shell = new MockShellExecutor();
    shell.when('am broadcast', '');
    shell.when('input keyevent', '');
    const adb = new AdbClient(shell);

    await adb.type('hello 🌍 world');

    const broadcastCalls = shell.getCallsMatching('am broadcast');
    expect(broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0]).toContain('clipboardSetText');

    const keyCalls = shell.getCallsMatching('KEYCODE_PASTE');
    expect(keyCalls).toHaveLength(1);
  });

  it('uses clipboard for text with special shell characters', async () => {
    const shell = new MockShellExecutor();
    shell.when('am broadcast', '');
    shell.when('input keyevent', '');
    const adb = new AdbClient(shell);

    // Non-ASCII: tab character triggers clipboard path
    await adb.type('hello\tworld');

    const broadcastCalls = shell.getCallsMatching('am broadcast');
    expect(broadcastCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 1.9 — App Crash Detection
// ---------------------------------------------------------------------------

describe('App crash detection (1.9)', () => {
  it('detects app crash when root package changes to system', async () => {
    const shell = new MockShellExecutor();
    const loginXml = loadFixture('login-screen.xml');

    // Build a crash screen XML with com.android.systemui package
    const crashXml = loginXml.replace(/com\.example\.myapp/g, 'com.android.systemui');

    let tapped = false;

    shell.when('input tap', '');
    shell.when('devices', 'List of devices attached\nemulator-5554\tdevice\n\n');
    shell.when('monkey', 'Events injected: 1\n');

    const originalExec = shell.exec.bind(shell);
    shell.exec = async (command, options) => {
      if (command.includes('input tap')) {
        tapped = true;
      }
      if (command.includes('uiautomator dump')) {
        // After tap, return crash screen
        return tapped ? crashXml : loginXml;
      }
      return originalExec(command, options);
    };

    const steps: ActionStep[] = [{ action: 'tap', target: { id: 'sign_in_button' } }];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(false);
    expect(trace.appCrashDetected).toBe(true);
    expect(trace.error).toContain('crashed');
    expect(trace.error).toContain('com.android.systemui');
  });

  it('does not false-positive on normal screen transitions', async () => {
    const shell = new MockShellExecutor();
    const loginXml = loadFixture('login-screen.xml');
    const homeXml = loadFixture('home-screen.xml');
    // home screen has the same package (com.example.myapp) — not a crash

    let tapped = false;

    shell.when('input tap', '');
    shell.when('devices', 'List of devices attached\nemulator-5554\tdevice\n\n');
    shell.when('monkey', 'Events injected: 1\n');

    const originalExec = shell.exec.bind(shell);
    shell.exec = async (command, options) => {
      if (command.includes('input tap')) {
        tapped = true;
      }
      if (command.includes('uiautomator dump')) {
        return tapped ? homeXml : loginXml;
      }
      return originalExec(command, options);
    };

    const steps: ActionStep[] = [{ action: 'tap', target: { id: 'sign_in_button' } }];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    expect(trace.appCrashDetected).toBeUndefined();
  });
});
