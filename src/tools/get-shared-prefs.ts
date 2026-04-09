import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { ShellExecutor } from '../types.js';

export interface GetSharedPrefsResult {
  packageName: string;
  file: string;
  content: string;
}

export async function handleGetSharedPrefs(
  shell: ShellExecutor,
  packageName: string,
  file: string,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
): Promise<GetSharedPrefsResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient);
  const content = await device.getSharedPrefs(packageName, file);

  return {
    packageName,
    file,
    content,
  };
}
