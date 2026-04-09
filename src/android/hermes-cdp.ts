/**
 * Hermes CDP client — React Native JS-side sync backend (Phase 3.5).
 *
 * Connects to Metro's inspector proxy (default: http://127.0.0.1:8081) and
 * speaks a tiny subset of the Chrome DevTools Protocol (CDP) sufficient for
 * evaluating JavaScript expressions in the running Hermes instance.
 *
 * LazyTest uses this to detect when React Native has finished processing its
 * JS event loop — pending microtasks, setTimeout queue, Promise chains — so
 * the flow runner doesn't fire the next action while React is still committing
 * state updates.
 *
 * Discovery:
 *   1. `adb reverse tcp:8081 tcp:8081` (so the emulator can reach Metro).
 *      The host-side Metro is already listening on 8081 — we just need to
 *      make sure the device-side loopback maps there too. The *host* MCP
 *      server talks to Metro directly on localhost:8081, so `adb reverse`
 *      only matters when the app is running on a physical device.
 *   2. `GET http://127.0.0.1:8081/json/list` returns an array of targets.
 *      Each target has `webSocketDebuggerUrl: ws://[::1]:8081/inspector/debug?device=N&page=M`
 *      and a `description` that typically contains the bundle identifier
 *      or "Hermes React Native".
 *   3. Pick the first target whose description matches the app package,
 *      fall back to the first Hermes target otherwise.
 *
 * Every failure mode (Metro not running, /json/list times out, WebSocket
 * handshake fails, target missing) returns null — the caller degrades to
 * the accessibility-event idle path.
 *
 * Debug-build only: Hermes disables the inspector in release builds. We
 * don't probe for this explicitly — we just fail silently if no target
 * appears.
 */

import WebSocket from 'ws';
import { HERMES } from '../constants.js';

// Why `ws` instead of globalThis.WebSocket: Node.js only exposes a global
// WebSocket constructor from v21 onward. Node 20 (the current LTS and what
// most users ship in production) has global `fetch` but NOT global
// `WebSocket`, so `new WebSocket(url)` throws `ReferenceError: WebSocket
// is not defined`. The `ws` package is the de facto Node WebSocket client
// and works on every Node version ≥16.
//
// API differences from browser WebSocket that we care about:
//   - Event listeners use EventEmitter style: `.on('message', ...)` not
//     `.addEventListener('message', ...)`.
//   - `.on('message', (data: Buffer) => ...)` — the `data` argument is a
//     raw Buffer, not a `MessageEvent` with a `.data` property. Call
//     `.toString('utf-8')` to get the JSON-RPC payload.

export interface HermesTarget {
  id: string;
  title: string;
  description: string;
  type: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
  /** Non-standard but present on Metro — the Hermes app identifier. */
  appId?: string;
  /** Non-standard — device serial number as Metro sees it. */
  deviceName?: string;
}

interface CdpPendingCall {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface CdpError {
  code: number;
  message: string;
  data?: unknown;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: CdpError;
}

/**
 * Probe Metro's `/json/list` endpoint for debug targets.
 *
 * Returns an empty array if Metro isn't running, the endpoint is unreachable,
 * or the response isn't valid JSON. Callers should treat an empty list as
 * "no Hermes sync available — skip this backend".
 */
export async function discoverHermesTargets(
  metroPort: number = HERMES.METRO_PORT,
): Promise<HermesTarget[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HERMES.DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${metroPort}${HERMES.JSON_LIST_PATH}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body.filter(isHermesTarget);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function isHermesTarget(value: unknown): value is HermesTarget {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['webSocketDebuggerUrl'] === 'string' &&
    typeof v['title'] === 'string' &&
    typeof v['id'] === 'string'
  );
}

/**
 * Pick the best debug target for a given package name. Prefers targets
 * whose description or appId matches the package; otherwise returns the
 * first Hermes-looking target.
 */
export function pickHermesTarget(
  targets: HermesTarget[],
  packageName: string,
): HermesTarget | undefined {
  if (targets.length === 0) return undefined;

  // 1. Exact appId match
  const byAppId = targets.find((t) => t.appId === packageName);
  if (byAppId) return byAppId;

  // 2. Description contains package name
  const byDesc = targets.find((t) => t.description?.includes(packageName));
  if (byDesc) return byDesc;

  // 3. Title contains package name
  const byTitle = targets.find((t) => t.title?.includes(packageName));
  if (byTitle) return byTitle;

  // 4. First Hermes-looking target
  const hermes = targets.find(
    (t) =>
      t.title.toLowerCase().includes('hermes') ||
      t.description?.toLowerCase().includes('hermes') ||
      t.type === 'node',
  );
  if (hermes) return hermes;

  return targets[0];
}

/**
 * Rewrite a Metro-provided WebSocket URL (which often uses IPv6 `[::1]`) to
 * an IPv4 localhost URL. Node's global WebSocket can handle both, but some
 * environments don't route IPv6 correctly — using IPv4 is the safe default.
 */
export function normalizeWebSocketUrl(url: string): string {
  return url.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');
}

/**
 * Thin CDP client over the Metro inspector proxy WebSocket. Supports only
 * `Runtime.enable` and `Runtime.evaluate` — the minimum needed for JS-side
 * sync detection. Not a general-purpose CDP client.
 */
export class HermesCdpClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, CdpPendingCall>();
  private readonly target: HermesTarget;
  private runtimeEnabled = false;
  private closed = false;

