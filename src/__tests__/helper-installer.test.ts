/**
 * Tests for ensureHelper — the auto-install + launch flow that runs on first
 * MCP connect. Uses MockShellExecutor for ADB calls and overrides
 * LAZYTEST_HELPER_APK_DIR to point at a temp directory containing dummy APKs
 * so findPrebuiltApks succeeds.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureHelper } from '../android/helper-installer.js';
import { HELPER } from '../constants.js';
import { MockShellExecutor } from './mock-shell.js';

describe('ensureHelper', () => {
  let originalEnv: string | undefined;
  let originalDisable: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalEnv = process.env['LAZYTEST_HELPER_APK_DIR'];
    originalDisable = process.env['LAZYTEST_DISABLE_HELPER'];
    // The vitest config sets this; we need to clear it for these tests so
    // ensureHelper actually runs through the install flow.
    delete process.env['LAZYTEST_DISABLE_HELPER'];

    // Create a temp dir with dummy APK files so findPrebuiltApks succeeds.
    tempDir = mkdtempSync(join(tmpdir(), 'lazytest-helper-test-'));
    writeFileSync(join(tempDir, HELPER.MAIN_APK_FILENAME), 'dummy main apk');
    writeFileSync(join(tempDir, HELPER.TEST_APK_FILENAME), 'dummy test apk');
    process.env['LAZYTEST_HELPER_APK_DIR'] = tempDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['LAZYTEST_HELPER_APK_DIR'];
    } else {
      process.env['LAZYTEST_HELPER_APK_DIR'] = originalEnv;
    }
    if (originalDisable !== undefined) {
      process.env['LAZYTEST_DISABLE_HELPER'] = originalDisable;
    }
  });

  it('returns null immediately when LAZYTEST_DISABLE_HELPER=1', async () => {
    process.env['LAZYTEST_DISABLE_HELPER'] = '1';
    const shell = new MockShellExecutor();
    const handle = await ensureHelper(shell, 'emulator-5554');
    expect(handle).toBeNull();
    // No commands should have been executed.
    expect(shell.getCalls()).toHaveLength(0);
  });

  it('returns null when prebuilt APKs are missing', async () => {
    delete process.env['LAZYTEST_HELPER_APK_DIR'];
    process.env['LAZYTEST_HELPER_APK_DIR'] = '/nonexistent/path';
    const shell = new MockShellExecutor();
    const handle = await ensureHelper(shell, 'emulator-5554');
    expect(handle).toBeNull();
  });

  it('checks installed packages and gracefully fails if instrument spawn errors', async () => {
    // Simulate: helper not installed → install both APKs → forward port →
    // attempt to spawn am instrument (which will fail because adb isn't on
    // PATH in CI). The function should return null on spawn failure, not
    // throw.
    const shell = new MockShellExecutor()
      .when('pm list packages com.lazytest.helper.test', '')
      .when(/pm list packages com\.lazytest\.helper(?!\.test)/, '')
      .when('install -r -t', 'Success')
      .when('forward tcp:', '')
      .when('forward --remove', '');

    // Mock fetch so /status calls fail (helper isn't really running).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    try {
      const handle = await ensureHelper(shell, 'emulator-5554', { startupTimeoutMs: 200 });
      // The instrumentation child process can't reach a real device, the
      // /status poll fails, and ensureHelper returns null.
      expect(handle).toBeNull();
      // It should have tried to install both APKs.
      const installCalls = shell.getCallsMatching('install -r -t');
      expect(installCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 10_000);

  it('skips reinstall when correct version already installed', async () => {
    const shell = new MockShellExecutor()
      // Both packages installed
      .when('pm list packages com.lazytest.helper.test', 'package:com.lazytest.helper.test')
      .when(/pm list packages com\.lazytest\.helper(?!\.test)/, 'package:com.lazytest.helper')
      .when('dumpsys package com.lazytest.helper', `versionCode=${HELPER.MIN_VERSION_CODE} ...`)
      .when('forward tcp:', '')
      .when('forward --remove', '');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    try {
      await ensureHelper(shell, 'emulator-5554', { startupTimeoutMs: 200 });
      // Should not have called install.
      expect(shell.getCallsMatching('install -r -t')).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 10_000);

  it('reinstalls when device version is older', async () => {
    const shell = new MockShellExecutor()
      .when('pm list packages com.lazytest.helper.test', 'package:com.lazytest.helper.test')
      .when(/pm list packages com\.lazytest\.helper(?!\.test)/, 'package:com.lazytest.helper')
      .when('dumpsys package com.lazytest.helper', 'versionCode=0 minSdk=24')
      .when('uninstall ', 'Success')
      .when('install -r -t', 'Success')
      .when('forward tcp:', '')
      .when('forward --remove', '');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    try {
      await ensureHelper(shell, 'emulator-5554', { startupTimeoutMs: 200 });
      // Should have uninstalled the stale pair and reinstalled.
      expect(shell.getCallsMatching('uninstall ').length).toBeGreaterThanOrEqual(2);
      expect(shell.getCallsMatching('install -r -t').length).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 10_000);
});
