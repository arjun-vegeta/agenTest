import { ADB, ADB_COMMANDS, MONKEY_FLAGS, TIMEOUTS } from '../constants.js';
import { AdbCommandError, AdbConnectionError } from '../errors.js';
import type { ShellExecutor } from '../types.js';

export class AdbClient {
  constructor(
    private readonly shell: ShellExecutor,
    private readonly deviceId?: string,
  ) {}

  // -----------------------------------------------------------------------
  // Command building
  // -----------------------------------------------------------------------

  private buildCommand(...args: string[]): string {
    const parts: string[] = [ADB.BINARY];
    if (this.deviceId) {
      parts.push(ADB.DEVICE_FLAG, this.deviceId);
    }
    parts.push(...args);
    return parts.join(' ');
  }

  private buildShellCommand(command: string): string {
    return this.buildCommand(ADB.SHELL, command);
  }

  // -----------------------------------------------------------------------
  // Device management
  // -----------------------------------------------------------------------

  async getConnectedDevices(): Promise<string[]> {
    const output = await this.shell.exec(this.buildCommand(ADB_COMMANDS.DEVICES), {
      timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
    });

    return output
      .split('\n')
      .slice(1) // skip "List of devices attached" header
      .map((line) => line.trim())
      .filter((line) => line.endsWith('device'))
      .map((line) => line.split('\t')[0] ?? '');
  }

  async assertDeviceConnected(): Promise<void> {
    const devices = await this.getConnectedDevices();
    if (devices.length === 0) {
      throw new AdbConnectionError(
        'No Android devices/emulators connected. Run "adb devices" to check.',
      );
    }
    if (this.deviceId && !devices.includes(this.deviceId)) {
      throw new AdbConnectionError(
        `Device "${this.deviceId}" not found. Available: ${devices.join(', ')}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // App lifecycle
  // -----------------------------------------------------------------------

  async launchApp(packageName: string): Promise<void> {
    const command = [
      ADB_COMMANDS.MONKEY_LAUNCH,
      packageName,
      MONKEY_FLAGS.CATEGORY_LAUNCHER,
      MONKEY_FLAGS.EVENT_COUNT,
    ].join(' ');

    const output = await this.shell.exec(this.buildShellCommand(command), {
      timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
    });

    if (output.includes('No activities found')) {
      throw new AdbCommandError(
        `Failed to launch "${packageName}": no launcher activity found`,
        command,
      );
    }
  }

  async forceStopApp(packageName: string): Promise<void> {
    await this.shell.exec(this.buildShellCommand(`${ADB_COMMANDS.AM_FORCE_STOP} ${packageName}`), {
      timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
    });
  }

  // -----------------------------------------------------------------------
  // UI tree
  // -----------------------------------------------------------------------

  async dumpUiTree(): Promise<string> {
    // Step 1: trigger the dump
    await this.shell.exec(this.buildShellCommand(`${ADB_COMMANDS.UI_DUMP} ${ADB.DUMP_PATH}`), {
      timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
    });

    // Step 2: read the file
    const xml = await this.shell.exec(
      this.buildShellCommand(`${ADB_COMMANDS.CAT} ${ADB.DUMP_PATH}`),
      { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
    );

    if (!xml.includes('<hierarchy')) {
      throw new AdbCommandError('uiautomator dump returned invalid XML', ADB_COMMANDS.UI_DUMP);
    }

    return xml.trim();
  }

  // -----------------------------------------------------------------------
  // Input injection
  // -----------------------------------------------------------------------

  async tap(x: number, y: number): Promise<void> {
    await this.shell.exec(
      this.buildShellCommand(`${ADB_COMMANDS.INPUT_TAP} ${Math.round(x)} ${Math.round(y)}`),
      { timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS },
    );
  }

  async type(text: string): Promise<void> {
    // adb shell input text requires escaping shell-special characters
    // and replacing spaces with %s
    const escaped = text
      .replace(/%/g, '%%')
      .replace(/ /g, '%s')
      .replace(/[&|;`$"'\\<>(){}!#*?[\]]/g, '\\$&');

    await this.shell.exec(this.buildShellCommand(`${ADB_COMMANDS.INPUT_TEXT} "${escaped}"`), {
      timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS,
    });
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    const coords = [x1, y1, x2, y2].map(Math.round).join(' ');
    await this.shell.exec(
      this.buildShellCommand(`${ADB_COMMANDS.INPUT_SWIPE} ${coords} ${durationMs}`),
      { timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS },
    );
  }

  async keyEvent(keycode: string): Promise<void> {
    await this.shell.exec(this.buildShellCommand(`${ADB_COMMANDS.INPUT_KEYEVENT} ${keycode}`), {
      timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS,
    });
  }

  async longPress(x: number, y: number, durationMs: number): Promise<void> {
    // Long press is implemented as a zero-distance swipe with duration
    const rx = Math.round(x);
    const ry = Math.round(y);
    await this.shell.exec(
      this.buildShellCommand(
        `${ADB_COMMANDS.INPUT_LONG_PRESS} ${rx} ${ry} ${rx} ${ry} ${durationMs}`,
      ),
      { timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS },
    );
  }
}
