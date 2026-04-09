/**
 * DeviceClient facade — composes AdbClient + optional GrpcEmulatorClient
 * + optional on-device HelperClient.
 *
 * Routing rules (in priority order):
 *   - Tree dumps:    helper > adb        (helper is 5-10x faster)
 *   - Idle waits:    helper > adb        (helper uses push-based events)
 *   - Tap/swipe etc: grpc > helper > adb (gRPC is fastest on emulator;
 *                                         helper is fastest on physical;
 *                                         ADB is the universal fallback)
 *   - Type / clear:  helper > adb        (gRPC keypress is unreliable for IME)
 *   - Screenshot:    grpc > helper > adb
 *   - Framework det: helper only (returns null if helper unavailable)
 *
 * Exposes the same public method signatures as AdbClient for drop-in
 * replacement throughout the rest of the codebase.
 */

import { KEYCODE_TO_W3C } from '../constants.js';
import type { DeviceInfo, ShellExecutor, SystemDialog, UnifiedUINode } from '../types.js';
import { AdbClient } from './adb.js';
import type { GrpcEmulatorClient } from './grpc-client.js';
import { GrpcKeyEventType } from './grpc-types.js';
import {
  performLongPress,
  performPinch,
  performRotate,
  performSwipe,
  performTap,
} from './grpc-touch.js';
import type { HelperClient, HelperFrameworkInfo } from './helper-client.js';
import { parseHelperJsonTree, type HelperTreeResponse } from './tree-parser.js';

export type ActiveBackend = 'helper' | 'grpc' | 'adb';

export class DeviceClient {
  private readonly adb: AdbClient;
  private grpcHealthy: boolean;
  private helperHealthy: boolean;
  /** If true, gRPC errors throw instead of falling back to ADB. */
  private readonly strictGrpc: boolean;

  constructor(
    shell: ShellExecutor,
    deviceId?: string,
    private readonly grpc?: GrpcEmulatorClient,
    strictGrpc = false,
    private readonly helper?: HelperClient,
  ) {
    this.adb = new AdbClient(shell, deviceId);
    this.grpcHealthy = grpc?.isConnected() ?? false;
    this.helperHealthy = helper !== undefined;
    this.strictGrpc = strictGrpc;
  }

  /**
   * Which backend is currently active for input methods.
   *
   * Order of preference: gRPC (fastest on emulator) → helper (fastest on
   * physical device) → ADB (universal fallback).
   */
  get backend(): ActiveBackend {
    if (this.grpc && this.grpcHealthy) return 'grpc';
    if (this.helper && this.helperHealthy) return 'helper';
    return 'adb';
  }

  /** Whether the on-device helper is available. */
  get hasHelper(): boolean {
    return this.helper !== undefined && this.helperHealthy;
  }

  /**
   * Returns the gRPC client if it should be used for the next operation,
   * or undefined to fall through to the helper / ADB.
   */
  private getGrpc(): GrpcEmulatorClient | undefined {
    if (this.grpc && this.grpcHealthy) {
      return this.grpc;
    }
    return undefined;
  }

  /** Returns the helper client if healthy, or undefined to fall through. */
  private getHelper(): HelperClient | undefined {
    if (this.helper && this.helperHealthy) {
      return this.helper;
    }
    return undefined;
  }

