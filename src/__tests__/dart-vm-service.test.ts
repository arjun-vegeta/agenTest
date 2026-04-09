/**
 * Unit tests for the Dart VM Service client (Phase 3.6 / 3.7).
 *
 * Covers the pure parsing helpers + the logcat discovery path (using
 * MockShellExecutor). The live WebSocket RPC path is exercised by the
 * framework-sync tests behind LAZYTEST_DISABLE_FRAMEWORK_SYNC, so here
 * we only need offline-friendly tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { AdbClient } from '../android/adb.js';
import {
  buildVmWebSocketUrl,
  DartVmServiceClient,
  discoverDartVmUrl,
  ensureFlutterSemantics,
  parseVmServiceUrl,
  waitForFlutterFrameIdle,
} from '../android/dart-vm-service.js';
import { MockShellExecutor } from './mock-shell.js';

// ---------------------------------------------------------------------------
// parseVmServiceUrl
// ---------------------------------------------------------------------------

describe('parseVmServiceUrl', () => {
  it('parses a canonical Flutter VM Service URL', () => {
    const parsed = parseVmServiceUrl('http://127.0.0.1:41717/zUlNllqYu1s=/');
    expect(parsed).toEqual({
      full: 'http://127.0.0.1:41717/zUlNllqYu1s=/',
      devicePort: 41717,
      authCode: 'zUlNllqYu1s=',
    });
  });

  it('handles URLs without a trailing slash', () => {
    const parsed = parseVmServiceUrl('http://127.0.0.1:50642/00wEOvfyff8=');
    expect(parsed?.authCode).toBe('00wEOvfyff8=');
    expect(parsed?.devicePort).toBe(50642);
  });

  it('returns undefined for unparseable input', () => {
    expect(parseVmServiceUrl('not a url')).toBeUndefined();
    expect(parseVmServiceUrl('')).toBeUndefined();
  });

  it('tolerates a missing auth code', () => {
    const parsed = parseVmServiceUrl('http://127.0.0.1:8080/');
    expect(parsed?.devicePort).toBe(8080);
    expect(parsed?.authCode).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildVmWebSocketUrl
// ---------------------------------------------------------------------------

describe('buildVmWebSocketUrl', () => {
  it('includes the auth code when present', () => {
    const url = buildVmWebSocketUrl(
      { full: 'x', devicePort: 41717, authCode: 'zUlNllqYu1s=' },
      8766,
    );
    expect(url).toBe('ws://127.0.0.1:8766/zUlNllqYu1s=/ws');
  });

  it('omits the auth path segment when none was logged', () => {
    const url = buildVmWebSocketUrl({ full: 'x', devicePort: 8080, authCode: '' }, 8766);
    expect(url).toBe('ws://127.0.0.1:8766/ws');
  });

  it('uses a custom host port when supplied', () => {
    const url = buildVmWebSocketUrl({ full: 'x', devicePort: 12345, authCode: 'abc=' }, 9999);
    expect(url).toBe('ws://127.0.0.1:9999/abc=/ws');
  });
});

// ---------------------------------------------------------------------------
// discoverDartVmUrl via logcat
// ---------------------------------------------------------------------------

describe('discoverDartVmUrl', () => {
  it('extracts the URL from a logcat dump', async () => {
    const shell = new MockShellExecutor();
    // pidof returns a pid, logcat returns lines including the discovery message
    shell.when('pidof com.example.flutterapp', '12345');
    shell.when(
      'logcat',
      [
        '04-09 12:34:56.000  12345 12345 I flutter: Running in debug mode.',
        '04-09 12:34:56.100  12345 12345 I flutter: The Dart VM service is listening on http://127.0.0.1:41717/zUlNllqYu1s=/',
        '04-09 12:34:57.000  12345 12345 I flutter: app idle',
      ].join('\n'),
    );

    const adb = new AdbClient(shell);
    const discovery = await discoverDartVmUrl(adb, 'com.example.flutterapp');
    expect(discovery).toBeDefined();
    expect(discovery?.devicePort).toBe(41717);
    expect(discovery?.authCode).toBe('zUlNllqYu1s=');
  });

  it('accepts "The Dart VM Service" (capital S) variant', async () => {
    const shell = new MockShellExecutor();
    shell.when('pidof', '');
    shell.when(
      'logcat',
      'I/flutter: The Dart VM Service is listening on http://127.0.0.1:5555/ABCDEF=/\n',
    );

    const adb = new AdbClient(shell);
    const discovery = await discoverDartVmUrl(adb, 'com.example.app');
    expect(discovery?.devicePort).toBe(5555);
  });

  it('returns undefined when no URL is present in logs', async () => {
    const shell = new MockShellExecutor();
    shell.when('pidof', '');
    shell.when('logcat', 'nothing interesting here\n');

    const adb = new AdbClient(shell);
    const discovery = await discoverDartVmUrl(adb, 'com.example.app');
    expect(discovery).toBeUndefined();
  });

  it('returns undefined when logcat fails entirely', async () => {
    const shell = new MockShellExecutor();
    // no responses registered → exec throws, and getAppLogs bubbles that up

    const adb = new AdbClient(shell);
    const discovery = await discoverDartVmUrl(adb, 'com.example.app');
    expect(discovery).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ensureFlutterSemantics — retry + service extension only (regression test
// for the bug where a prior version passed targetId: isolateId to the
// `evaluate` RPC, which the VM Service rejects with "invalid targetId")
// ---------------------------------------------------------------------------

/**
 * Build a stub `DartVmServiceClient` whose `callExtension` returns a
 * scripted sequence of resolve/reject outcomes. We avoid touching the
 * real WebSocket path entirely — that's already exercised by the other
 * tests at the parsing layer.
 */
