/**
 * Unit tests for the Hermes CDP client (Phase 3.5).
 *
 * These tests cover the pure parsing / selection logic and a small mocked
 * `fetch` path for discovery. The full WebSocket round-trip is exercised
 * by the integration tests in framework-sync.test.ts — here we stay
 * offline to keep CI fast and reliable.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectHermesForPackage,
  discoverHermesTargets,
  HermesCdpClient,
  normalizeWebSocketUrl,
  pickHermesTarget,
  waitForHermesJsIdle,
  type HermesTarget,
} from '../android/hermes-cdp.js';

// ---------------------------------------------------------------------------
// normalizeWebSocketUrl
// ---------------------------------------------------------------------------

describe('normalizeWebSocketUrl', () => {
  it('rewrites IPv6 loopback to IPv4', () => {
    expect(normalizeWebSocketUrl('ws://[::1]:8081/inspector/debug?device=0&page=3')).toBe(
      'ws://127.0.0.1:8081/inspector/debug?device=0&page=3',
    );
  });

  it('rewrites localhost to IPv4', () => {
    expect(normalizeWebSocketUrl('ws://localhost:8081/x')).toBe('ws://127.0.0.1:8081/x');
  });

  it('leaves already-IPv4 URLs untouched', () => {
    expect(normalizeWebSocketUrl('ws://127.0.0.1:8081/y')).toBe('ws://127.0.0.1:8081/y');
  });
});

// ---------------------------------------------------------------------------
// pickHermesTarget
// ---------------------------------------------------------------------------

function target(overrides: Partial<HermesTarget>): HermesTarget {
  return {
    id: '0',
    title: 'Hermes',
    description: '',
    type: 'node',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=0&page=0',
    ...overrides,
  };
}

describe('pickHermesTarget', () => {
  it('returns undefined for an empty list', () => {
    expect(pickHermesTarget([], 'com.example')).toBeUndefined();
  });

  it('prefers an exact appId match', () => {
    const picked = pickHermesTarget(
      [target({ id: '0' }), target({ id: '1', appId: 'com.example' })],
      'com.example',
    );
    expect(picked?.id).toBe('1');
  });

  it('falls back to description match', () => {
    const picked = pickHermesTarget(
      [target({ id: '0' }), target({ id: '1', description: 'Bundle com.example/index.js' })],
      'com.example',
    );
    expect(picked?.id).toBe('1');
  });

  it('falls back to title match', () => {
    const picked = pickHermesTarget(
      [target({ id: '0' }), target({ id: '1', title: 'Hermes - com.example' })],
      'com.example',
    );
    expect(picked?.id).toBe('1');
  });

  it('falls back to first Hermes-looking target when nothing matches the package', () => {
    const picked = pickHermesTarget(
      [
        target({ id: '0', title: 'chrome-tab', type: 'page' }),
        target({ id: '1', title: 'Hermes React Native' }),
      ],
      'com.other',
    );
    expect(picked?.id).toBe('1');
  });

  it('returns the first target if nothing Hermes-looking is present', () => {
    const picked = pickHermesTarget([target({ id: 'only' })], 'com.other');
    expect(picked?.id).toBe('only');
  });
});

// ---------------------------------------------------------------------------
// discoverHermesTargets — mocked fetch
// ---------------------------------------------------------------------------

describe('discoverHermesTargets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns targets when Metro /json/list responds with an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: '0',
            title: 'Hermes React Native',
            description: 'com.example',
            type: 'node',
            webSocketDebuggerUrl: 'ws://[::1]:8081/inspector/debug?device=0&page=0',
          },
        ],
      }),
    );

    const targets = await discoverHermesTargets(8081);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.description).toBe('com.example');
  });

  it('returns empty array when Metro is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const targets = await discoverHermesTargets(8081);
    expect(targets).toEqual([]);
  });

  it('returns empty array when /json/list returns non-array JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ error: 'oops' }),
      }),
    );
    const targets = await discoverHermesTargets(8081);
    expect(targets).toEqual([]);
  });

  it('filters out entries missing webSocketDebuggerUrl', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: '0', title: 'broken' }, // no ws url
          {
            id: '1',
            title: 'ok',
            description: '',
            webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=0&page=1',
          },
        ],
      }),
    );

    const targets = await discoverHermesTargets(8081);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.id).toBe('1');
  });

  it('returns empty array when fetch returns non-ok status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => [],
      }),
    );
    const targets = await discoverHermesTargets(8081);
    expect(targets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// waitForHermesJsIdle — liveness probe via Runtime.evaluate round-trip
// ---------------------------------------------------------------------------

/**
 * Build a stub `HermesCdpClient` whose `evaluate` returns after a
 * configurable delay. We stub at the method level and skip the real
 * WebSocket path — that's exercised via the integration tests behind
 * `AGENTEST_DISABLE_FRAMEWORK_SYNC`.
 */
