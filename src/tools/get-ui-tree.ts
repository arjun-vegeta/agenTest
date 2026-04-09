import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import { snapshotTree } from '../android/idle.js';
import { serializeTreeForLlm } from '../android/tree-parser.js';
import type { LlmTreeNode, ShellExecutor } from '../types.js';

export interface GetUiTreeResult {
  uiTree: LlmTreeNode;
}

export async function handleGetUiTree(
  shell: ShellExecutor,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
): Promise<GetUiTreeResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient);
  const tree = await snapshotTree(device);

  return {
    uiTree: serializeTreeForLlm(tree),
  };
}