function makeStubClient(extensionResponses: (() => Promise<unknown>)[]): DartVmServiceClient {
  let call = 0;
  const stub = Object.create(DartVmServiceClient.prototype) as DartVmServiceClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stub as any).callExtension = async () => {
    const responder = extensionResponses[Math.min(call, extensionResponses.length - 1)];
    call += 1;
    if (!responder) return {};
    return responder();
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stub as any).getVm = async () => ({ type: 'VM', isolates: [{ id: 'isolates/1' }] });
  return stub;
}

describe('ensureFlutterSemantics', () => {
  it('returns true on the first successful callExtension', async () => {
    const client = makeStubClient([() => Promise.resolve({ ok: true })]);
    const ok = await ensureFlutterSemantics(client, 'isolates/1');
    expect(ok).toBe(true);
  });

  it('retries when the extension is not yet registered', async () => {
    const client = makeStubClient([
      () => Promise.reject(new Error('Dart VM RPC error -32601: method not found')),
      () => Promise.reject(new Error('Dart VM RPC error -32601: method not found')),
      () => Promise.resolve({ ok: true }),
    ]);
    const ok = await ensureFlutterSemantics(client, 'isolates/1');
    expect(ok).toBe(true);
  });

  it('returns false after all retry attempts fail', async () => {
    const client = makeStubClient([() => Promise.reject(new Error('not registered'))]);
    const ok = await ensureFlutterSemantics(client, 'isolates/1');
    expect(ok).toBe(false);
  });

  it('never attempts to use the `evaluate` RPC (regression for targetId bug)', async () => {
    // If ensureFlutterSemantics regresses to calling `evaluate` with
    // targetId=isolateId, the bug surfaces only against a real VM Service.
    // We guard against that by ensuring the stub's `call` method is never
    // invoked — only `callExtension` is allowed.
    const client = makeStubClient([() => Promise.reject(new Error('boom'))]);
    const callSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).call = callSpy;

    await ensureFlutterSemantics(client, 'isolates/1');
    expect(callSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// waitForFlutterFrameIdle — liveness probe via getVM round-trip
// ---------------------------------------------------------------------------

describe('waitForFlutterFrameIdle', () => {
  it('returns true after N fast getVM responses', async () => {
    const stub = Object.create(DartVmServiceClient.prototype) as DartVmServiceClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stub as any).getVm = async () => ({ type: 'VM', isolates: [{ id: 'isolates/1' }] });

    const ok = await waitForFlutterFrameIdle(stub, 'isolates/1', 1000);
    expect(ok).toBe(true);
  });

  it('returns false when getVM throws repeatedly (VM unresponsive)', async () => {
    const stub = Object.create(DartVmServiceClient.prototype) as DartVmServiceClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stub as any).getVm = async () => {
      throw new Error('WebSocket closed');
    };

    const ok = await waitForFlutterFrameIdle(stub, 'isolates/1', 250);
    expect(ok).toBe(false);
  });

  it('returns false when getVM round-trip exceeds the threshold', async () => {
    const stub = Object.create(DartVmServiceClient.prototype) as DartVmServiceClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stub as any).getVm = async () => {
      // Sleep long enough that SYNC_IDLE_THRESHOLD_MS (150ms) is blown past.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { type: 'VM', isolates: [] };
    };

    const ok = await waitForFlutterFrameIdle(stub, 'isolates/1', 800);
    expect(ok).toBe(false);
  });
});
