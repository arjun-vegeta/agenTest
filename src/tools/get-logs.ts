import { AdbClient } from '../android/adb.js';
import type { ShellExecutor } from '../types.js';

export interface GetLogsResult {
  packageName: string;
  logs: string;
}

export async function handleGetLogs(
  shell: ShellExecutor,
  packageName: string,
  maxLines?: number,
  deviceId?: string,
): Promise<GetLogsResult> {
  const adb = new AdbClient(shell, deviceId);
  const logs = await adb.getAppLogs(packageName, maxLines);

  return {
    packageName,
    logs,
  };
}
