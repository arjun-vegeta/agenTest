/**
 * Regression tests for Metro-first React Native detection in
 * `agentest_connect`.
 *
 * Background: against a real API 36 emulator running a React Native dev
 * build, both helper-side detection signals failed —
 *
 *   1. /proc/<pid>/maps was unreadable from shell UID
 *      ("cat: /proc/14347/maps: Permission denied"), killing the
 *      native-library scan.
 *   2. RN Fabric flattens React views into plain Android widgets, so the
 *      accessibility tree contained no ReactRootView / ReactViewGroup /
 *      RCTView class names for the tree-walker to match.
 *
 * The pivot is to use Metro's `/json/list` inspector proxy as the
 * primary RN identification signal. When Metro is reachable and lists a
 * debug target whose `appId` equals our package, we know the app is
 * React Native regardless of what helper detection said. These tests
 * pin that behavior so future refactors don't regress it.
 *
 * The tests stub `globalThis.fetch` so no real network calls are made,
 * and use `MockShellExecutor` for the device side.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConnect } from '../tools/connect.js';
import { MockShellExecutor } from './mock-shell.js';

const previousDisable = process.env['AGENTEST_DISABLE_FRAMEWORK_SYNC'];

beforeEach(() => {
  // The Metro probe is gated on this env var (vitest.config sets it = '1'
  // for the rest of the suite). We unset it locally so the path under
  // test actually runs.
  delete process.env['AGENTEST_DISABLE_FRAMEWORK_SYNC'];
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousDisable === undefined) {
    delete process.env['AGENTEST_DISABLE_FRAMEWORK_SYNC'];
  } else {
    process.env['AGENTEST_DISABLE_FRAMEWORK_SYNC'] = previousDisable;
  }
});

/**
 * Build a MockShellExecutor that mimics a connected emulator + simple
 * Android-widget-only app. We don't need a full XML fixture for these
 * tests — connect's framework decision happens before the tree dump.
 */
