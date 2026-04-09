/**
 * DeviceClient facade — composes AdbClient + optional GrpcEmulatorClient.
 * Routes gRPC-capable operations through gRPC when available, falls back to ADB.
 * Exposes the same public method signatures as AdbClient for drop-in replacement.
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

export type ActiveBackend = 'grpc' | 'adb';

export class DeviceClient {
  private readonly adb: AdbClient;
  private grpcHealthy: boolean;
  /** If true, gRPC errors throw instead of falling back to ADB. */
  private readonly strictGrpc: boolean;

  constructor(
    shell: ShellExecutor,
    deviceId?: string,
    private readonly grpc?: GrpcEmulatorClient,
    strictGrpc = false,
  ) {
    this.adb = new AdbClient(shell, deviceId);
    this.grpcHealthy = grpc?.isConnected() ?? false;
    this.strictGrpc = strictGrpc;
  }

  /** Which backend is currently active for input methods. */
  get backend(): ActiveBackend {
    return this.grpc && this.grpcHealthy ? 'grpc' : 'adb';
  }

  /**
   * Returns the gRPC client if it should be used for the next operation,
   * or undefined to fall through to ADB.
   */
  private getGrpc(): GrpcEmulatorClient | undefined {
    if (this.grpc && this.grpcHealthy) {
      return this.grpc;
    }
    return undefined;
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
    // Always use ADB for text input — gRPC sendKey doesn't support Ctrl+V
    // paste reliably, and React Native fields often ignore gRPC key events.
    await this.adb.type(text);
  }

  async clearTextField(): Promise<void> {
    // Always use ADB — gRPC sendKey can't reliably do Ctrl+A select-all.
    await this.adb.clearTextField();
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

  async dumpUiTree(): Promise<string> {
    return this.adb.dumpUiTree();
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
