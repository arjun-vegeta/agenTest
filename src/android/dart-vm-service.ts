/**
 * Flutter Dart VM Service client — debug/profile build sync backend
 * (Phase 3.6 / 3.7).
 *
 * Flutter's VM Service (historically "Observatory") is a JSON-RPC 2.0
 * WebSocket endpoint exposed by debug and profile builds. We use it for:
 *
 *   1. Sync: `ext.flutter.inspector.*` + scheduler state lets us know when
 *      the engine is done rendering, so `waitForIdle` can declare done
 *      immediately instead of polling the a11y tree.
 *   2. Forcing semantics: Flutter apps without `ensureSemantics()` render to
 *      an opaque texture — the a11y tree is empty. We call the VM Service
 *      to flip the bit, populating the tree so our existing scraper works.
 *
 * Discovery on Android:
 *   Debug+profile builds log `The Dart VM service is listening on
 *   http://127.0.0.1:<port>/<authCode>/` on startup. We grep logcat for
 *   this pattern, `adb forward` the port to the host, and connect over
 *   WebSocket at `ws://127.0.0.1:<hostPort>/<authCode>/ws`.
 *
 * Release builds: the VM Service is excluded by the Flutter tool — every
 * failure here is non-fatal and the caller silently falls through.
 */

import WebSocket from 'ws';
import { FLUTTER_VM } from '../constants.js';
import type { AdbClient } from './adb.js';

// See `hermes-cdp.ts` header for why we use `ws` instead of the global
// WebSocket: Node 20 (current LTS) only has global `fetch`, not global
// `WebSocket` — that was added in v21. The `ws` package is the de facto
// Node WebSocket client and works on every Node ≥16.

export interface DartVmServiceUrl {
  /** Full URL as logged by Flutter, e.g. `http://127.0.0.1:41717/zUlNllqYu1s=/` */
  full: string;
  /** Device-side port extracted from the URL. */
  devicePort: number;
  /** Auth token path segment (may be empty if the build uses no auth). */
  authCode: string;
}

/**
 * Parse a logged VM Service URL into components.
 *
 * Expected shape: `http://host:port/<authCode>/` — authCode is typically a
 * base64-ish token ending in `=`. We tolerate missing trailing slashes.
 */
export function parseVmServiceUrl(url: string): DartVmServiceUrl | undefined {
  const match = /^https?:\/\/([^:/]+):(\d+)(?:\/([^/]*))?\/?/.exec(url);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (!Number.isFinite(port)) return undefined;
  return {
    full: url,
    devicePort: port,
    authCode: match[3] ?? '',
  };
}

/**
 * Discover a Flutter VM Service URL for the given package by scraping logcat.
 *
 * Scans recent logcat lines for the well-known "The Dart VM service is
 * listening on ..." message. The pattern is stable across Flutter 2.x / 3.x
 * and is the canonical way to discover the port — see flutter/flutter #134307
 * and appium-flutter-driver for prior art.
 *
 * Returns undefined if:
 *  - logcat fails (no device, permissions)
 *  - no URL was logged (release build or the app hasn't started yet)
 */
export async function discoverDartVmUrl(
  adb: AdbClient,
  packageName: string,
): Promise<DartVmServiceUrl | undefined> {
  let logs: string;
  try {
    logs = await adb.getAppLogs(packageName, FLUTTER_VM.DISCOVERY_MAX_LINES);
  } catch {
    return undefined;
  }

  const match = FLUTTER_VM.LOGCAT_DISCOVERY_REGEX.exec(logs);
  if (!match || !match[1]) return undefined;

  return parseVmServiceUrl(match[1]);
}

/**
 * Build the host-side WebSocket URL that reaches the device's VM Service
 * after `adb forward tcp:<hostPort> tcp:<devicePort>` is in place.
 *
 * The Dart VM Service WebSocket endpoint is `ws://host:port/<authCode>/ws`.
 * Trailing slash on the authCode is tolerated but we don't emit one.
 */
export function buildVmWebSocketUrl(
  discovery: DartVmServiceUrl,
  hostPort: number = FLUTTER_VM.HOST_PORT,
): string {
  const base = `ws://127.0.0.1:${hostPort}`;
  return discovery.authCode ? `${base}/${discovery.authCode}/ws` : `${base}/ws`;
}

// ---------------------------------------------------------------------------
// JSON-RPC client
// ---------------------------------------------------------------------------

interface RpcPending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Tiny JSON-RPC 2.0 client for the Dart VM Service. Supports only the
 * synchronous request/reply calls we actually use — no stream subscriptions.
 */
