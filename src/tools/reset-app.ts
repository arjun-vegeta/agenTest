import { DeviceClient } from '../android/device-client.js';
import type { FrameworkSync } from '../android/framework-sync.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { HelperClient } from '../android/helper-client.js';
import { waitForIdle } from '../android/idle.js';
import type { RefRegistry } from '../android/ref-registry.js';
import type { ShellExecutor } from '../types.js';

export interface ResetAppResult {
  packageName: string;
  screenFingerprint: string;
  uiTree: string;
}

export async function handleResetApp(
  shell: ShellExecutor,
  packageName: string,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
  helperClient?: HelperClient,
  frameworkSync?: FrameworkSync,
  registry?: RefRegistry,
): Promise<ResetAppResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient, false, helperClient, frameworkSync);

  // Force stop the app
  await device.forceStopApp(packageName);

  // Relaunch
  await device.launchApp(packageName);

  // Wait for UI to settle (with loading indicator detection)
  const idleResult = await waitForIdle(device);

  // Fetch fiber labels if Hermes is attached (Phase 3.6).
  const fiberLabels = frameworkSync
    ? await frameworkSync.snapshotFiberLabels(idleResult.tree)
    : new Map<string, string>();

  // Rebuild registry with fresh tree
  const compactResult = registry?.rebuild(idleResult.tree, { externalLabels: fiberLabels });

  return {
    packageName,
    screenFingerprint: compactResult?.fingerprint ?? '',
    uiTree: compactResult?.text ?? '',
  };
}
