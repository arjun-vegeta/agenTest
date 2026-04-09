/**
 * Framework sync orchestrator — Phase 3.9.
 *
 * After the on-device helper reports the UI is idle via accessibility events,
 * LazyTest still has a race: the helper only sees Android-side work, not the
 * JS / Dart work that actually drives the render. This module composes the
 * helper's event-driven idle with framework-specific probes so the flow
 * runner has stronger confidence the app is actually done.
 *
 * Design:
 *   - `FrameworkSync` is an optional object owned by `DeviceClient`.
 *   - It tracks a per-session Hermes CDP client (RN debug builds) and a
 *     per-session Dart VM Service client (Flutter debug/profile builds).
 *   - `waitForSync()` is a best-effort tail probe that runs AFTER the
 *     accessibility-event idle — it augments, never replaces, the helper's
 *     idle detection.
 *   - Every failure mode returns silently; the sync channel degrades to
 *     "no extra signal" and the existing a11y-event idle still gates
 *     correctness.
 *
 * Test builds:
 *   - `LAZYTEST_DISABLE_FRAMEWORK_SYNC=1` short-circuits every probe.
 *     Integration tests rely on this so MockShellExecutor doesn't try to
 *     open real WebSockets.
 */

import { FLUTTER_VM, IDLING_BRIDGE } from '../constants.js';
import type { AdbClient } from './adb.js';
import {
  connectDartVmServiceFor,
  ensureFlutterSemantics,
  waitForFlutterFrameIdle,
  type DartVmServiceClient,
} from './dart-vm-service.js';
import {
  connectHermesForPackage,
  waitForHermesJsIdle,
  type HermesCdpClient,
} from './hermes-cdp.js';

export type FrameworkKind = 'flutter' | 'react_native' | 'compose' | 'native';

export interface FrameworkSyncInit {
  framework: FrameworkKind;
  packageName: string;
  adb: AdbClient;
}

/**
 * Owns framework-specific sync clients and drives the post-idle sync probe.
 *
 * Lifecycle:
 *   new FrameworkSync(...)   // does nothing yet
 *   await sync.attach()       // tries to connect — silent failure allowed
 *   await sync.waitForSync()  // run after helper /wait-idle
 *   sync.close()              // release WebSockets
 */
export class FrameworkSync {
  private readonly framework: FrameworkKind;
  private readonly packageName: string;
  private readonly adb: AdbClient;

  /** Hermes inspector client, when attached successfully. */
  private hermes: HermesCdpClient | undefined;

  /** Dart VM Service client + isolate id, when attached successfully. */
  private dartVm: { client: DartVmServiceClient; isolateId: string } | undefined;

  /** Flag flipped once attach() has run (regardless of outcome). */
  private attached = false;

  /**
   * LazyTest idling bridge presence (Phase 3.10). Set to true on attach()
   * if the user's app registered the optional `lazytest-idling-bridge`
   * ContentProvider; the sync tail probe then also drains pending Espresso
   * IdlingResources and custom sources.
   */
  private idlingBridgePresent = false;

  /**
   * Wire format version reported by the device-side bridge. Used to detect
   * stale AARs that linger in a user's Android app after they've updated
   * LazyTest via npm but haven't rebuilt the app.
   */
  private idlingBridgeWireVersion: number | undefined;

  /**
   * Captured human-readable diagnostic lines from `attach()`. We tee these
   * to stderr (helpful for non-Claude-Code MCP clients) AND keep them in
   * memory so the connect tool can surface them in its JSON response.
   *
   * Why we duplicate: Claude Code's MCP client only forwards lazytest
   * stderr at startup; every subsequent console.error during a tool call
   * is dropped on the floor. Without an in-band channel, framework-sync
   * failures are completely opaque to the developer. The connect response
   * carries these lines as `diagnostics: string[]` so the LLM can show
   * the developer the exact reason an attach failed.
   */
  private readonly diagnosticLog: string[] = [];

  constructor(init: FrameworkSyncInit) {
    this.framework = init.framework;
    this.packageName = init.packageName;
    this.adb = init.adb;
  }

  get kind(): FrameworkKind {
    return this.framework;
  }

  /** True if any framework backend connected successfully. */
  get hasBackend(): boolean {
    return this.hermes !== undefined || this.dartVm !== undefined || this.idlingBridgePresent;
  }

