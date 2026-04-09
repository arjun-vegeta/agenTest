import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { HelperClient } from '../android/helper-client.js';
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
  grpcClient?: GrpcEmulatorClient,
  helperClient?: HelperClient,
): Promise<GetLogsResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient, false, helperClient);
  const logs = await device.getAppLogs(packageName, maxLines);

  return {
    packageName,
    logs,
  };
}
