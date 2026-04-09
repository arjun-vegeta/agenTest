import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { HelperClient } from '../android/helper-client.js';
import type { ShellExecutor } from '../types.js';

export interface SetNetworkInput {
  /** Speed preset: gsm, gprs, edge, umts, 3g, hsdpa, lte, full. Or "offline" to disable. */
  preset?: string;
  /** Custom speed as up:down kbps (e.g. "100:1000") */
  speed?: string;
  /** Latency preset: none, gprs, edge, umts. Or custom min:max ms (e.g. "100:300") */
  delay?: string;
  /** Toggle WiFi explicitly */
  wifi?: boolean;
  /** Toggle airplane mode explicitly */
  airplaneMode?: boolean;
}

export interface SetNetworkResult {
  applied: SetNetworkInput;
  message: string;
}

export async function handleSetNetwork(
  shell: ShellExecutor,
  input: SetNetworkInput,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
  helperClient?: HelperClient,
): Promise<SetNetworkResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient, false, helperClient);
  const applied: SetNetworkInput = {};
  const messages: string[] = [];

  // "offline" preset is shorthand for disabling all network
  if (input.preset === 'offline') {
    await device.setWifi(false);
    await device.setMobileData(false);
    applied.preset = 'offline';
    applied.wifi = false;
    messages.push('Network set to offline (wifi + data disabled)');
  } else if (input.preset) {
    await device.setNetworkSpeed(input.preset);
    applied.preset = input.preset;
    messages.push(`Network speed preset: ${input.preset}`);
  }

  if (input.speed) {
    await device.setNetworkSpeed(input.speed);
    applied.speed = input.speed;
    messages.push(`Custom speed: ${input.speed}`);
  }

  if (input.delay) {
    await device.setNetworkDelay(input.delay);
    applied.delay = input.delay;
    messages.push(`Latency: ${input.delay}`);
  }

  if (input.wifi !== undefined) {
    await device.setWifi(input.wifi);
    applied.wifi = input.wifi;
    messages.push(`WiFi: ${input.wifi ? 'enabled' : 'disabled'}`);
  }

  if (input.airplaneMode !== undefined) {
    await device.setAirplaneMode(input.airplaneMode);
    applied.airplaneMode = input.airplaneMode;
    messages.push(`Airplane mode: ${input.airplaneMode ? 'enabled' : 'disabled'}`);
  }

  return {
    applied,
    message: messages.length > 0 ? messages.join('; ') : 'No changes applied',
  };
}