  constructor(target: HermesTarget) {
    this.target = target;
  }

  /**
   * Open the WebSocket and send `Runtime.enable`. Rejects if the handshake
   * or the initial RPC fails.
   */
  async connect(): Promise<void> {
    const url = normalizeWebSocketUrl(this.target.webSocketDebuggerUrl);
    this.ws = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not initialized'));
        return;
      }
      // `ws` uses the Node EventEmitter API — `.once()` removes the
      // listener after the first fire, matching `{ once: true }` in the
      // browser WebSocket.
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err: Error) =>
        reject(new Error(`Failed to connect to Hermes inspector at ${url}: ${err.message}`)),
      );
    });

    if (!this.ws) throw new Error('WebSocket vanished after open');
    // `ws` emits `message` with a Node Buffer argument (not a MessageEvent).
    // Decode to UTF-8 string here so the rest of the CDP plumbing stays
    // identical to the browser-WebSocket path.
    this.ws.on('message', (data: Buffer) => this.onMessage(data.toString('utf-8')));
    this.ws.on('close', () => this.onClose());
    // Mid-session errors: the CDP WebSocket can drop if the Hermes runtime
    // dies or Metro restarts. Route those into `onClose` so pending calls
    // reject immediately rather than waiting for their individual RPC
    // timeouts to fire.
    this.ws.on('error', () => this.onClose());

    // Enable the Runtime domain so evaluate works.
    try {
      await this.call('Runtime.enable');
      this.runtimeEnabled = true;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /**
   * Evaluate a JS expression in the Hermes runtime. Returns the unwrapped
   * primitive value from `result.value`, or undefined if evaluation produced
   * an object or threw.
   *
   * The expression is wrapped in a try/catch on the JS side so that syntax
   * errors surface as RPC errors rather than throwing. Returns awaited values
   * when the expression produces a thenable.
   */
  async evaluate(expression: string): Promise<unknown> {
    if (!this.runtimeEnabled) {
      throw new Error('Hermes CDP: Runtime.enable has not been called');
    }
    const wrapped = `(function(){try{return ${expression};}catch(e){return {__lazytest_error:String(e)};}})()`;
    const result = (await this.call('Runtime.evaluate', {
      expression: wrapped,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };

    if (result.exceptionDetails) {
      return undefined;
    }
    return result.result?.value;
  }

  /** Send a CDP method call and resolve with its `result` payload. */
  private call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.closed) {
      return Promise.reject(new Error('Hermes CDP client is not connected'));
    }
    const id = this.nextId++;
    const payload: CdpMessage = { id, method, params: params ?? {} };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes CDP: ${method} timed out after ${HERMES.CDP_REPLY_TIMEOUT_MS}ms`));
      }, HERMES.CDP_REPLY_TIMEOUT_MS);
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

  private onMessage(data: string): void {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(data) as CdpMessage;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') {
      // Event notification — we don't subscribe to any events so ignore.
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`Hermes CDP error ${msg.error.code}: ${msg.error.message}`));
      return;
    }
    pending.resolve(msg.result ?? {});
  }

  private onClose(): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Hermes CDP WebSocket closed'));
    }
    this.pending.clear();
  }

  /** Best-effort close. Safe to call multiple times. */
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
      p.reject(new Error('Hermes CDP client closed'));
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// High-level sync helpers
// ---------------------------------------------------------------------------

/**
 * Connect to the Hermes inspector for a given app package. Returns undefined
 * if discovery fails, the package has no matching target, or the WebSocket
 * can't be opened.
 *
 * The returned client is owned by the caller — remember to `close()` it.
 *
 * `onDiagnostic`, when provided, is called with a one-line human-readable
 * status message at every interesting point in the attach pipeline. This
 * lets the FrameworkSync orchestrator surface the *reason* an attach
 * failed in the MCP server's stderr — silent failures are extremely hard
 * to debug against a real device because every step looks fine in the
 * happy path.
 */
export async function connectHermesForPackage(
  packageName: string,
  metroPort: number = HERMES.METRO_PORT,
  onDiagnostic?: (msg: string) => void,
): Promise<HermesCdpClient | undefined> {
  const targets = await discoverHermesTargets(metroPort);
  if (targets.length === 0) {
    onDiagnostic?.(`metro discovery returned 0 targets on port ${metroPort}`);
    return undefined;
  }
  onDiagnostic?.(
    `metro discovery returned ${targets.length} target(s): ${targets
      .map((t) => `${t.id}(appId=${t.appId ?? 'none'})`)
      .join(', ')}`,
  );

  const target = pickHermesTarget(targets, packageName);
  if (!target) {
    onDiagnostic?.(`no target matched packageName "${packageName}"`);
    return undefined;
  }
  onDiagnostic?.(`picked target ${target.id} (${target.title || target.description || 'unknown'})`);

  const client = new HermesCdpClient(target);
  try {
    await client.connect();
    onDiagnostic?.(`connected and Runtime.enable acked`);
    return client;
  } catch (err) {
    client.close();
    onDiagnostic?.(`connect failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Expression evaluated on the Hermes side to probe JS-thread liveness.
 *
 * This is an honest liveness probe, not a guaranteed idle signal. It uses
 * `awaitPromise: true` (set on the CDP call) to force Hermes to drain at
 * least one microtask turn before responding:
 *
 *   - If the JS thread is free, the Promise resolves on the next microtask
 *     and evaluate() returns within ~20-60ms (the CDP round-trip through
 *     Metro's inspector proxy dominates).
 *   - If the JS thread is pinned inside a long synchronous function,
 *     evaluate() blocks until that work finishes — measured latency jumps
 *     correspondingly.
 *   - If there's a burst of microtasks (e.g. React committing state), the
 *     awaited Promise still resolves in bounded time because microtasks
 *     run FIFO on the same turn. The measured latency reflects "how long
 *     did the current turn take", which is a decent idle-ish proxy.
 *
 * This is intentionally *not* a 100% idle signal. The helper's
 * accessibility-event idle remains the authoritative UI signal; Hermes
 * CDP composes with it to catch "JS thread is alive and not hung" cases
 * that a11y events can't see (e.g., background computation with no UI
 * effect).
 */
const JS_LIVENESS_EXPR = `Promise.resolve(1)`;

/**
 * Probe Hermes for JS-thread liveness. Returns true once the runtime has
 * responded quickly enough N times in a row (see `HERMES.SYNC_STABLE_COUNT`
 * and `HERMES.SYNC_IDLE_THRESHOLD_MS`). Returns false on timeout or if any
 * evaluate call errors.
 *
 * Naming: previously called `waitForHermesJsIdle`. That name implied a
 * stronger guarantee than the implementation actually provides. This is a
 * liveness probe — useful for detecting a stuck JS thread, not for
 * declaring "all React work has settled".
 */
export async function waitForHermesJsIdle(
  client: HermesCdpClient,
  timeoutMs: number = HERMES.SYNC_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    const start = Date.now();
    try {
      await client.evaluate(JS_LIVENESS_EXPR);
    } catch {
      // Transport failure or RPC error — bail. Caller already treats false
      // as "no extra signal" and relies on helper a11y idle.
      return false;
    }
    const elapsed = Date.now() - start;
    if (elapsed <= HERMES.SYNC_IDLE_THRESHOLD_MS) {
      stable += 1;
      if (stable >= HERMES.SYNC_STABLE_COUNT) return true;
    } else {
      stable = 0;
    }
    await sleep(HERMES.SYNC_POLL_MS);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
