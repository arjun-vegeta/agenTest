import { DeviceClient } from '../android/device-client.js';
import type { FrameworkSync } from '../android/framework-sync.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { HelperClient } from '../android/helper-client.js';
import { waitForIdle } from '../android/idle.js';
import type { RefRegistry } from '../android/ref-registry.js';
import { SimctlClient } from '../ios/simctl.js';
import { WdaClient } from '../ios/wda-client.js';
import { waitForIosIdle } from '../ios/idle.js';
import type { Platform, ShellExecutor } from '../types.js';

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
  platform?: Platform,
  wdaPort?: number,
): Promise<ResetAppResult> {
  if (platform === 'ios') {
    if (!wdaPort) {
      throw new Error('wdaPort is required when platform is ios');
    }
    return handleIosResetApp(shell, packageName, deviceId, wdaPort, registry);
  }

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

async function handleIosResetApp(
  shell: ShellExecutor,
  bundleId: string,
  deviceId: string | undefined,
  wdaPort: number,
  registry?: RefRegistry,
): Promise<ResetAppResult> {
  const simctl = new SimctlClient(shell, deviceId);

  // Terminate then relaunch
  await simctl.terminateApp(bundleId);
  await simctl.launchApp(bundleId);

  const client = new WdaClient(wdaPort);

  // Wait for UI to settle
  const idleResult = await waitForIosIdle(client, bundleId);

  // Rebuild registry with fresh tree
  registry?.clear();
  const compactResult = registry?.rebuild(idleResult.tree);

  return {
    packageName: bundleId,
    screenFingerprint: compactResult?.fingerprint ?? '',
    uiTree: compactResult?.text ?? '',
  };
}
