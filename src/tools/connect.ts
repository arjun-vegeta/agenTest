import { AdbClient } from '../android/adb.js';
import { waitForIdle } from '../android/idle.js';
import { DeviceClient } from '../android/device-client.js';
import { FrameworkSync, type FrameworkKind } from '../android/framework-sync.js';
import { GrpcEmulatorClient } from '../android/grpc-client.js';
import { discoverEmulatorToken } from '../android/grpc-discovery.js';
import { discoverHermesTargets } from '../android/hermes-cdp.js';
import { ensureHelper, type HelperHandle } from '../android/helper-installer.js';
import type { RefRegistry } from '../android/ref-registry.js';
import { GRPC } from '../constants.js';
import { GrpcConnectionError, AgenTestError } from '../errors.js';
import type { ShellExecutor, Platform } from '../types.js';
import { SimctlClient } from '../ios/simctl.js';
import { WdaRunner } from '../ios/wda-runner.js';
import { WdaClient } from '../ios/wda-client.js';
import { parseWdaJsonTree } from '../ios/tree-parser.js';

export type BackendOption = 'auto' | 'adb' | 'grpc';

export interface ConnectResult {
  deviceId: string;
  packageName: string;
  /** Compact text tree from the initial screen snapshot. */
  uiTree: string;
  /** 6-char screen fingerprint. */
  screenFingerprint: string;
  /** Which backend is active for input injection. */
  backend: string;
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
   * diagnostics, which the MCP client silently drops after
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
  /** The active platform */
  platform?: Platform;
  /** WDA runner process (iOS only) */
  wdaRunner?: WdaRunner;
  /** WDA port (iOS only) */
  wdaPort?: number;
}

/**
 * Parse the emulator console port from a device ID like "emulator-5554".
 * Returns null for physical devices or unrecognized formats.
 */
function parseEmulatorPort(deviceId: string): number | null {
  const match = /^emulator-(\d+)$/.exec(deviceId);
  return match ? Number(match[1]) : null;
}

export async function autoDetectPlatform(shell: ShellExecutor): Promise<Platform> {
  let androidConnected = false;
  let iosConnected = false;

  try {
    const adb = new AdbClient(shell);
    const devices = await adb.getConnectedDevices();
    androidConnected = devices.length > 0;
  } catch {
    // Ignore adb error
  }

  try {
    const simctl = new SimctlClient(shell);
    const booted = await simctl.getBootedDevices();
    iosConnected = booted.length > 0;
  } catch {
    // Ignore simctl error
  }

  if (androidConnected && !iosConnected) {
    return 'android';
  }
  if (iosConnected && !androidConnected) {
    return 'ios';
  }
  if (androidConnected && iosConnected) {
    throw new AgenTestError(
      'Both Android and iOS active devices/simulators were detected. Please specify "platform": "android" or "platform": "ios" explicitly in the connection arguments.',
      'PLATFORM_CONFLICT',
    );
  }
  throw new AgenTestError(
    'No active Android devices/emulators or iOS Simulators were detected. Please boot a device/simulator first.',
    'NO_DEVICES_FOUND',
  );
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
  platform?: Platform,
  existingWdaRunner?: WdaRunner,
): Promise<ConnectResult> {
  const resolvedPlatform = platform ?? (await autoDetectPlatform(shell));

  if (resolvedPlatform === 'ios') {
    // Tear down any active Android components
    if (existingGrpcClient) {
      existingGrpcClient.close();
    }
    if (existingHelper) {
      await existingHelper.shutdown();
    }
    if (existingSync) {
      existingSync.close();
    }

    return handleIosConnect(shell, packageName, deviceId, existingWdaRunner, registry);
  }

  // Tear down any active iOS components
  if (existingWdaRunner) {
    await existingWdaRunner.shutdown();
  }

  const androidRes = await handleAndroidConnect(
    shell,
    packageName,
    deviceId,
    backend,
    existingGrpcClient,
    existingHelper,
    existingSync,
    registry,
  );

  return {
    ...androidRes,
    platform: 'android',
  };
}

export async function handleIosConnect(
  shell: ShellExecutor,
  bundleId: string,
  deviceId?: string,
  existingWdaRunner?: WdaRunner,
  registry?: RefRegistry,
): Promise<ConnectResult> {
  if (existingWdaRunner) {
    await existingWdaRunner.shutdown();
  }

  const simctl = new SimctlClient(shell, deviceId);
  await simctl.assertDeviceConnected();

  const bootedUdids = await simctl.getBootedDevices();
  const resolvedDeviceId = deviceId ?? bootedUdids[0] ?? 'unknown';

  // 1. Scan and find an open port starting from 8100
  const wdaPort = await WdaRunner.findFreePort(8100);

  // 2. Start WDA Runner on the free port
  const runner = new WdaRunner(resolvedDeviceId, wdaPort);
  await runner.start();

  // 3. Setup WdaClient and create session
  const client = new WdaClient(wdaPort);
  await client.ensureSession();

  // 4. Launch target app
  await simctl.launchApp(bundleId);

  // 5. Fetch raw tree and parse
  const rawTree = await client.getSource();
  const uiTree = parseWdaJsonTree(rawTree, bundleId);

  // 6. Rebuild registry
  registry?.clear();
  const compactResult = registry?.rebuild(uiTree);

  return {
    deviceId: resolvedDeviceId,
    packageName: bundleId,
    uiTree: compactResult?.text ?? '',
    screenFingerprint: compactResult?.fingerprint ?? '',
    backend: 'wda',
    helperInstalled: false,
    platform: 'ios',
    wdaRunner: runner,
    wdaPort,
  };
}

export async function handleAndroidConnect(
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
  // LLM can see exactly which step succeeded or failed. the MCP
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

  // Metro-first RN override
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

  // Attach a framework sync backend if any sync channel is available
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

  // Rebuild the device client with the framework sync attached
  const deviceFull = new DeviceClient(
    shell,
    resolvedDeviceId,
    grpcClient,
    backend === 'grpc',
    helper?.client,
    frameworkSync,
  );

  // Wait for UI to settle
  const idleResult = await waitForIdle(deviceFull);

  // Enumerate which sync channels actually attached
  const syncChannels: ('hermes' | 'dart_vm' | 'idling_bridge')[] = [];
  const warnings: string[] = [];
  if (frameworkSync) {
    if (frameworkSync.hasHermes) syncChannels.push('hermes');
    if (frameworkSync.hasDartVm) syncChannels.push('dart_vm');
    if (frameworkSync.hasIdlingBridge) syncChannels.push('idling_bridge');
    if (frameworkSync.idlingBridgeWarning) {
      warnings.push(frameworkSync.idlingBridgeWarning);
    }
  }

  // Fetch fiber labels if Hermes is attached
  const diagnosticsBeforeFiber = frameworkSync ? frameworkSync.diagnostics.length : 0;
  const fiberLabels = frameworkSync
    ? await frameworkSync.snapshotFiberLabels(idleResult.tree)
    : new Map<string, string>();
  if (frameworkSync) {
    const newLines = frameworkSync.diagnostics.slice(diagnosticsBeforeFiber);
    diagnostics.push(...newLines);
  }

  // Build registry from initial tree
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
