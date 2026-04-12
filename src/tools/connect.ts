import { AdbClient } from '../android/adb.js';
import { waitForIdle } from '../android/idle.js';
import { DeviceClient, type ActiveBackend } from '../android/device-client.js';
import { FrameworkSync, type FrameworkKind } from '../android/framework-sync.js';
import { GrpcEmulatorClient } from '../android/grpc-client.js';
import { discoverEmulatorToken } from '../android/grpc-discovery.js';
import { discoverHermesTargets } from '../android/hermes-cdp.js';
import { ensureHelper, type HelperHandle } from '../android/helper-installer.js';
import type { RefRegistry } from '../android/ref-registry.js';
import { GRPC } from '../constants.js';
import { GrpcConnectionError } from '../errors.js';
import type { ShellExecutor } from '../types.js';

export type BackendOption = 'auto' | 'adb' | 'grpc';

export interface ConnectResult {
  deviceId: string;
  packageName: string;
  /** Compact text tree from the initial screen snapshot. */
  uiTree: string;
  /** 6-char screen fingerprint. */
  screenFingerprint: string;
  /** Which backend is active for input injection. */
  backend: ActiveBackend;
  /** Whether the on-device helper APK is installed and serving. */
  helperInstalled: boolean;
  /** The framework detected for the launched app, if helper is available. */
  framework?: 'flutter' | 'react_native' | 'compose' | 'native';
  /**
   * Which framework-sync channel(s) connected after helper/framework
   * detection. 'hermes' = React Native Hermes CDP via Metro; 'dart_vm' =
   * Flutter VM Service; 'idling_bridge' = opt-in AgenTest AAR
   * ContentProvider. Multiple can be present simultaneously (e.g., a
   * Flutter app that also installed the idling bridge). undefined = no
   * framework sync available. Either way, the helper's accessibility-event
   * idle is always the primary signal.
   */
  frameworkSync?: ('hermes' | 'dart_vm' | 'idling_bridge')[];
  /**
   * Non-fatal warnings the LLM should surface to the developer. Currently
   * used to flag a stale idling-bridge AAR — i.e. the user updated AgenTest
   * via npm but hasn't rebuilt their Android app so the device still ships
   * the old wire format. Each entry is a human-readable message that
   * includes an actionable command.
   */
  warnings?: string[];
  /**
   * Trace lines explaining what happened during framework detection +
   * sync attach. This is the in-band replacement for stderr-based
   * diagnostics, which Claude Code's MCP client silently drops after
   * the initial handshake — without these the LLM has no visibility
   * into why a framework sync channel failed to attach.
   *
   * Each line is prefixed with a channel tag in brackets:
   *   [framework]   helper-side detection result
   *   [metro]       Metro /json/list discovery (Phase 3.5 backstop)
   *   [hermes]      Hermes CDP attach pipeline
   *   [dart-vm]     Flutter VM Service attach pipeline
   *   [idling-bridge]   opt-in app-side IdlingResource provider
   *   [framework-sync]  the orchestrator itself
   */
  diagnostics?: string[];
  /** The gRPC client, stored in server state for subsequent tool calls. */
  grpcClient?: GrpcEmulatorClient;
  /** The helper handle, stored in server state for subsequent tool calls. */
  helper?: HelperHandle;
  /** The framework sync handle, stored in server state for teardown later. */
  sync?: FrameworkSync;
}

/**
 * Parse the emulator console port from a device ID like "emulator-5554".
 * Returns null for physical devices or unrecognized formats.
 */
function parseEmulatorPort(deviceId: string): number | null {
  const match = /^emulator-(\d+)$/.exec(deviceId);
  return match ? Number(match[1]) : null;
}

