import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { HelperClient } from '../android/helper-client.js';
import type { ShellExecutor } from '../types.js';

export interface ScreenshotResult {
  /** Base64-encoded PNG image */
  imageBase64: string;
}

export async function handleScreenshot(
  shell: ShellExecutor,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
  helperClient?: HelperClient,
): Promise<ScreenshotResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient, false, helperClient);
  const imageBase64 = await device.captureScreenshot();

  return {
    imageBase64,
  };
}
