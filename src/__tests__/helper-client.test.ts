/**
 * Unit tests for HelperClient — the TypeScript HTTP client that talks to the
 * on-device helper APK. Uses a mocked global fetch to simulate the device
 * server responses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelperClient } from '../android/helper-client.js';

interface MockResponse {
  status?: number;
  body: unknown;
}

interface RecordedRequest {
  url: string;
  method: string;
  body?: unknown;
}

function installFetchMock(): {
  recorded: RecordedRequest[];
  respond(predicate: (req: RecordedRequest) => MockResponse | undefined): void;
  restore(): void;
} {
  const recorded: RecordedRequest[] = [];
  const handlers: ((req: RecordedRequest) => MockResponse | undefined)[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const req: RecordedRequest = { url, method: init?.method ?? 'GET', body };
    recorded.push(req);

    for (const handler of handlers) {
      const res = handler(req);
      if (res) {
        return new Response(JSON.stringify(res.body), {
          status: res.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ ok: false, error: 'unmatched' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    recorded,
    respond(handler) {
      handlers.push(handler);
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

describe('HelperClient', () => {
  let mock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => {
    mock.restore();
  });

  it('returns null status when fetch fails', async () => {
    mock.restore();
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connection refused');
    }) as typeof fetch;

    const client = new HelperClient(8765);
    const status = await client.status(100);
    expect(status).toBeNull();
  });

  it('parses status response when helper is healthy', async () => {
    mock.respond((req) =>
      req.url.endsWith('/status')
        ? {
            body: {
              ok: true,
              name: 'lazytest-helper',
              version: '1.0.0',
              protocolVersion: 1,
              sdkInt: 34,
              device: 'sdk_gphone64_arm64',
              manufacturer: 'Google',
            },
          }
        : undefined,
    );

    const client = new HelperClient(8765);
    const status = await client.status();
    expect(status).not.toBeNull();
    expect(status?.protocolVersion).toBe(1);
    expect(status?.version).toBe('1.0.0');
  });

  it('waitForReady polls /status until OK', async () => {
    let calls = 0;
    mock.respond((req) => {
      if (!req.url.endsWith('/status')) return undefined;
      calls++;
      if (calls < 3) {
        return { status: 503, body: { ok: false } };
      }
      return {
        body: {
          ok: true,
          name: 'lazytest-helper',
          version: '1.0.0',
          protocolVersion: 1,
          sdkInt: 34,
          device: 'mock',
          manufacturer: 'mock',
        },
      };
    });

    const client = new HelperClient(8765);
    const status = await client.waitForReady(2000, 1);
    expect(status.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('waitForReady throws on protocol version mismatch', async () => {
    mock.respond((req) =>
      req.url.endsWith('/status')
        ? {
            body: {
              ok: true,
              name: 'lazytest-helper',
              version: '0.5.0',
              protocolVersion: 99,
              sdkInt: 34,
              device: 'mock',
              manufacturer: 'mock',
            },
          }
        : undefined,
    );

    const client = new HelperClient(8765);
    await expect(client.waitForReady(1000, 1)).rejects.toThrow(/protocol version mismatch/);
  });

  it('getTree forwards compact parameter', async () => {
    mock.respond((req) =>
      req.url.includes('/tree')
        ? {
            body: {
              ok: true,
              packageName: 'com.example',
              compact: true,
              tree: { class: 'android.widget.FrameLayout', bounds: '[0,0][1080,1920]' },
            },
          }
        : undefined,
    );

    const client = new HelperClient(8765);
    await client.getTree({ compact: true, packageName: 'com.example' });
    const req = mock.recorded[0];
    expect(req?.url).toContain('compact=1');
    expect(req?.url).toContain('package=com.example');
  });

  it('tap POSTs rounded coordinates', async () => {
    mock.respond((req) => (req.url.endsWith('/tap') ? { body: { ok: true } } : undefined));

    const client = new HelperClient(8765);
    await client.tap(123.7, 456.4);
    const req = mock.recorded[0];
    expect(req?.method).toBe('POST');
    expect(req?.body).toEqual({ x: 124, y: 456 });
  });

  it('swipe POSTs all four coordinates and duration', async () => {
    mock.respond((req) => (req.url.endsWith('/swipe') ? { body: { ok: true } } : undefined));

    const client = new HelperClient(8765);
    await client.swipe(100, 200, 300, 400, 500);
    const req = mock.recorded[0];
    expect(req?.body).toEqual({ x1: 100, y1: 200, x2: 300, y2: 400, durationMs: 500 });
  });

  it('typeText POSTs the literal text', async () => {
    mock.respond((req) => (req.url.endsWith('/text') ? { body: { ok: true } } : undefined));

    const client = new HelperClient(8765);
    await client.typeText('hello world');
    const req = mock.recorded[0];
    expect(req?.body).toEqual({ text: 'hello world' });
  });

  it('waitForIdle returns idle:true on success', async () => {
    mock.respond((req) =>
      req.url.includes('/wait-idle')
        ? {
            body: {
              ok: true,
              idle: true,
              reason: 'events_quiet',
              events: ['TYPE_WINDOW_CONTENT_CHANGED'],
            },
          }
        : undefined,
    );

    const client = new HelperClient(8765);
    const result = await client.waitForIdle({ timeoutMs: 100 });
    expect(result.idle).toBe(true);
    expect(result.events).toContain('TYPE_WINDOW_CONTENT_CHANGED');
  });

  it('detectFramework parses primary framework', async () => {
    mock.respond((req) =>
      req.url.includes('/framework')
        ? {
            body: {
              ok: true,
              packageName: 'com.example',
              primary: 'react_native',
              frameworks: ['react_native', 'react_native_hermes'],
              signals: ['lib:libhermes', 'class:com.facebook.react.ReactRootView'],
            },
          }
        : undefined,
    );

    const client = new HelperClient(8765);
    const info = await client.detectFramework('com.example');
    expect(info.primary).toBe('react_native');
    expect(info.frameworks).toContain('react_native_hermes');
  });

  it('shutdown swallows connection-closed errors', async () => {
    mock.restore();
    globalThis.fetch = vi.fn(async () => {
      throw new Error('socket hang up');
    }) as typeof fetch;

    const client = new HelperClient(8765);
    await expect(client.shutdown()).resolves.toBeUndefined();
  });
});
