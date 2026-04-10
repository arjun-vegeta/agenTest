import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RefRegistry } from '../android/ref-registry.js';
import { handleConnect } from '../tools/connect.js';
import { handleGetUiTree } from '../tools/get-ui-tree.js';
import { handleResetApp } from '../tools/reset-app.js';
import { handleRunFlow } from '../tools/run-flow.js';
import type { ActionStep } from '../types.js';
import { MockShellExecutor } from './mock-shell.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
}

/**
 * Create a mock shell that simulates a device with an app.
 * Starts on the login screen, transitions to home screen after "sign_in_button" is tapped.
 */
function createAppSimulator() {
  const shell = new MockShellExecutor();
  const loginXml = loadFixture('login-screen.xml');
  const homeXml = loadFixture('home-screen.xml');

  let currentScreen = 'login';

  // Device is connected
  shell.when('devices', 'List of devices attached\nemulator-5554\tdevice\n\n');

  // App launch succeeds
  shell.when('monkey', 'Events injected: 1\n');

  // Force stop succeeds
  shell.when('force-stop', '');

  // Input commands succeed
  shell.when('input tap', '');
  shell.when('input text', '');
  shell.when('input swipe', '');
  shell.when('input keyevent', '');

  // Override exec to track screen state and return appropriate XML
  // Batched dump command contains both "uiautomator dump" and "cat" in one call
  const originalExec = shell.exec.bind(shell);
  shell.exec = async (command, options) => {
    // When we tap the sign in button, switch to home screen
    if (command.includes('input tap 540 816')) {
      currentScreen = 'home';
    }

    // When we force-stop, go back to login
    if (command.includes('force-stop')) {
      currentScreen = 'login';
    }

    // Batched dump command — return XML based on current screen
    if (command.includes('uiautomator dump')) {
      return currentScreen === 'login' ? loginXml : homeXml;
    }

    return originalExec(command, options);
  };

  return { shell, getCurrentScreen: () => currentScreen };
}

// ---------------------------------------------------------------------------
// E2E: Connect → Get Tree → Run Flow → Reset
// ---------------------------------------------------------------------------

