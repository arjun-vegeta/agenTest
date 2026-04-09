import { DeviceClient } from '../android/device-client.js';
import type { FrameworkSync } from '../android/framework-sync.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { HelperClient } from '../android/helper-client.js';
import { waitForIdle } from '../android/idle.js';
import { serializeTreeForLlm } from '../android/tree-parser.js';
import type { LlmTreeNode, ShellExecutor } from '../types.js';

export interface ResetAppResult {
  packageName: string;
  uiTree: LlmTreeNode;
}

export async function handleResetApp(
  shell: ShellExecutor,
  packageName: string,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
  helperClient?: HelperClient,
  frameworkSync?: FrameworkSync,
): Promise<ResetAppResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient, false, helperClient, frameworkSync);

  // Force stop the app
  await device.forceStopApp(packageName);

  // Relaunch
  await device.launchApp(packageName);

  // Wait for UI to settle (with loading indicator detection)
  const idleResult = await waitForIdle(device);

  return {
    packageName,
    uiTree: serializeTreeForLlm(idleResult.tree),
  };
}
