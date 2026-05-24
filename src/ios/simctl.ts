import { SimctlCommandError, SimctlConnectionError } from '../errors.js';
import type { ShellExecutor } from '../types.js';

export interface SimulatorDevice {
  udid: string;
  name: string;
  state: 'Booted' | 'Shutdown' | 'Booting' | string;
  isAvailable: boolean;
}

export class SimctlClient {
  constructor(
    private readonly shell: ShellExecutor,
    private readonly udid?: string,
  ) {}

  // -----------------------------------------------------------------------
  // Command building
  // -----------------------------------------------------------------------

  private buildCommand(...args: string[]): string {
    const parts: string[] = ['xcrun', 'simctl'];
    parts.push(...args);
    return parts.join(' ');
  }

  private buildDeviceCommand(subcommand: string, ...args: string[]): string {
    const targetUdid = this.udid;
    if (!targetUdid) {
      throw new SimctlConnectionError(
        'No UDID specified for device-specific simctl command. Connect to a simulator first.',
      );
    }
    return this.buildCommand(subcommand, targetUdid, ...args);
  }

  // -----------------------------------------------------------------------
  // Device management
  // -----------------------------------------------------------------------

  /**
   * Parse the output of `xcrun simctl list devices --json` and return
   * a list of all available devices.
   */
  async getDevices(): Promise<SimulatorDevice[]> {
    const cmd = this.buildCommand('list', 'devices', '--json');
    try {
      const output = await this.shell.exec(cmd, { timeoutMs: 15000 });
      const data = JSON.parse(output) as {
        devices: Record<string, SimulatorDevice[]>;
      };

      const result: SimulatorDevice[] = [];
      for (const runtime of Object.keys(data.devices)) {
        const devicesInRuntime = data.devices[runtime] ?? [];
        for (const dev of devicesInRuntime) {
          if (dev.isAvailable) {
            result.push(dev);
          }
        }
      }
      return result;
    } catch (err) {
      throw new SimctlCommandError(
        `Failed to query iOS Simulators list: ${err instanceof Error ? err.message : String(err)}`,
        cmd,
      );
    }
  }

  /**
   * Get UDIDs of all currently booted simulators.
   */
  async getBootedDevices(): Promise<string[]> {
    const devices = await this.getDevices();
    return devices.filter((d) => d.state === 'Booted').map((d) => d.udid);
  }

  async assertDeviceConnected(): Promise<void> {
    const booted = await this.getBootedDevices();
    if (booted.length === 0) {
      throw new SimctlConnectionError(
        'No iOS Simulators currently booted. Run a simulator first.',
      );
    }
    if (this.udid && !booted.includes(this.udid)) {
      throw new SimctlConnectionError(
        `iOS Simulator with UDID "${this.udid}" is not currently booted.`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // App lifecycle
  // -----------------------------------------------------------------------

  async boot(): Promise<void> {
    const targetUdid = this.udid;
    if (!targetUdid) {
      throw new SimctlConnectionError('Cannot boot simulator: no UDID specified.');
    }
    const booted = await this.getBootedDevices();
    if (booted.includes(targetUdid)) {
      return; // already booted
    }

    const cmd = this.buildCommand('boot', targetUdid);
    try {
      await this.shell.exec(cmd, { timeoutMs: 30000 });
    } catch (err) {
      throw new SimctlCommandError(
        `Failed to boot iOS Simulator "${targetUdid}": ${err instanceof Error ? err.message : String(err)}`,
        cmd,
      );
    }
  }

  async installApp(appPath: string): Promise<void> {
    const cmd = this.buildDeviceCommand('install', appPath);
    try {
      await this.shell.exec(cmd, { timeoutMs: 30000 });
    } catch (err) {
      throw new SimctlCommandError(
        `Failed to install app from path "${appPath}": ${err instanceof Error ? err.message : String(err)}`,
        cmd,
      );
    }
  }

  async uninstallApp(bundleId: string): Promise<void> {
    const cmd = this.buildDeviceCommand('uninstall', bundleId);
    try {
      await this.shell.exec(cmd, { timeoutMs: 30000 });
    } catch (err) {
      throw new SimctlCommandError(
        `Failed to uninstall bundle ID "${bundleId}": ${err instanceof Error ? err.message : String(err)}`,
        cmd,
      );
    }
  }

  async launchApp(bundleId: string): Promise<void> {
    // Ensure simulator is booted first
    await this.boot();

    const cmd = this.buildDeviceCommand('launch', bundleId);
    try {
      const output = await this.shell.exec(cmd, { timeoutMs: 20000 });
      if (output.includes('Failed to launch')) {
        throw new Error(output.trim());
      }
    } catch (err) {
      throw new SimctlCommandError(
        `Failed to launch bundle ID "${bundleId}": ${err instanceof Error ? err.message : String(err)}`,
        cmd,
      );
    }
  }

  async terminateApp(bundleId: string): Promise<void> {
    const cmd = this.buildDeviceCommand('terminate', bundleId);
    try {
      await this.shell.exec(cmd, { timeoutMs: 20000 });
    } catch {
      // Ignore if app is not running (terminate throws an error in simctl if the app is already stopped)
    }
  }

  // -----------------------------------------------------------------------
  // Screenshot
  // -----------------------------------------------------------------------

  async takeScreenshot(targetPath: string): Promise<void> {
    const cmd = this.buildDeviceCommand('io', 'screenshot', targetPath);
    try {
      await this.shell.exec(cmd, { timeoutMs: 15000 });
    } catch (err) {
      throw new SimctlCommandError(
        `Failed to capture simulator screenshot: ${err instanceof Error ? err.message : String(err)}`,
        cmd,
      );
    }
  }
}
