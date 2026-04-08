import { AdbClient } from '../android/adb.js';
import { snapshotTree } from '../android/idle.js';
import { serializeTreeForLlm } from '../android/tree-parser.js';
import type { LlmTreeNode, ShellExecutor } from '../types.js';

export interface GetUiTreeResult {
  uiTree: LlmTreeNode;
}

export async function handleGetUiTree(
  shell: ShellExecutor,
  deviceId?: string,
): Promise<GetUiTreeResult> {
  const adb = new AdbClient(shell, deviceId);
  const tree = await snapshotTree(adb);

  return {
    uiTree: serializeTreeForLlm(tree),
  };
}