  /** True iff the app declared the optional LazyTest idling bridge provider. */
  get hasIdlingBridge(): boolean {
    return this.idlingBridgePresent;
  }

  /** True iff a Hermes CDP backend attached successfully. */
  get hasHermes(): boolean {
    return this.hermes !== undefined;
  }

  /** True iff a Dart VM Service backend attached successfully. */
  get hasDartVm(): boolean {
    return this.dartVm !== undefined;
  }

  /**
   * Snapshot of diagnostic lines captured during `attach()`. Each entry
   * is a single line, prefixed with the channel name in brackets, e.g.
   * `"[hermes] metro discovery returned 1 target(s): ..."`. The connect
   * tool surfaces these in its JSON response so the LLM can show the
   * developer exactly what happened during framework sync setup —
   * critical for debugging silent failures.
   */
  get diagnostics(): readonly string[] {
    return this.diagnosticLog;
  }

  /**
   * Append a diagnostic line and also tee to stderr. Channel is prepended
   * in brackets for easy filtering. Centralized so every code path uses
   * the same format.
   */
  private logDiagnostic(channel: string, message: string): void {
    const line = `[${channel}] ${message}`;
    this.diagnosticLog.push(line);
    console.error(`[lazytest ${channel}] ${message}`);
  }

  /**
   * If the device-side idling bridge wire version doesn't match the host's
   * expected version, return an actionable warning string (with a rebuild
   * command) that the connect tool surfaces to the LLM. Returns `undefined`
   * when the bridge is absent, up-to-date, or never probed.
   *
   * The LLM is expected to relay this warning to the developer verbatim
   * or in its own words — the `./gradlew` command is ready to paste.
   */
  get idlingBridgeWarning(): string | undefined {
    if (this.idlingBridgeWireVersion === undefined) return undefined;
    const expected = IDLING_BRIDGE.EXPECTED_WIRE_VERSION;
    if (this.idlingBridgeWireVersion === expected) return undefined;
    const device = this.idlingBridgeWireVersion;
    return (
      `LazyTest idling bridge is out of date: the AAR baked into this app ` +
      `reports wire version ${device}, but LazyTest expects version ${expected}. ` +
      `This usually means LazyTest was updated via \`npm update lazytest\` but ` +
      `the Android app hasn't been rebuilt yet — Gradle caches AARs in the app's ` +
      `build cache. Rebuild the app with:\n\n` +
      `    cd android && ./gradlew :app:assembleDebug\n\n` +
      `then reinstall and relaunch. Alternatively, in Android Studio use ` +
      `'Build > Rebuild Project'. Until you rebuild, the idling bridge sync ` +
      `channel may report stale idle state or silently skip.`
    );
  }