  /**
   * Mark the helper as unhealthy after a failure. Subsequent calls will
   * silently fall through to ADB. Logged once per session.
   */
  private handleHelperFailure(method: string, err: unknown): void {
    if (!this.helperHealthy) return; // already disabled
    this.helperHealthy = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[lazytest] helper ${method} failed, falling back to ADB for the rest of the session: ${msg}`,
    );
  }

  // -------------------------------------------------------------------------
  // Input injection — routed through gRPC when available
  // -------------------------------------------------------------------------

  async tap(x: number, y: number): Promise<void> {
    const g = this.getGrpc();
    if (g) {
      try {
        await performTap(g, x, y);
        return;
      } catch (err) {
        this.handleGrpcFailure('tap', err);
      }
    }
    const h = this.getHelper();
    if (h) {
      try {
        await h.tap(x, y);
        return;
      } catch (err) {
        this.handleHelperFailure('tap', err);
      }
    }
    await this.adb.tap(x, y);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    const g = this.getGrpc();
    if (g) {
      try {
        await performSwipe(g, x1, y1, x2, y2, durationMs);
        return;
      } catch (err) {
        this.handleGrpcFailure('swipe', err);
      }
    }
    const h = this.getHelper();
    if (h) {
      try {
        await h.swipe(x1, y1, x2, y2, durationMs);
        return;
      } catch (err) {
        this.handleHelperFailure('swipe', err);
      }
    }
    await this.adb.swipe(x1, y1, x2, y2, durationMs);
  }

  async longPress(x: number, y: number, durationMs: number): Promise<void> {
    const g = this.getGrpc();
    if (g) {
      try {
        await performLongPress(g, x, y, durationMs);
        return;
      } catch (err) {
        this.handleGrpcFailure('longPress', err);
      }
    }
    const h = this.getHelper();
    if (h) {
      try {
        await h.longPress(x, y, durationMs);
        return;
      } catch (err) {
        this.handleHelperFailure('longPress', err);
      }
    }
    await this.adb.longPress(x, y, durationMs);
  }

  /** Multi-touch pinch gesture — gRPC only (ADB has no multi-touch). */
  async pinch(
    cx: number,
    cy: number,
    startRadius: number,
    endRadius: number,
    durationMs: number,
  ): Promise<void> {
    const g = this.getGrpc();
    if (!g) {
      throw new Error(
        'Pinch gesture requires gRPC backend (emulator only). ADB does not support multi-touch.',
      );
    }
    try {
      await performPinch(g, cx, cy, startRadius, endRadius, durationMs);
    } catch (err) {
      this.handleGrpcFailure('pinch', err);
      throw err;
    }
  }

  /** Multi-touch rotate gesture — gRPC only. */
  async rotate(
    cx: number,
    cy: number,
    radius: number,
    startAngleRad: number,
    endAngleRad: number,
    durationMs: number,
  ): Promise<void> {
    const g = this.getGrpc();
    if (!g) {
      throw new Error(
        'Rotate gesture requires gRPC backend (emulator only). ADB does not support multi-touch.',
      );
    }
    try {
      await performRotate(g, cx, cy, radius, startAngleRad, endAngleRad, durationMs);
    } catch (err) {
      this.handleGrpcFailure('rotate', err);
      throw err;
    }
  }

  async keyEvent(keycode: string): Promise<void> {
    const g = this.getGrpc();
    if (g) {
      const w3cKey = KEYCODE_TO_W3C[keycode];
      if (w3cKey) {
        try {
          await g.sendKey({ key: w3cKey, eventType: GrpcKeyEventType.keypress });
          return;
        } catch (err) {
          this.handleGrpcFailure('keyEvent', err);
        }
      }
      // Unmapped keycode — fall through to ADB
    }
    await this.adb.keyEvent(keycode);
  }

  async type(text: string): Promise<void> {
    // Helper preferred — uses KeyCharacterMap.getEvents for keystroke
    // synthesis without spawning `adb shell input text`. ADB is the fallback
    // for non-ASCII (helper currently can't synthesize emoji).
    const h = this.getHelper();
    if (h && this.isAsciiPrintable(text)) {
      try {
        await h.typeText(text);
        return;
      } catch (err) {
        this.handleHelperFailure('type', err);
      }
    }
    await this.adb.type(text);
  }

  async clearTextField(): Promise<void> {
    // Always use ADB — gRPC sendKey can't reliably do Ctrl+A select-all,
    // and the helper currently doesn't expose a clear primitive.
    await this.adb.clearTextField();
  }

  private isAsciiPrintable(text: string): boolean {
    return /^[\x20-\x7E]*$/.test(text);
  }

  // -------------------------------------------------------------------------
  // Screenshots — gRPC when available
  // -------------------------------------------------------------------------

  async captureScreenshot(): Promise<string> {
    const g = this.getGrpc();
    if (g) {
      try {
        const image = await g.getScreenshot({ format: 0 }); // PNG
        return Buffer.from(image.image).toString('base64');
      } catch (err) {
        this.handleGrpcFailure('captureScreenshot', err);
      }
    }
    const h = this.getHelper();
    if (h) {
      try {
        return await h.screenshot();
      } catch (err) {
        this.handleHelperFailure('captureScreenshot', err);
      }
    }
    return this.adb.captureScreenshot();
  }

  // -------------------------------------------------------------------------
  // Always ADB — no gRPC equivalent
  // -------------------------------------------------------------------------

  async getConnectedDevices(): Promise<string[]> {
    return this.adb.getConnectedDevices();
  }

  async assertDeviceConnected(): Promise<void> {
    return this.adb.assertDeviceConnected();
  }

  async launchApp(packageName: string): Promise<void> {
    return this.adb.launchApp(packageName);
  }

  async forceStopApp(packageName: string): Promise<void> {
    return this.adb.forceStopApp(packageName);
  }

  /**
   * Dump the UI tree as XML, in the same format that `parseUiAutomatorXml`
   * expects. The helper produces JSON natively (much faster), so when the
   * helper is available we go through `dumpUiTreeAsNodes` instead — keep this
   * method for the legacy ADB path used by callers that haven't migrated yet.
   */
  async dumpUiTree(): Promise<string> {
    return this.adb.dumpUiTree();
  }

  /**
   * Fast tree dump via the on-device helper. Returns a UnifiedUINode tree
   * directly (parsed from JSON in-process), or null if the helper is
   * unavailable — caller should fall back to `dumpUiTree` + `parseUiAutomatorXml`.
   *
   * ~80ms for a 200-node screen vs ~800ms for `uiautomator dump`.
   */
  async dumpUiTreeFast(): Promise<UnifiedUINode | null> {
    const h = this.getHelper();
    if (!h) return null;
    try {
      const json = (await h.getTree({ compact: false })) as unknown as HelperTreeResponse;
      return parseHelperJsonTree(json);
    } catch (err) {
      this.handleHelperFailure('dumpUiTreeFast', err);
      return null;
    }
  }

  /**
   * Wait for the UI to settle. Helper path uses event-driven idle detection
   * (push notifications via UiAutomation.OnAccessibilityEventListener) and
   * typically resolves in 150-300ms. Returns true if idle was confirmed,
   * false if the helper isn't available — caller should fall back to
   * polling-based idle in `idle.ts`.
   */
  async waitForIdleViaHelper(timeoutMs: number, packageName?: string): Promise<boolean> {
    const h = this.getHelper();
    if (!h) return false;
    try {
      const result = await h.waitForIdle({ timeoutMs, packageName });
      return result.idle;
    } catch (err) {
      this.handleHelperFailure('waitForIdle', err);
      return false;
    }
  }

  /** Detect what UI framework an app is using (helper-only). */
  async detectFramework(packageName?: string): Promise<HelperFrameworkInfo | null> {
    const h = this.getHelper();
    if (!h) return null;
    try {
      return await h.detectFramework(packageName);
    } catch (err) {
      this.handleHelperFailure('detectFramework', err);
      return null;
    }
  }

  async getAppLogs(packageName: string, maxLines?: number): Promise<string> {
    return this.adb.getAppLogs(packageName, maxLines);
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    return this.adb.getDeviceInfo();
  }

  async detectSystemDialogs(tree: UnifiedUINode): Promise<SystemDialog[]> {
    return this.adb.detectSystemDialogs(tree);
  }

  // App state inspection (always ADB — uses run-as)

  async getSharedPrefs(packageName: string, file: string): Promise<string> {
    return this.adb.getSharedPrefs(packageName, file);
  }

  async queryDatabase(packageName: string, database: string, query: string): Promise<string> {
    return this.adb.queryDatabase(packageName, database, query);
  }

  // Network simulation (always ADB — uses adb emu / svc)

  async setNetworkSpeed(speed: string): Promise<void> {
    return this.adb.setNetworkSpeed(speed);
  }

  async setNetworkDelay(delay: string): Promise<void> {
    return this.adb.setNetworkDelay(delay);
  }

  async setWifi(enabled: boolean): Promise<void> {
    return this.adb.setWifi(enabled);
  }

  async setMobileData(enabled: boolean): Promise<void> {
    return this.adb.setMobileData(enabled);
  }

  async setAirplaneMode(enabled: boolean): Promise<void> {
    return this.adb.setAirplaneMode(enabled);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Handle a gRPC failure. In strict mode (backend='grpc'), re-throws.
   * Otherwise marks gRPC as unhealthy and logs a warning so the caller
   * can fall through to ADB.
   */
  private handleGrpcFailure(method: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (this.strictGrpc) {
      throw err;
    }
    this.grpcHealthy = false;
    console.error(`[lazytest] gRPC ${method} failed, falling back to ADB: ${msg}`);
  }
}
