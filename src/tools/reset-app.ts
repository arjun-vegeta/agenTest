import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
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
): Promise<ResetAppResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient);

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