  /**
   * Try to open the framework-specific backend. Never throws. The MCP
   * session uses one of these per connect; on any failure we fall through
   * silently and rely on the helper's a11y-event idle alone.
   */
  async attach(): Promise<void> {
    if (this.attached) return;
    this.attached = true;

    if (process.env['LAZYTEST_DISABLE_FRAMEWORK_SYNC'] === '1') {
      this.logDiagnostic('framework-sync', 'disabled by LAZYTEST_DISABLE_FRAMEWORK_SYNC=1');
      return;
    }

    this.logDiagnostic(
      'framework-sync',
      `attach starting for package=${this.packageName} framework=${this.framework}`,
    );

    // Opt-in idling bridge probe (Phase 3.10) — works for ANY framework,
    // including compose and native, as long as the user has added the AAR.
    // One cheap `content query` tells us whether the provider exists; the
    // result also doubles as the initial idle check AND gives us the
    // device-side wire version for staleness detection.
    try {
      const probe = await this.adb.queryIdlingBridge(this.packageName);
      if (probe) {
        this.idlingBridgePresent = true;
        this.idlingBridgeWireVersion = probe.version;
        this.logDiagnostic(
          'idling-bridge',
          `attached, wire version ${probe.version}, ${probe.idleCount} busy resource(s)`,
        );
      } else {
        this.logDiagnostic('idling-bridge', 'not present (no AAR added to debugImplementation)');
      }
    } catch (err) {
      this.logDiagnostic('idling-bridge', `probe error: ${errorMessage(err)}`);
    }

    if (this.framework === 'react_native') {
      try {
        this.hermes = await connectHermesForPackage(
          this.packageName,
          undefined,
          // Funnel every diagnostic from the Hermes attach pipeline through
          // our channel logger so it lands in BOTH stderr and the connect
          // response payload.
          (msg) => this.logDiagnostic('hermes', msg),
        );
        if (!this.hermes) {
          this.logDiagnostic('hermes', 'attach returned undefined (see prior lines for cause)');
        }
      } catch (err) {
        this.logDiagnostic('hermes', `sync unavailable: ${errorMessage(err)}`);
      }
      return;
    }

    if (this.framework === 'flutter') {
      try {
        const attached = await connectDartVmServiceFor(this.adb, this.packageName);
        if (attached) {
          this.dartVm = attached;
          this.logDiagnostic('dart-vm', `attached, isolate ${attached.isolateId}`);
          try {
            const ok = await ensureFlutterSemantics(attached.client, attached.isolateId);
            this.logDiagnostic(
              'dart-vm',
              ok
                ? 'ensureFlutterSemantics succeeded'
                : 'ensureFlutterSemantics failed (tree may be sparse)',
            );
          } catch (err) {
            this.logDiagnostic('dart-vm', `ensureFlutterSemantics error: ${errorMessage(err)}`);
          }
        } else {
          this.logDiagnostic(
            'dart-vm',
            'connectDartVmServiceFor returned undefined (no logcat URL or WS handshake failed)',
          );
        }
      } catch (err) {
        this.logDiagnostic('dart-vm', `sync unavailable: ${errorMessage(err)}`);
      }
      return;
    }

    // compose and native with no idling bridge: no framework sync backend
    // available — the helper's a11y-event idle is the only signal.
    this.logDiagnostic(
      'framework-sync',
      `no framework-specific sync backend for framework=${this.framework}`,
    );
  }

  /**
   * Optional tail probe after the helper reports the UI is idle. Returns
   * true if the framework backend reports idle too (or if no backend is
   * attached — vacuously true). Returns false only when the backend is
   * attached but the sync probe timed out, which the caller can use to
   * emit a log but not to fail the action.
   */
  async waitForSync(timeoutMs?: number): Promise<boolean> {
    // Framework-specific channel first (Hermes/Flutter) — gives us a
    // correct signal for JS/Dart work.
    let frameworkOk = true;
    if (this.hermes) {
      frameworkOk = await waitForHermesJsIdle(this.hermes, timeoutMs);
    } else if (this.dartVm) {
      frameworkOk = await waitForFlutterFrameIdle(
        this.dartVm.client,
        this.dartVm.isolateId,
        timeoutMs ?? FLUTTER_VM.SYNC_TIMEOUT_MS,
      );
    }

    // Then drain the optional idling bridge (Phase 3.10) — independent of
    // framework, so both channels can run in sequence.
    let bridgeOk = true;
    if (this.idlingBridgePresent) {
      bridgeOk = await this.waitForIdlingBridge();
    }

    return frameworkOk && bridgeOk;
  }

  /**
   * Poll the idling bridge ContentProvider until `idle_count == 0`.
   *
   * Returns true on success, false on timeout. Each `content query` takes
   * ~10-30ms over USB so we can poll aggressively without wasting cycles.
   */
  private async waitForIdlingBridge(): Promise<boolean> {
    const deadline = Date.now() + IDLING_BRIDGE.QUERY_TIMEOUT_MS * 3;
    while (Date.now() < deadline) {
      const result = await this.adb.queryIdlingBridge(this.packageName);
      if (!result) return false;
      if (result.idleCount === 0) return true;
      await sleep(50);
    }
    return false;
  }

  /**
   * Ask the framework backend to rebuild the semantics / inspector tree.
   * Currently only Flutter benefits from this — the a11y tree on Flutter
   * apps without an active screen reader is sparse until we ping the VM.
   */
  async refreshSemantics(): Promise<boolean> {
    if (this.dartVm) {
      return ensureFlutterSemantics(this.dartVm.client, this.dartVm.isolateId);
    }
    return false;
  }

  /** Release all WebSockets. Safe to call multiple times. */
  close(): void {
    if (this.hermes) {
      try {
        this.hermes.close();
      } catch {
        // ignore
      }
      this.hermes = undefined;
    }
    if (this.dartVm) {
      try {
        this.dartVm.client.close();
      } catch {
        // ignore
      }
      this.dartVm = undefined;
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
