import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
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
): Promise<GetLogsResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient);
  const logs = await device.getAppLogs(packageName, maxLines);

  return {
    packageName,
    logs,
  };
}
