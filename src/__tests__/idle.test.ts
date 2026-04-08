import { describe, expect, it } from 'vitest';
import { waitForIdle } from '../android/idle.js';
import { AdbClient } from '../android/adb.js';
import { MockShellExecutor } from './mock-shell.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

    // Every dump returns the same tree → stable immediately
    shell.when('uiautomator dump', 'OK');
    shell.when('cat /sdcard/window_dump.xml', loginXml);

    const adb = new AdbClient(shell);
    const tree = await waitForIdle(adb, {
      timeoutMs: 5000,
      pollIntervalMs: 10, // fast polling for test
      requiredStableCount: 2,
    });

    expect(tree.packageName).toBe('com.example.myapp');
    // Should have called dump at least 3 times (initial + 2 stable)
    const dumpCalls = shell.getCallsMatching('uiautomator dump');
    expect(dumpCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('returns last tree on timeout without throwing', async () => {
    const shell = new MockShellExecutor();
    let callCount = 0;
    const loginXml = loadFixture('login-screen.xml');
    const homeXml = loadFixture('home-screen.xml');

    // Alternate between two different trees so it never stabilizes
    shell.when('uiautomator dump', 'OK');
    // Override exec to alternate responses
    const originalExec = shell.exec.bind(shell);
    shell.exec = async (command, options) => {
      if (command.includes('cat /sdcard/window_dump.xml')) {
        callCount++;
        return callCount % 2 === 0 ? homeXml : loginXml;
      }
      return originalExec(command, options);
    };

    const adb = new AdbClient(shell);
    const tree = await waitForIdle(adb, {
      timeoutMs: 200,
      pollIntervalMs: 10,
      requiredStableCount: 2,
    });

    // Should return something, not throw
    expect(tree).toBeDefined();
    expect(tree.children.length).toBeGreaterThan(0);
  });
});
