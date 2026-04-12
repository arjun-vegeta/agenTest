/**
 * HTTP client for the on-device AgenTest helper APK.
 *
 * The helper exposes UiAutomation primitives over a localhost HTTP server.
 * Reaches it via `adb forward` — the host port is mapped to the device port,
 * so this client just hits `http://127.0.0.1:<hostPort>/...`.
 *
 * Designed to mirror the AdbClient input/tree API so DeviceClient can route
 * to it as a third backend (helper > grpc > adb for trees and idle, gRPC
 * still preferred for input on emulators because it's host-side).
 */

import { HELPER } from '../constants.js';
import { AdbCommandError } from '../errors.js';

export interface HelperStatus {
  ok: boolean;
  name: string;
  version: string;
  protocolVersion: number;
  sdkInt: number;
  device: string;
  manufacturer: string;
}

export interface HelperFrameworkInfo {
  ok: boolean;
  packageName: string;
  primary: 'flutter' | 'react_native' | 'compose' | 'native';
  frameworks: string[];
  signals: string[];
}

export interface HelperIdleResult {
  ok: boolean;
  idle: boolean;
  reason: string;
  events: string[];
}

/** Generic JSON envelope for unknown responses. */
export type HelperJson = Record<string, unknown>;

export class HelperClient {
  private readonly baseUrl: string;

  constructor(
    hostPort: number,
    private readonly defaultTimeoutMs: number = HELPER.REQUEST_TIMEOUT_MS,
  ) {
    this.baseUrl = `http://127.0.0.1:${hostPort}`;
  }

  // ----- Health ----------------------------------------------------------

  /** Probe `/status`. Returns null if the helper is unreachable. */
  async status(timeoutMs?: number): Promise<HelperStatus | null> {
    try {
      const json = await this.request<HelperStatus>('GET', '/status', undefined, timeoutMs);
      return json;
    } catch {
      return null;
    }
  }

  /**
   * Wait for the helper /status endpoint to become healthy.
   *
   * Polls every HELPER.STARTUP_POLL_MS until either /status returns ok or the
   * timeout fires. Used by the installer right after `am instrument` is fired.
   */
  async waitForReady(
    timeoutMs: number = HELPER.STARTUP_TIMEOUT_MS,
    expectedProtocolVersion: number = HELPER.EXPECTED_PROTOCOL_VERSION,
  ): Promise<HelperStatus> {
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | undefined;
    while (Date.now() < deadline) {
      try {
        const status = await this.request<HelperStatus>(
          'GET',
          '/status',
          undefined,
          HELPER.STARTUP_POLL_MS * 4,
        );
        if (status.ok && status.protocolVersion === expectedProtocolVersion) {
          return status;
        }
        if (status.ok) {
          throw new Error(
            `Helper protocol version mismatch: device=${status.protocolVersion}, expected=${expectedProtocolVersion}`,
          );
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      await sleep(HELPER.STARTUP_POLL_MS);
    }
    throw new AdbCommandError(
      `AgenTest helper did not come up within ${timeoutMs}ms${lastError ? ': ' + lastError.message : ''}`,
      'helper /status',
    );
  }

  // ----- Tree -----------------------------------------------------------

  /**
   * Dump the UI tree as JSON via UiAutomation. Returns the raw helper
   * response so callers can choose between compact (LLM) and full formats.
   */
  async getTree(opts: { compact?: boolean; packageName?: string } = {}): Promise<HelperJson> {
    const params = new URLSearchParams();
    if (opts.compact) params.set('compact', '1');
    if (opts.packageName) params.set('package', opts.packageName);
    const path = params.toString() ? `/tree?${params.toString()}` : '/tree';
    return this.request<HelperJson>('GET', path);
  }

  // ----- Framework detection --------------------------------------------

  async detectFramework(packageName?: string): Promise<HelperFrameworkInfo> {
    const path = packageName
      ? `/framework?package=${encodeURIComponent(packageName)}`
      : '/framework';
    return this.request<HelperFrameworkInfo>('GET', path);
  }

  // ----- Idle detection -------------------------------------------------

  async waitForIdle(
    opts: { timeoutMs?: number; packageName?: string } = {},
  ): Promise<HelperIdleResult> {
    const timeoutMs = opts.timeoutMs ?? HELPER.WAIT_IDLE_TIMEOUT_MS;
    const params = new URLSearchParams();
    params.set('timeoutMs', String(timeoutMs));
    if (opts.packageName) params.set('package', opts.packageName);
    return this.request<HelperIdleResult>(
      'GET',
      `/wait-idle?${params.toString()}`,
      undefined,
      // HTTP client timeout has to be longer than the device-side wait or
      // we'll abort before the helper gets a chance to respond.
      timeoutMs + 5_000,
    );
  }

  // ----- Screenshot -----------------------------------------------------

  async screenshot(): Promise<string> {
    const result = await this.request<{ ok: boolean; format: string; base64: string }>(
      'GET',
      '/screenshot',
      undefined,
      HELPER.REQUEST_TIMEOUT_MS * 2,
    );
    return result.base64;
  }

  // ----- Input ----------------------------------------------------------

  async tap(x: number, y: number): Promise<void> {
    await this.request('POST', '/tap', { x: Math.round(x), y: Math.round(y) });
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.request('POST', '/swipe', {
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      durationMs,
    });
  }

  async longPress(x: number, y: number, durationMs: number): Promise<void> {
    await this.request('POST', '/long-press', {
      x: Math.round(x),
      y: Math.round(y),
      durationMs,
    });
  }

  async key(keycode: number): Promise<void> {
    await this.request('POST', '/key', { keycode });
  }

  async typeText(text: string): Promise<void> {
    await this.request('POST', '/text', { text });
  }

  async shutdown(): Promise<void> {
    try {
      await this.request('POST', '/shutdown', {});
    } catch {
      // The server tears down its socket as it acks; the request often fails
      // with "connection closed" — that's success, not failure.
    }
  }

  // ----- Internal -------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.defaultTimeoutMs);
    try {
      const init: RequestInit = {
        method,
        signal: ctrl.signal,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      };
      const res = await fetch(`${this.baseUrl}${path}`, init);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Helper ${method} ${path} -> ${res.status}: ${text}`);
      }
      if (text.length === 0) {
        return {} as T;
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
