/**
 * Unit tests for the opt-in LazyTest Idling Bridge (Phase 3.10).
 *
 * Covers AdbClient.queryIdlingBridge parsing and the `FrameworkSync.attach`
 * opt-in detection path. The Kotlin side is tested separately via the
 * android-helper Gradle project (no JVM tests in Node, but the ContentProvider
 * shape matches what the parser here expects).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { AdbClient } from '../android/adb.js';
import { FrameworkSync } from '../android/framework-sync.js';
import { MockShellExecutor } from './mock-shell.js';

describe('AdbClient.queryIdlingBridge', () => {
  it('parses a non-idle row from `content query`', async () => {
    const shell = new MockShellExecutor();
    shell.when(
      'content query --uri content://com.example.app.lazytest.idling/state',
      'Row: 0 idle_count=2, idle_names=NetworkIdling,DbIdling, version=1\n',
    );

    const adb = new AdbClient(shell);
    const result = await adb.queryIdlingBridge('com.example.app');
    expect(result).toEqual({
      idleCount: 2,
      busy: ['NetworkIdling', 'DbIdling'],
      version: 1,
    });
  });

  it('parses an idle row (no busy resources)', async () => {
    const shell = new MockShellExecutor();
    shell.when('content query', 'Row: 0 idle_count=0, idle_names=, version=1\n');
    const adb = new AdbClient(shell);
    const result = await adb.queryIdlingBridge('com.example.app');
    expect(result).toEqual({ idleCount: 0, busy: [], version: 1 });
  });

  it('exposes the wire version from the cursor', async () => {
    const shell = new MockShellExecutor();
    shell.when('content query', 'Row: 0 idle_count=0, idle_names=, version=7\n');
    const adb = new AdbClient(shell);
    const result = await adb.queryIdlingBridge('com.example.app');
    expect(result?.version).toBe(7);
  });

  it('returns null when the provider is unregistered', async () => {
    const shell = new MockShellExecutor();
    shell.when('content query', 'No result found.\n');
    const adb = new AdbClient(shell);
    const result = await adb.queryIdlingBridge('com.example.app');
    expect(result).toBeNull();
  });

  it('returns null on shell failure', async () => {
    const shell = new MockShellExecutor();
    // no response registered → exec throws
    const adb = new AdbClient(shell);
    const result = await adb.queryIdlingBridge('com.example.app');
    expect(result).toBeNull();
  });

  it('returns null when row shape is malformed', async () => {
    const shell = new MockShellExecutor();
    shell.when('content query', 'Row: 0 something=else\n');
    const adb = new AdbClient(shell);
    const result = await adb.queryIdlingBridge('com.example.app');
    expect(result).toBeNull();
  });

  it('builds the correct authority URI from the package name', async () => {
    const shell = new MockShellExecutor();
    shell.when(/content query/, 'Row: 0 idle_count=0, idle_names=, version=1\n');
    const adb = new AdbClient(shell);
    await adb.queryIdlingBridge('com.test.foo');
    const calls = shell.getCalls();
    expect(calls.some((c) => c.includes('content://com.test.foo.lazytest.idling/state'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// FrameworkSync opt-in bridge detection
// ---------------------------------------------------------------------------

describe('FrameworkSync + idling bridge', () => {
  const prevDisable = process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'];
  afterAll(() => {
    if (prevDisable === undefined) delete process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'];
    else process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'] = prevDisable;
  });

  it('attaches when the idling bridge ContentProvider exists', async () => {
    // Make sure other sync channels are neutralized for this test.
    delete process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'];

    const shell = new MockShellExecutor();
    shell.when('content query', 'Row: 0 idle_count=0, idle_names=, version=1\n');
    const adb = new AdbClient(shell);
    const sync = new FrameworkSync({
      framework: 'native',
      packageName: 'com.example.native',
      adb,
    });
    await sync.attach();
    expect(sync.hasIdlingBridge).toBe(true);
    expect(sync.hasBackend).toBe(true);
    sync.close();
  });

  it('hasBackend is false when no bridge is present and framework is native', async () => {
    delete process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'];

    const shell = new MockShellExecutor();
    // content query throws → queryIdlingBridge returns null
    const adb = new AdbClient(shell);
    const sync = new FrameworkSync({
      framework: 'native',
      packageName: 'com.example.native',
      adb,
    });
    await sync.attach();
    expect(sync.hasIdlingBridge).toBe(false);
    expect(sync.hasBackend).toBe(false);
    sync.close();
  });

  it('attach is a no-op when LAZYTEST_DISABLE_FRAMEWORK_SYNC=1', async () => {
    process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'] = '1';

    const shell = new MockShellExecutor();
    // Register a bridge response that would attach if the env var were not set.
    shell.when('content query', 'Row: 0 idle_count=0, idle_names=, version=1\n');

    const adb = new AdbClient(shell);
    const sync = new FrameworkSync({
      framework: 'react_native',
      packageName: 'com.example.app',
      adb,
    });
    await sync.attach();
    expect(sync.hasIdlingBridge).toBe(false);
    expect(sync.hasBackend).toBe(false);
    expect(shell.getCalls().length).toBe(0);
    sync.close();
  });
});

// ---------------------------------------------------------------------------
// Stale-bridge warning: catches the "user updated LazyTest but forgot to
// rebuild their Android app" case so Claude can tell them to rebuild.
// ---------------------------------------------------------------------------

describe('FrameworkSync.idlingBridgeWarning', () => {
  const prevDisable = process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'];
  afterAll(() => {
    if (prevDisable === undefined) delete process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'];
    else process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'] = prevDisable;
  });

  it('returns undefined when the bridge is absent', async () => {
    delete process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'];
    const shell = new MockShellExecutor();
    const adb = new AdbClient(shell);
    const sync = new FrameworkSync({
      framework: 'native',
      packageName: 'com.example.app',
      adb,
    });
    await sync.attach();
    expect(sync.idlingBridgeWarning).toBeUndefined();
    sync.close();
  });

  it('returns undefined when the device bridge version matches the expected version', async () => {
    delete process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'];
    const shell = new MockShellExecutor();
    shell.when('content query', 'Row: 0 idle_count=0, idle_names=, version=1\n');
    const adb = new AdbClient(shell);
    const sync = new FrameworkSync({
      framework: 'native',
      packageName: 'com.example.app',
      adb,
    });
    await sync.attach();
    expect(sync.idlingBridgeWarning).toBeUndefined();
    sync.close();
  });

  it('returns an actionable rebuild command when the device bridge is older', async () => {
    delete process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'];
    const shell = new MockShellExecutor();
    // Pretend the device has an older wire version than expected (1).
    // Version 0 is an impossible-in-practice value that stays < any future
    // EXPECTED_WIRE_VERSION, so this test doesn't need updating when the
    // expected version is bumped later.
    shell.when('content query', 'Row: 0 idle_count=0, idle_names=, version=0\n');
    const adb = new AdbClient(shell);
    const sync = new FrameworkSync({
      framework: 'native',
      packageName: 'com.example.app',
      adb,
    });
    await sync.attach();
    const warning = sync.idlingBridgeWarning;
    expect(warning).toBeDefined();
    // Must surface both the out-of-date status AND the actionable rebuild command.
    expect(warning).toContain('out of date');
    expect(warning).toContain('./gradlew :app:assembleDebug');
    sync.close();
  });

  it('also warns when the device bridge is newer than expected', async () => {
    // Reverse scenario: user rebuilt their app with a dev/beta AAR that's
    // ahead of the shipping LazyTest npm package. Still a mismatch worth
    // flagging — the LLM should tell them to `npm update lazytest`.
    delete process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'];
    const shell = new MockShellExecutor();
    shell.when('content query', 'Row: 0 idle_count=0, idle_names=, version=99\n');
    const adb = new AdbClient(shell);
    const sync = new FrameworkSync({
      framework: 'native',
      packageName: 'com.example.app',
      adb,
    });
    await sync.attach();
    expect(sync.idlingBridgeWarning).toBeDefined();
    sync.close();
  });
});