function createNativeLookingShell(): MockShellExecutor {
  const shell = new MockShellExecutor();
  shell.when('devices', 'List of devices attached\nemulator-5554\tdevice\n\n');
  shell.when('monkey', 'Events injected: 1\n');
  shell.when('input tap', '');
  // Minimal valid uiautomator dump — a single FrameLayout root, the way
  // the user's RN app actually looked. No React-specific class names.
  shell.when(
    'uiautomator dump',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout"
    package="ai.rumik.ira.twa" content-desc="" checkable="false" checked="false"
    clickable="false" enabled="true" focusable="false" focused="false"
    scrollable="false" long-clickable="false" password="false" selected="false"
    bounds="[0,0][1280,2856]" />
</hierarchy>`,
  );
  return shell;
}

/**
 * Stub Metro's `/json/list` to return whatever payload the test wants.
 * Pass `null` to simulate Metro being unreachable (ECONNREFUSED fetch).
 */
function stubMetro(payload: unknown[] | null): void {
  if (payload === null) {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    return;
  }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    }),
  );
}

describe('Metro-first RN detection in handleConnect', () => {
  it('flips framework to react_native when Metro lists a target with appId matching the package', async () => {
    // This is the exact failure mode from the user's API 36 emulator
    // session: a real RN app whose helper-side framework detection
    // returned "native" because /proc/maps was locked down AND the a11y
    // tree had no React-specific class names.
    stubMetro([
      {
        id: '8c0b565cb71ae217fa87310a694d4fca979c96fa-1',
        title: 'ai.rumik.ira.twa (sdk_gphone64_arm64)',
        description: 'React Native Bridge [C++ connection]',
        appId: 'ai.rumik.ira.twa',
        type: 'node',
        webSocketDebuggerUrl:
          'ws://127.0.0.1:8081/inspector/debug?device=8c0b565cb71ae217fa87310a694d4fca979c96fa&page=1',
      },
    ]);

    const shell = createNativeLookingShell();
    const result = await handleConnect(shell, 'ai.rumik.ira.twa');

    expect(result.framework).toBe('react_native');
  });

  it('matches by description when appId is missing (older RN versions)', async () => {
    stubMetro([
      {
        id: 'page-1',
        title: 'Hermes React Native',
        // appId field absent — older Metro builds didn't emit it.
        description: 'Bundle com.example.legacyrn/index.js',
        type: 'node',
        webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=0&page=1',
      },
    ]);

    const shell = createNativeLookingShell();
    const result = await handleConnect(shell, 'com.example.legacyrn');

    expect(result.framework).toBe('react_native');
  });

  it('matches by title when description and appId both miss', async () => {
    stubMetro([
      {
        id: 'page-1',
        title: 'com.example.titleonly',
        description: 'Hermes',
        type: 'node',
        webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=0&page=1',
      },
    ]);

    const shell = createNativeLookingShell();
    const result = await handleConnect(shell, 'com.example.titleonly');

    expect(result.framework).toBe('react_native');
  });

  it('does NOT flip framework when Metro lists targets for a different package', async () => {
    // User has Metro running for a different RN project; the app under
    // test is a genuinely native Android app. We must not falsely tag it
    // as RN just because Metro happens to be up.
    stubMetro([
      {
        id: 'page-1',
        title: 'com.other.rnproject',
        description: 'React Native Bridge',
        appId: 'com.other.rnproject',
        type: 'node',
        webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=0&page=1',
      },
    ]);

    const shell = createNativeLookingShell();
    const result = await handleConnect(shell, 'com.example.nativeapp');

    // No matching target → framework stays whatever the helper said
    // (undefined in test environment, since AGENTEST_DISABLE_HELPER=1).
    expect(result.framework).not.toBe('react_native');
  });

  it('does NOT flip framework when Metro is unreachable (ECONNREFUSED)', async () => {
    stubMetro(null);

    const shell = createNativeLookingShell();
    const result = await handleConnect(shell, 'com.example.nativeapp');

    expect(result.framework).not.toBe('react_native');
  });

  it('does NOT probe Metro at all when AGENTEST_DISABLE_FRAMEWORK_SYNC=1', async () => {
    process.env['AGENTEST_DISABLE_FRAMEWORK_SYNC'] = '1';

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'page-1',
          title: 'ai.rumik.ira.twa',
          appId: 'ai.rumik.ira.twa',
          description: 'React Native Bridge',
          type: 'node',
          webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=0&page=1',
        },
      ],
    });
    vi.stubGlobal('fetch', fetchSpy);

    const shell = createNativeLookingShell();
    const result = await handleConnect(shell, 'ai.rumik.ira.twa');

    // Even with a Metro response that would normally flip the framework,
    // the env var must short-circuit the probe entirely.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.framework).not.toBe('react_native');
  });

  // -------------------------------------------------------------------------
  // Diagnostics surfacing — connect response carries an in-band trace so the
  // LLM can see exactly which step succeeded or failed. This is the
  // workaround for Claude Code's MCP client dropping post-startup stderr.
  // -------------------------------------------------------------------------

  it('surfaces a [metro] diagnostic line when discovery probe runs', async () => {
    stubMetro([
      {
        id: 'page-1',
        title: 'ai.rumik.ira.twa',
        appId: 'ai.rumik.ira.twa',
        description: 'React Native Bridge',
        type: 'node',
        webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=0&page=1',
      },
    ]);

    const shell = createNativeLookingShell();
    const result = await handleConnect(shell, 'ai.rumik.ira.twa');

    expect(result.diagnostics).toBeDefined();
    const all = (result.diagnostics ?? []).join('\n');
    expect(all).toContain('[metro] /json/list returned 1 target');
    expect(all).toContain('[metro] override → framework=react_native');
  });

  it('surfaces a [framework] diagnostic explaining helper detection state', async () => {
    stubMetro(null);

    const shell = createNativeLookingShell();
    const result = await handleConnect(shell, 'com.example.app');

    expect(result.diagnostics).toBeDefined();
    const all = (result.diagnostics ?? []).join('\n');
    // Helper isn't installed in tests (AGENTEST_DISABLE_HELPER=1) so we
    // expect the "skipping helper-side detection" line.
    expect(all).toContain('[framework] helper not installed');
  });

  it('surfaces a metro-skipped diagnostic when AGENTEST_DISABLE_FRAMEWORK_SYNC=1', async () => {
    process.env['AGENTEST_DISABLE_FRAMEWORK_SYNC'] = '1';
    vi.stubGlobal('fetch', vi.fn());

    const shell = createNativeLookingShell();
    const result = await handleConnect(shell, 'com.example.app');

    expect(result.diagnostics).toBeDefined();
    expect((result.diagnostics ?? []).some((d) => d.includes('[metro] skipped'))).toBe(true);
  });
});
