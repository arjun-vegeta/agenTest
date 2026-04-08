import { AdbClient } from '../android/adb.js';
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
): Promise<ResetAppResult> {
  const adb = new AdbClient(shell, deviceId);

  // Force stop the app
  await adb.forceStopApp(packageName);

  // Relaunch
  await adb.launchApp(packageName);

  // Wait for UI to settle
  const tree = await waitForIdle(adb);

  return {
    packageName,
    uiTree: serializeTreeForLlm(tree),
  };
}