describe('E2E: Full login flow', () => {
  it('connects and returns the initial UI tree', async () => {
    const { shell } = createAppSimulator();
    const registry = new RefRegistry();

    const result = await handleConnect(
      shell,
      'com.example.myapp',
      undefined,
      'auto',
      undefined,
      undefined,
      undefined,
      registry,
    );

    expect(result.deviceId).toBe('emulator-5554');
    expect(result.packageName).toBe('com.example.myapp');
    expect(typeof result.uiTree).toBe('string');
    expect(result.uiTree).toMatch(/^screen \d+x\d+/);
    expect(result.screenFingerprint).toMatch(/^[0-9a-z]{6}$/);
  });

  it('gets a fresh UI tree snapshot in compact format', async () => {
    const { shell } = createAppSimulator();
    const registry = new RefRegistry();

    const result = await handleGetUiTree(shell, registry);

    expect(result.format).toBe('compact');
    expect(typeof result.uiTree).toBe('string');
    expect(result.uiTree).toMatch(/^screen /);
    expect(result.fingerprint).toMatch(/^[0-9a-z]{6}$/);
  });

  it('gets a full JSON tree snapshot when format=full requested', async () => {
    const { shell } = createAppSimulator();
    const registry = new RefRegistry();

    const result = await handleGetUiTree(shell, registry, { format: 'full' });

    expect(result.format).toBe('full');
    expect(typeof result.uiTree).toBe('object');
    expect((result.uiTree as { role: string }).role).toBe('container');
  });

  it('runs a successful login flow', { timeout: 30_000 }, async () => {
    const { shell } = createAppSimulator();
    const registry = new RefRegistry();

    const steps: ActionStep[] = [
      { action: 'tap', target: { id: 'email' } },
      { action: 'type', target: { id: 'email' }, value: 'user@test.com' },
      { action: 'tap', target: { id: 'password' } },
      { action: 'type', target: { id: 'password' }, value: 'SecurePass123!' },
      { action: 'tap', target: { id: 'sign_in_button' } },
      // After tapping sign_in_button, mock switches to home screen
      { action: 'assert_visible', target: { id: 'welcome_text' } },
      {
        action: 'assert_text_contains',
        target: { id: 'welcome_text' },
        value: 'Welcome',
      },
    ];

    const trace = await handleRunFlow(
      shell,
      steps,
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
    );

    expect(trace.success).toBe(true);
    expect(trace.stepsCompleted).toBe(steps.length);
    expect(trace.totalSteps).toBe(steps.length);
    expect(trace.results).toHaveLength(steps.length);

    // Every step should have succeeded
    for (const result of trace.results) {
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    }

    // Login flow navigates from login → home, so the screen changed
    expect(trace.screenChanged).toBe(true);
    expect(trace.screenFingerprint).toMatch(/^[0-9a-z]{6}$/);
    // Final tree should be the home screen — string in compact format
    expect(typeof trace.finalUiTree).toBe('string');
  });

  it('omits finalUiTree when screen did not change', async () => {
    const { shell } = createAppSimulator();
    const registry = new RefRegistry();

    // type into a field — should not change the screen fingerprint
    const trace = await handleRunFlow(
      shell,
      [
        { action: 'type', target: { id: 'email' }, value: 'hello' },
        { action: 'press_key', keycode: 'KEYCODE_TAB' },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
    );

    expect(trace.success).toBe(true);
    expect(trace.screenChanged).toBe(false);
    // No tree returned because nothing changed — this is the token win
    expect(trace.finalUiTree).toBeUndefined();
  });

  it('stops on first assertion failure', async () => {
    const { shell } = createAppSimulator();

    const steps: ActionStep[] = [
      // Don't tap sign_in_button, so we stay on login screen
      {
        action: 'assert_visible',
        target: { id: 'welcome_text' }, // doesn't exist on login screen
      },
      {
        action: 'assert_visible',
        target: { id: 'sign_in_button' }, // would pass, but never reached
      },
    ];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(false);
    expect(trace.stepsCompleted).toBe(0); // failed at step 0
    expect(trace.totalSteps).toBe(2);
    expect(trace.results).toHaveLength(1); // only the failed step
    expect(trace.results[0]?.success).toBe(false);
    expect(trace.results[0]?.error).toContain('not found');
    expect(trace.error).toContain('not found');
  });

  it('stops on element not found during action', async () => {
    const { shell } = createAppSimulator();

    const steps: ActionStep[] = [
      { action: 'tap', target: { id: 'nonexistent_button' } },
      { action: 'tap', target: { id: 'email' } }, // never reached
    ];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(false);
    expect(trace.stepsCompleted).toBe(0);
    expect(trace.results[0]?.success).toBe(false);
    expect(trace.results[0]?.error).toContain('No element found');
  });

  it('handles wait steps without tree interaction', async () => {
    const { shell } = createAppSimulator();

    const steps: ActionStep[] = [
      { action: 'wait', timeoutMs: 10 },
      { action: 'assert_visible', target: { id: 'email' } },
    ];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    expect(trace.results[0]?.action.action).toBe('wait');
    expect(trace.results[0]?.success).toBe(true);
  });

  it('handles press_key steps', async () => {
    const { shell } = createAppSimulator();

    const steps: ActionStep[] = [{ action: 'press_key', keycode: 'KEYCODE_BACK' }];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    expect(shell.getCallsMatching('input keyevent').length).toBeGreaterThan(0);
  });

  it('handles tap_coordinates for unlabeled icons', async () => {
    const { shell } = createAppSimulator();

    const steps: ActionStep[] = [{ action: 'tap_coordinates', x: 1184, y: 228 }];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    const tapCalls = shell.getCallsMatching('input tap');
    expect(tapCalls.length).toBeGreaterThan(0);
    expect(tapCalls.some((c) => c.includes('1184') && c.includes('228'))).toBe(true);
  });

  it('handles long_press_coordinates', async () => {
    const { shell } = createAppSimulator();

    const steps: ActionStep[] = [
      { action: 'long_press_coordinates', x: 540, y: 960, durationMs: 800 },
    ];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    const swipeCalls = shell.getCallsMatching('input swipe');
    // long_press is zero-distance swipe: same start and end coords
    expect(swipeCalls.some((c) => c.includes('540 960 540 960 800'))).toBe(true);
  });

  it('handles double_tap on element', async () => {
    const { shell } = createAppSimulator();

    const steps: ActionStep[] = [{ action: 'double_tap', target: { id: 'email' } }];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    // Double tap = two tap commands
    const tapCalls = shell.getCallsMatching('input tap');
    expect(tapCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('handles double_tap_coordinates', async () => {
    const { shell } = createAppSimulator();

    const steps: ActionStep[] = [{ action: 'double_tap_coordinates', x: 300, y: 400 }];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    const tapCalls = shell.getCallsMatching('input tap');
    const coordTaps = tapCalls.filter((c) => c.includes('300') && c.includes('400'));
    expect(coordTaps.length).toBeGreaterThanOrEqual(2);
  });

  it('handles swipe_coordinates', async () => {
    const { shell } = createAppSimulator();

    const steps: ActionStep[] = [
      { action: 'swipe_coordinates', x1: 100, y1: 800, x2: 100, y2: 200, durationMs: 400 },
    ];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    const swipeCalls = shell.getCallsMatching('input swipe');
    expect(swipeCalls.some((c) => c.includes('100 800 100 200 400'))).toBe(true);
  });

  it('handles clear_text on a text field', async () => {
    const { shell } = createAppSimulator();

    const steps: ActionStep[] = [{ action: 'clear_text', target: { id: 'email' } }];

    const trace = await handleRunFlow(shell, steps);

    expect(trace.success).toBe(true);
    // Should tap the field first, then send key events to clear
    const tapCalls = shell.getCallsMatching('input tap');
    expect(tapCalls.length).toBeGreaterThan(0);
    const keyCalls = shell.getCallsMatching('input keyevent');
    expect(keyCalls.length).toBeGreaterThan(0);
  });

  it('resets the app and returns fresh tree', async () => {
    const { shell, getCurrentScreen } = createAppSimulator();
    const registry = new RefRegistry();

    // First navigate to home by tapping sign_in_button
    await handleRunFlow(
      shell,
      [{ action: 'tap', target: { id: 'sign_in_button' } }],
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
    );
    expect(getCurrentScreen()).toBe('home');

    // Reset should go back to login
    const result = await handleResetApp(
      shell,
      'com.example.myapp',
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
    );

    expect(getCurrentScreen()).toBe('login');
    expect(result.packageName).toBe('com.example.myapp');
    expect(typeof result.uiTree).toBe('string');
    expect(result.uiTree).toMatch(/^screen /);
    expect(result.screenFingerprint).toMatch(/^[0-9a-z]{6}$/);
  });
});

// ---------------------------------------------------------------------------
// E2E: Multiple test flows with reset between
// ---------------------------------------------------------------------------

describe('E2E: Multiple test cases with reset', () => {
  it('runs two test flows with reset between them', async () => {
    const { shell } = createAppSimulator();

    // Test 1: Login flow
    const loginTrace = await handleRunFlow(shell, [
      { action: 'tap', target: { id: 'email' } },
      { action: 'type', target: { id: 'email' }, value: 'user@test.com' },
      { action: 'tap', target: { id: 'sign_in_button' } },
      { action: 'assert_visible', target: { id: 'welcome_text' } },
    ]);
    expect(loginTrace.success).toBe(true);

    // Reset
    await handleResetApp(shell, 'com.example.myapp');

    // Test 2: Check login form is present again
    const formTrace = await handleRunFlow(shell, [
      { action: 'assert_visible', target: { id: 'email' } },
      { action: 'assert_visible', target: { id: 'password' } },
      { action: 'assert_visible', target: { id: 'sign_in_button' } },
    ]);
    expect(formTrace.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E2E: Text assertions on the home screen
// ---------------------------------------------------------------------------

describe('E2E: Text assertions', () => {
  it('verifies welcome message after login', async () => {
    const { shell } = createAppSimulator();

    const trace = await handleRunFlow(shell, [
      { action: 'tap', target: { id: 'sign_in_button' } },
      {
        action: 'assert_text_equals',
        target: { id: 'welcome_text' },
        value: 'Welcome, user@test.com',
      },
    ]);

    expect(trace.success).toBe(true);
  });

  it('fails text_equals assertion on mismatch', async () => {
    const { shell } = createAppSimulator();

    const trace = await handleRunFlow(shell, [
      { action: 'tap', target: { id: 'sign_in_button' } },
      {
        action: 'assert_text_equals',
        target: { id: 'welcome_text' },
        value: 'Welcome, admin@test.com',
      },
    ]);

    expect(trace.success).toBe(false);
    expect(trace.results[1]?.error).toContain('Expected text');
    expect(trace.results[1]?.error).toContain('admin@test.com');
  });
});
