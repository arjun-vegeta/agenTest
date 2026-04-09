import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { HelperClient } from '../android/helper-client.js';
import type { DeviceInfo, ShellExecutor } from '../types.js';

export async function handleDeviceInfo(
  shell: ShellExecutor,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
  helperClient?: HelperClient,
): Promise<DeviceInfo> {
  const device = new DeviceClient(shell, deviceId, grpcClient, false, helperClient);
  return device.getDeviceInfo();
}