export async function handleConnect(
  shell: ShellExecutor,
  packageName: string,
  deviceId?: string,
  backend: BackendOption = 'auto',
  existingGrpcClient?: GrpcEmulatorClient,
  existingHelper?: HelperHandle,
  existingSync?: FrameworkSync,
  registry?: RefRegistry,
): Promise<ConnectResult> {
  // Tear down any clients from a previous session
  if (existingGrpcClient) {
    existingGrpcClient.close();
  }
  if (existingHelper) {
    await existingHelper.shutdown();
  }
  if (existingSync) {
    existingSync.close();
  }

  const device = new DeviceClient(shell, deviceId);

  // Verify device is connected
  await device.assertDeviceConnected();

  const devices = await device.getConnectedDevices();
  const resolvedDeviceId = deviceId ?? devices[0] ?? 'unknown';

  // Attempt gRPC connection if requested
  let grpcClient: GrpcEmulatorClient | undefined;

  if (backend !== 'adb') {
    const consolePort = parseEmulatorPort(resolvedDeviceId);

    if (consolePort !== null) {
      // Discover auth token from emulator's pid_*.ini file
      const discovery = await discoverEmulatorToken(consolePort);
      const grpcPort = discovery?.grpcPort ?? consolePort + GRPC.PORT_OFFSET;
      const client = new GrpcEmulatorClient(grpcPort, discovery?.token);

      try {
        await client.connect();
        grpcClient = client;
      } catch (err) {
        if (backend === 'grpc') {
          throw err instanceof GrpcConnectionError
            ? err
            : new GrpcConnectionError(
                `Failed to connect to emulator gRPC on port ${grpcPort}: ${err instanceof Error ? err.message : String(err)}`,
              );
        }
        // backend='auto' — silent fallback to ADB
        console.error(
          `[agentest] gRPC connection failed on port ${grpcPort}, using ADB backend: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (backend === 'grpc') {
      throw new GrpcConnectionError(
        `Device "${resolvedDeviceId}" is not an emulator — gRPC backend is only available for emulators`,
      );
    }
  }

  // Auto-install + launch the on-device helper APK in parallel with the
  // app launch. Zero user input required — the prebuilt APKs ship with the
  // npm package and we install them silently if they're missing or stale.
  // If anything goes wrong we just degrade to the ADB+gRPC path with a log.
  const helper = await ensureHelper(shell, resolvedDeviceId).catch((err: unknown) => {
    console.error(
      `[agentest] helper install failed, continuing with ADB/gRPC: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });

  // Create an initial device client WITHOUT framework sync so we can detect
  // framework first — the sync backend selection depends on the result.
  const deviceForLaunch = new DeviceClient(
    shell,
    resolvedDeviceId,
    grpcClient,
    backend === 'grpc', // strictGrpc: throw on gRPC failure instead of falling back
    helper?.client,
  );

  // Launch the app
  await deviceForLaunch.launchApp(packageName);

  // In-band diagnostic trace surfaced through the connect response so the
  // LLM can see exactly which step succeeded or failed. Claude Code's MCP
  // client drops post-startup stderr; this is the replacement channel.
  const diagnostics: string[] = [];

  // Detect framework as early as possible so we know which sync backend to
  // set up. The helper does this via a11y class signals + native lib scan
  // and returns within a few milliseconds.
  let framework: FrameworkKind | undefined;
  if (helper) {
    try {
      const info = await deviceForLaunch.detectFramework(packageName);
      framework = info?.primary;
      diagnostics.push(
        `[framework] helper detected primary=${info?.primary ?? 'undefined'} signals=${
          info?.signals?.join('|') ?? 'none'
        }`,
      );
    } catch (err) {
      diagnostics.push(
        `[framework] helper detect threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    diagnostics.push('[framework] helper not installed, skipping helper-side detection');
  }

  // Metro-first backstop: the helper's framework detection can miss RN
  // apps in two common ways —
  //   1. RN Fabric flattens React views into plain Android widgets, so
  //      the a11y tree has no ReactViewGroup / RCTView class names to
  //      walk. (Observed on API 36 emulators with recent RN builds.)
  //   2. SELinux on newer Android builds blocks shell UID from reading
  //      /proc/<pid>/maps for other apps, killing the lib-based signal.
  //      (Permission denied on API 36 sdk_gphone64_arm64.)
  //
  // Metro's /json/list inspector-proxy endpoint is the most reliable
  // positive signal we have: when Metro is running and has attached to
  // the target app, it publishes a debug target with `appId` equal to
  // the app's package name (plus a `reactNative` metadata block). If
  // helper detection says "native" / undefined but Metro sees our
  // package, we override here so `FrameworkSync` below will correctly
  // open the Hermes CDP channel.
  //
  // Release builds naturally skip this path: no Metro → no override →
  // framework stays whatever the helper reported.
  //
  // Gated on `AGENTEST_DISABLE_FRAMEWORK_SYNC=1` for two reasons:
  //   (a) the unit-test suite uses MockShellExecutor and doesn't expect
  //       any network calls — running fetch against localhost:8081 in
  //       tests is harmless (ECONNREFUSED in ~5ms) but creates spurious
  //       behavior on any dev machine that happens to have something
  //       else listening on 8081;
  //   (b) consistency with the rest of the framework-sync stack — if a
  //       user has explicitly disabled framework sync, they don't want
  //       us probing Metro behind their back either.
  if (
    process.env['AGENTEST_DISABLE_FRAMEWORK_SYNC'] !== '1' &&
    framework !== 'react_native' &&
    framework !== 'flutter'
  ) {
    try {
      const metroTargets = await discoverHermesTargets();
      diagnostics.push(
        `[metro] /json/list returned ${metroTargets.length} target(s)${
          metroTargets.length > 0
            ? ': ' + metroTargets.map((t) => `${t.id}(appId=${t.appId ?? 'none'})`).join(', ')
            : ''
        }`,
      );
      const matchesPackage = metroTargets.some(
        (t) =>
          t.appId === packageName ||
          t.description?.includes(packageName) ||
          t.title?.includes(packageName),
      );
      if (matchesPackage) {
        framework = 'react_native';
        diagnostics.push(
          `[metro] override → framework=react_native (appId/description/title matched packageName "${packageName}")`,
        );
      } else if (metroTargets.length > 0) {
        diagnostics.push(
          `[metro] no target matched packageName "${packageName}" — leaving framework as-is`,
        );
      }
    } catch (err) {
      diagnostics.push(
        `[metro] discovery threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (process.env['AGENTEST_DISABLE_FRAMEWORK_SYNC'] === '1') {
    diagnostics.push('[metro] skipped (AGENTEST_DISABLE_FRAMEWORK_SYNC=1)');
  } else {
    diagnostics.push(
      `[metro] skipped (helper already detected framework=${framework ?? 'undefined'})`,
    );
  }

  // Attach a framework sync backend if any sync channel is available:
  //   - Hermes CDP (React Native debug builds)
  //   - Dart VM Service (Flutter debug/profile builds)
  //   - AgenTest Idling Bridge (any framework, opt-in AAR — Phase 3.10)
  //
  // attach() is non-fatal for every channel. hasBackend is true iff at
  // least one of them attached successfully. Even when nothing attaches
  // we still pull the diagnostic trace out so the caller can see why.
  let frameworkSync: FrameworkSync | undefined;
  if (framework) {
    const sync = new FrameworkSync({
      framework,
      packageName,
      adb: new AdbClient(shell, resolvedDeviceId),
    });
    await sync.attach();
    diagnostics.push(...sync.diagnostics);
    if (sync.hasBackend) {
      frameworkSync = sync;
    } else {
      sync.close();
    }
  } else {
    diagnostics.push('[framework-sync] skipped (no framework detected)');
  }

  // Rebuild the device client with the framework sync attached so that
  // waitForIdle (and subsequent run_flow steps via the shared device in
  // server.ts) will route through it.
  const deviceFull = new DeviceClient(
    shell,
    resolvedDeviceId,
    grpcClient,
    backend === 'grpc',
    helper?.client,
    frameworkSync,
  );

  // Wait for UI to settle. When a framework sync is attached, this call
  // augments the helper's a11y-event idle with a JS/Dart-side idle probe.
  const idleResult = await waitForIdle(deviceFull);

  // Enumerate which sync channels actually attached so the LLM can surface
  // them in the connect response. Each entry corresponds to a real probe
  // that will run after the next `/wait-idle` — missing entries mean that
  // channel was absent or degraded.
  const syncChannels: ('hermes' | 'dart_vm' | 'idling_bridge')[] = [];
  const warnings: string[] = [];
  if (frameworkSync) {
    if (frameworkSync.hasHermes) syncChannels.push('hermes');
    if (frameworkSync.hasDartVm) syncChannels.push('dart_vm');
    if (frameworkSync.hasIdlingBridge) syncChannels.push('idling_bridge');
    // Stale-bridge detection: if the AAR baked into the user's app reports
    // a different wire version than the host expects, emit a warning with
    // a ready-to-paste rebuild command. The LLM relays it to the developer.
    if (frameworkSync.idlingBridgeWarning) {
      warnings.push(frameworkSync.idlingBridgeWarning);
    }
  }

  // Fetch fiber labels if Hermes is attached (Phase 3.6). Silent no-op
  // for non-RN apps or when Hermes is unavailable. The call appends
  // further diagnostic lines to `frameworkSync.diagnostics`, so we
  // re-snapshot them below before returning.
  const diagnosticsBeforeFiber = frameworkSync ? frameworkSync.diagnostics.length : 0;
  const fiberLabels = frameworkSync
    ? await frameworkSync.snapshotFiberLabels(idleResult.tree)
    : new Map<string, string>();
  if (frameworkSync) {
    // Pull any new [fiber] diagnostic lines added by the snapshot into
    // the outgoing response.
    const newLines = frameworkSync.diagnostics.slice(diagnosticsBeforeFiber);
    diagnostics.push(...newLines);
  }

  // Build registry from initial tree — produces compact text + fingerprint + refs
  registry?.clear();
  const compactResult = registry?.rebuild(idleResult.tree, { externalLabels: fiberLabels });

  return {
    deviceId: resolvedDeviceId,
    packageName,
    uiTree: compactResult?.text ?? '',
    screenFingerprint: compactResult?.fingerprint ?? '',
    backend: deviceFull.backend,
    helperInstalled: helper !== null,
    framework,
    frameworkSync: syncChannels.length > 0 ? syncChannels : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    grpcClient,
    helper: helper ?? undefined,
    sync: frameworkSync,
  };
}
