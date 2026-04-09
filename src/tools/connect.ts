import { waitForIdle } from '../android/idle.js';
import { serializeTreeForLlm } from '../android/tree-parser.js';
import { DeviceClient, type ActiveBackend } from '../android/device-client.js';
import { GrpcEmulatorClient } from '../android/grpc-client.js';
import { discoverEmulatorToken } from '../android/grpc-discovery.js';
import { ensureHelper, type HelperHandle } from '../android/helper-installer.js';
import { GRPC } from '../constants.js';
import { GrpcConnectionError } from '../errors.js';
import type { ShellExecutor } from '../types.js';

export type BackendOption = 'auto' | 'adb' | 'grpc';

export interface ConnectResult {
  deviceId: string;
  packageName: string;
  uiTree: ReturnType<typeof serializeTreeForLlm>;
  /** Which backend is active for input injection. */
  backend: ActiveBackend;
  /** Whether the on-device helper APK is installed and serving. */
  helperInstalled: boolean;
  /** The framework detected for the launched app, if helper is available. */
  framework?: 'flutter' | 'react_native' | 'compose' | 'native';
  /** The gRPC client, stored in server state for subsequent tool calls. */
  grpcClient?: GrpcEmulatorClient;
  /** The helper handle, stored in server state for subsequent tool calls. */
  helper?: HelperHandle;
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
): Promise<ConnectResult> {
  // Tear down any clients from a previous session
  if (existingGrpcClient) {
    existingGrpcClient.close();
  }
  if (existingHelper) {
    await existingHelper.shutdown();
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
          `[lazytest] gRPC connection failed on port ${grpcPort}, using ADB backend: ${err instanceof Error ? err.message : String(err)}`,
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
      `[lazytest] helper install failed, continuing with ADB/gRPC: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });

  // Create the device client with gRPC + helper if available
  const deviceFull = new DeviceClient(
    shell,
    resolvedDeviceId,
    grpcClient,
    backend === 'grpc', // strictGrpc: throw on gRPC failure instead of falling back
    helper?.client,
  );

  // Launch the app
  await deviceFull.launchApp(packageName);

  // Wait for UI to settle (helper-fast event-driven path when available,
  // polling fallback otherwise — both with loading indicator detection)
  const idleResult = await waitForIdle(deviceFull);

  // Detect framework if the helper is available — this informs the LLM what
  // kind of app it's testing so it can adjust selector strategies.
  let framework: ConnectResult['framework'];
  if (helper) {
    const info = await deviceFull.detectFramework(packageName);
    framework = info?.primary;
  }

  return {
    deviceId: resolvedDeviceId,
    packageName,
    uiTree: serializeTreeForLlm(idleResult.tree),
    backend: deviceFull.backend,
    helperInstalled: helper !== null,
    framework,
    grpcClient,
    helper: helper ?? undefined,
  };
}
