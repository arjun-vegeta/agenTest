import { AdbClient } from '../android/adb.js';
import type { ShellExecutor } from '../types.js';

export interface ScreenshotResult {
  /** Base64-encoded PNG image */
  imageBase64: string;
}

export async function handleScreenshot(
  shell: ShellExecutor,
  deviceId?: string,
): Promise<ScreenshotResult> {
  const adb = new AdbClient(shell, deviceId);
  const imageBase64 = await adb.captureScreenshot();

  return {
    imageBase64,
  };
}