export class DartVmServiceClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, RpcPending>();
  private closed = false;

  constructor(private readonly wsUrl: string) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise<void>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not initialized'));
        return;
      }
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err: Error) =>
        reject(new Error(`Failed to connect to Dart VM Service at ${this.wsUrl}: ${err.message}`)),
      );
    });
    if (!this.ws) throw new Error('WebSocket vanished after open');
    // `ws` emits `message` with a Node Buffer argument, not a MessageEvent.
    // Decode to UTF-8 string here so the rest of the JSON-RPC plumbing
    // stays identical to the browser-WebSocket path.
    this.ws.on('message', (data: Buffer) => this.onMessage(data.toString('utf-8')));
    this.ws.on('close', () => this.onClose());
    // Mid-session errors: fold into onClose so pending RPCs reject promptly
    // instead of waiting for their individual timeouts to fire.
    this.ws.on('error', () => this.onClose());
  }

  /**
   * Invoke a service method with params and await its result.
   *
   * For `ext.flutter.*` extensions, pass the full extension name as `method`
   * and include `isolateId` in params.
   */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || this.closed) {
      throw new Error('Dart VM Service client is not connected');
    }
    const id = this.nextId++;
    const payload: RpcMessage = { jsonrpc: '2.0', id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Dart VM Service: ${method} timed out after ${FLUTTER_VM.RPC_REPLY_TIMEOUT_MS}ms`,
          ),
        );
      }, FLUTTER_VM.RPC_REPLY_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws?.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Fetch the VM info — used to discover isolate IDs. */
  async getVm(): Promise<VmInfo> {
    const result = (await this.call('getVM')) as VmInfo;
    return result;
  }

  /** Return the id of the first non-system isolate, or undefined. */
  async getFirstIsolateId(): Promise<string | undefined> {
    const vm = await this.getVm();
    const isolate = (vm.isolates ?? [])[0];
    return isolate?.id;
  }

  /**
   * Call a Flutter extension method that requires an isolateId. Common
   * examples: `ext.flutter.debugDumpSemanticsTreeInTraversalOrder`,
   * `ext.flutter.inspector.getRootWidget`, `ext.flutter.reassemble`.
   */
  async callExtension(
    isolateId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const res = (await this.call(method, { isolateId, ...params })) as Record<string, unknown>;
    return res;
  }

  private onMessage(data: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(data) as RpcMessage;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return; // ignore notifications
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`Dart VM RPC error ${msg.error.code}: ${msg.error.message}`));
      return;
    }
    pending.resolve(msg.result ?? {});
  }

  private onClose(): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Dart VM Service WebSocket closed'));
    }
    this.pending.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Dart VM Service client closed'));
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Public types (subset of the VM Service protocol we care about)
// ---------------------------------------------------------------------------

export interface VmInfo {
  type: string;
  name?: string;
  isolates?: { id: string; name?: string }[];
}

// ---------------------------------------------------------------------------
// High-level helpers
// ---------------------------------------------------------------------------

/**
 * End-to-end connect: discover from logcat, forward the port, open the
 * WebSocket, and return a ready client. Returns undefined on any failure so
 * callers can fall through to the helper's a11y-based idle path.
 *
 * Cleans up `adb forward` on every failure path so repeated attach attempts
 * don't leak stale port mappings across sessions.
 *
 * Retries `getFirstIsolateId` because a freshly-started Flutter isolate can
 * briefly return an empty isolates list from `getVM` before main() runs.
 */
export async function connectDartVmServiceFor(
  adb: AdbClient,
  packageName: string,
  hostPort: number = FLUTTER_VM.HOST_PORT,
): Promise<{ client: DartVmServiceClient; isolateId: string } | undefined> {
  const discovery = await discoverDartVmUrl(adb, packageName);
  if (!discovery) return undefined;

  // Set up adb forward host -> device. Best-effort cleanup first in case a
  // previous agentest session left a stale forward on this host port.
  try {
    await adb.removeForward(hostPort);
  } catch {
    // ignore
  }
  try {
    await adb.forwardPort(hostPort, discovery.devicePort);
  } catch {
    return undefined;
  }

  // Helper: release the forward before we bail, so back-to-back attach
  // failures don't accumulate dead mappings in adbd.
  const bail = async (): Promise<undefined> => {
    try {
      await adb.removeForward(hostPort);
    } catch {
      // ignore
    }
    return undefined;
  };

  const wsUrl = buildVmWebSocketUrl(discovery, hostPort);
  const client = new DartVmServiceClient(wsUrl);
  try {
    await client.connect();
  } catch {
    return bail();
  }

  // Retry getFirstIsolateId — fresh Flutter apps can report an empty
  // isolates list for ~100-500ms during startup (the VM service binds
  // before main() is reached). Give it up to ~750ms before bailing.
  let isolateId: string | undefined;
  for (let attempt = 0; attempt < FLUTTER_VM.ISOLATE_DISCOVERY_ATTEMPTS; attempt++) {
    try {
      isolateId = await client.getFirstIsolateId();
    } catch {
      client.close();
      return bail();
    }
    if (isolateId) break;
    await sleep(FLUTTER_VM.ISOLATE_DISCOVERY_POLL_MS);
  }

  if (!isolateId) {
    client.close();
    return bail();
  }
  return { client, isolateId };
}

/**
 * Force the Flutter semantics tree to be built so the on-device helper's
 * a11y scraper sees a populated tree instead of an opaque FlutterView.
 *
 * Strategy: call the canonical `ext.flutter.debugDumpSemanticsTreeInTraversalOrder`
 * service extension. Calling this extension has the side effect of walking
 * the RenderObject tree with `PipelineOwner.flushSemantics()`, which builds
 * the semantics tree on demand — even when no screen reader is attached.
 *
 * Retry story: on cold start, the WidgetsBinding may not have registered
 * its service extensions yet. We retry up to
 * `FLUTTER_VM.ENSURE_SEMANTICS_ATTEMPTS` times with a short delay. Each
 * retry costs one cheap RPC.
 *
 * Why no `evaluate()` fallback: the VM Service `evaluate` RPC requires
 * `targetId` to be a Library/Class/Instance reference — passing the
 * isolate id (as a prior version of this module did) is incorrect and
 * returns an RPC error. Even with the right target, `WidgetsBinding` is
 * not in the root library's scope in most apps, so the expression would
 * fail. Pure service extensions are the only reliable path.
 *
 * Returns true on the first successful call, false if every retry fails.
 * Never throws.
 */
export async function ensureFlutterSemantics(
  client: DartVmServiceClient,
  isolateId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < FLUTTER_VM.ENSURE_SEMANTICS_ATTEMPTS; attempt++) {
    try {
      await client.callExtension(isolateId, 'ext.flutter.debugDumpSemanticsTreeInTraversalOrder');
      return true;
    } catch {
      // Extension not registered yet — wait and retry.
      if (attempt < FLUTTER_VM.ENSURE_SEMANTICS_ATTEMPTS - 1) {
        await sleep(FLUTTER_VM.ENSURE_SEMANTICS_POLL_MS);
      }
    }
  }
  return false;
}

/**
 * Single Dart VM liveness probe. Sends `getVM` and measures the round-trip
 * time. If the isolate's event loop is wedged inside a long synchronous
 * function, `getVM` will block until it drains; a fast response means the
 * VM is at least processing messages.
 *
 * This is a *liveness* probe, not an idle signal. Flutter's frame scheduler
 * state isn't exposed via any service extension (everything useful runs in
 * Dart code that requires a proper Library targetId to evaluate against).
 * For idle detection, we rely on the helper's accessibility-event idle —
 * the VM Service channel only adds "Dart isolate is alive and responsive"
 * and the `ensureFlutterSemantics` side channel.
 */
async function probeDartVmLiveness(client: DartVmServiceClient): Promise<number | undefined> {
  const start = Date.now();
  try {
    await client.getVm();
  } catch {
    return undefined;
  }
  return Date.now() - start;
}

/**
 * Wait up to `timeoutMs` for the Dart VM to respond quickly N times in a
 * row. Returns true on success, false on timeout. Composes with the
 * helper's accessibility-event idle.
 *
 * Note: the second parameter is kept for API stability but is unused — the
 * liveness probe is isolate-agnostic. Callers still pass the isolate id so
 * signatures don't churn if we ever add a per-isolate check.
 */
export async function waitForFlutterFrameIdle(
  client: DartVmServiceClient,
  _isolateId: string,
  timeoutMs: number = FLUTTER_VM.SYNC_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    const elapsed = await probeDartVmLiveness(client);
    if (elapsed !== undefined && elapsed <= FLUTTER_VM.SYNC_IDLE_THRESHOLD_MS) {
      stable += 1;
      if (stable >= FLUTTER_VM.SYNC_STABLE_COUNT) return true;
    } else {
      stable = 0;
    }
    await sleep(FLUTTER_VM.SYNC_POLL_MS);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
