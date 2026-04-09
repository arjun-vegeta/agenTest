import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { ShellExecutor } from '../types.js';

export interface ScreenshotResult {
  /** Base64-encoded PNG image */
  imageBase64: string;
}

export async function handleScreenshot(
  shell: ShellExecutor,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
): Promise<ScreenshotResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient);
  const imageBase64 = await device.captureScreenshot();

  return {
    imageBase64,
  };
}
