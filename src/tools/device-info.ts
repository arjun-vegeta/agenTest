import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { DeviceInfo, ShellExecutor } from '../types.js';

export async function handleDeviceInfo(
  shell: ShellExecutor,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
): Promise<DeviceInfo> {
  const device = new DeviceClient(shell, deviceId, grpcClient);
  return device.getDeviceInfo();
}
