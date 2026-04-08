import { AdbClient } from '../android/adb.js';
import type { DeviceInfo, ShellExecutor } from '../types.js';

export async function handleDeviceInfo(
  shell: ShellExecutor,
  deviceId?: string,
): Promise<DeviceInfo> {
  const adb = new AdbClient(shell, deviceId);
  return adb.getDeviceInfo();
}
