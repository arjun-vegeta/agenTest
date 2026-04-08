import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleRunFlow } from '../tools/run-flow.js';
import type { ActionStep } from '../types.js';
import { MockShellExecutor } from './mock-shell.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
}

function createScrollSimulator() {
  const shell = new MockShellExecutor();
  const loginXml = loadFixture('login-screen.xml');
  const homeXml = loadFixture('home-screen.xml');

  let scrollCount = 0;

  shell.when('uiautomator dump', 'OK');
  shell.when('input tap', '');
  shell.when('input text', '');
  shell.when('input swipe', '');
  shell.when('input keyevent', '');

  // scroll_to needs snapshotTree which calls dumpUiTree
  // After 3 scrolls, "reveal" the target element by switching to home screen
  // (home screen has welcome_text which login screen doesn't)
  const originalExec = shell.exec.bind(shell);
  shell.exec = async (command, options) => {
    if (command.includes('input swipe')) {
      scrollCount++;
    }
    if (command.includes('cat /sdcard/window_dump.xml')) {
      // After 3 scrolls, target becomes visible (home screen has welcome_text)
      return scrollCount >= 3 ? homeXml : loginXml;
    }
    return originalExec(command, options);
  };

  return { shell, getScrollCount: () => scrollCount };
}

describe('scroll_to action', () => {
  it('scrolls until target element is found', { timeout: 30_000 }, async () => {
    const { shell, getScrollCount } = createScrollSimulator();

    const steps: ActionStep[] = [
      {
        action: 'scroll_to',
        target: { id: 'welcome_text' },
        maxScrolls: 10,
      },
    ];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    expect(getScrollCount()).toBe(3); // Found after 3 scrolls
  });

  it('fails when element not found after max scrolls', { timeout: 30_000 }, async () => {
    const shell = new MockShellExecutor();
    const loginXml = loadFixture('login-screen.xml');

    shell.when('uiautomator dump', 'OK');
    shell.when('input swipe', '');

    // Always return login screen — target never appears
    const originalExec = shell.exec.bind(shell);
    shell.exec = async (command, options) => {
      if (command.includes('cat /sdcard/window_dump.xml')) {
        return loginXml;
      }
      return originalExec(command, options);
    };

    const steps: ActionStep[] = [
      {
        action: 'scroll_to',
        target: { id: 'nonexistent_element' },
        maxScrolls: 3,
      },
    ];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(false);
    expect(trace.error).toContain('scroll attempts');
  });

  it('finds element immediately without scrolling', { timeout: 30_000 }, async () => {
    const { shell, getScrollCount } = createScrollSimulator();

    // email exists on login screen — no scrolling needed
    const steps: ActionStep[] = [
      {
        action: 'scroll_to',
        target: { id: 'email' },
        maxScrolls: 5,
      },
    ];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    expect(getScrollCount()).toBe(0); // No scrolling needed
  });
});