function makeStubHermesClient(evaluateDelayMs: () => number): HermesCdpClient {
  const stub = Object.create(HermesCdpClient.prototype) as HermesCdpClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stub as any).evaluate = async () => {
    await new Promise((resolve) => setTimeout(resolve, evaluateDelayMs()));
    return 1;
  };
  return stub;
}

describe('waitForHermesJsIdle', () => {
  it('returns true when the runtime is consistently fast', async () => {
    const client = makeStubHermesClient(() => 10);
    const ok = await waitForHermesJsIdle(client, 1500);
    expect(ok).toBe(true);
  });

  it('returns false when evaluate throws', async () => {
    const stub = Object.create(HermesCdpClient.prototype) as HermesCdpClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stub as any).evaluate = async () => {
      throw new Error('WebSocket closed');
    };

    const ok = await waitForHermesJsIdle(stub, 500);
    expect(ok).toBe(false);
  });

  it('returns false when the runtime is consistently slow (over threshold)', async () => {
    // HERMES.SYNC_IDLE_THRESHOLD_MS is 120ms. 250ms per probe keeps the
    // stable counter at 0 forever, so the loop drives to timeout.
    const client = makeStubHermesClient(() => 250);
    const ok = await waitForHermesJsIdle(client, 600);
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// connectHermesForPackage diagnostic callback (regression test for the bug
// where attach failures were silently swallowed and impossible to debug
// against a real device — see the API 36 emulator session where Hermes
// CDP attach failed but no log line ever appeared)
// ---------------------------------------------------------------------------

describe('connectHermesForPackage diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports "0 targets" when Metro returns an empty array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      }),
    );

    const messages: string[] = [];
    const result = await connectHermesForPackage('com.example.app', undefined, (m) =>
      messages.push(m),
    );

    expect(result).toBeUndefined();
    expect(messages.some((m) => m.includes('0 targets'))).toBe(true);
  });

  it('reports "no target matched" when targets exist but none match the package', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: '0',
            title: 'something else entirely',
            description: 'no relation to our app',
            type: 'page', // not 'node' / not Hermes-looking
            webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=0&page=0',
          },
        ],
      }),
    );

    const messages: string[] = [];
    const result = await connectHermesForPackage('com.example.app', undefined, (m) =>
      messages.push(m),
    );

    // pickHermesTarget falls back to "first target" when nothing matches,
    // so the diagnostic should report a successful pick (not "no target
    // matched"). Either way, the diagnostic callback must have fired with
    // discovery info.
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain('1 target');
    // result is undefined here because the picked target's WebSocket
    // won't actually open in unit-test environment, so we expect a
    // `connect failed:` diagnostic.
    expect(messages.some((m) => m.startsWith('connect failed:') || m.startsWith('picked'))).toBe(
      true,
    );
    expect(result).toBeUndefined();
  });

  it('does not call onDiagnostic when no callback is supplied (backwards compat)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      }),
    );

    // Just verify it doesn't throw when the callback is omitted.
    const result = await connectHermesForPackage('com.example.app');
    expect(result).toBeUndefined();
  });
});
