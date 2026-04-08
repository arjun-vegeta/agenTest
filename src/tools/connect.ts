import { AdbClient } from '../android/adb.js';
import { waitForIdle } from '../android/idle.js';
import { serializeTreeForLlm } from '../android/tree-parser.js';
import type { ShellExecutor } from '../types.js';

export interface ConnectResult {
  deviceId: string;
  packageName: string;
  uiTree: ReturnType<typeof serializeTreeForLlm>;
}

export async function handleConnect(
  shell: ShellExecutor,
  packageName: string,
  deviceId?: string,
): Promise<ConnectResult> {
  const adb = new AdbClient(shell, deviceId);

  // Verify device is connected
  await adb.assertDeviceConnected();

  const devices = await adb.getConnectedDevices();
  const resolvedDeviceId = deviceId ?? devices[0] ?? 'unknown';

  // Launch the app
  await adb.launchApp(packageName);

  // Wait for UI to settle (with loading indicator detection)
  const idleResult = await waitForIdle(adb);

  return {
    deviceId: resolvedDeviceId,
    packageName,
    uiTree: serializeTreeForLlm(idleResult.tree),
  };
}
