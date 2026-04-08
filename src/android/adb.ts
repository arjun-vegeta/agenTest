import {
  ADB,
  ADB_COMMANDS,
  ADB_COMMANDS_EXT,
  ANDROID_PROPS,
  LOGCAT,
  MONKEY_FLAGS,
  RETRY,
  SYSTEM_PACKAGES,
  TIMEOUTS,
} from '../constants.js';
import { AdbCommandError, AdbConnectionError } from '../errors.js';
import type { DeviceInfo, ShellExecutor, SystemDialog, UnifiedUINode } from '../types.js';

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
  // UI tree (with retry — uiautomator dump is flaky)
  // -----------------------------------------------------------------------

  async dumpUiTree(): Promise<string> {
    return this.withRetry(async () => {
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
    });
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

  // -----------------------------------------------------------------------
  // Logcat
  // -----------------------------------------------------------------------

  async getAppLogs(packageName: string, maxLines?: number): Promise<string> {
    const lines = maxLines ?? LOGCAT.MAX_LINES;
    // Get the app's PID
    let pidFilter = '';
    try {
      const pid = await this.shell.exec(
        this.buildShellCommand(`${ADB_COMMANDS_EXT.PIDOF} ${packageName}`),
        { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
      );
      const trimmedPid = pid.trim();
      if (trimmedPid) {
        pidFilter = ` ${ADB_COMMANDS_EXT.LOGCAT_PID_FLAG}=${trimmedPid}`;
      }
    } catch {
      // If pidof fails (app not running), dump all logcat
    }

    const output = await this.shell.exec(
      this.buildShellCommand(`${ADB_COMMANDS_EXT.LOGCAT_DUMP}${pidFilter} -t ${lines}`),
      { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
    );

    return output.trim();
  }

  // -----------------------------------------------------------------------
  // Screenshot
  // -----------------------------------------------------------------------

  async captureScreenshot(): Promise<string> {
    const output = await this.shell.exec(
      this.buildCommand(ADB.EXEC_OUT, ADB_COMMANDS_EXT.SCREENCAP),
      { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
    );
    // Convert binary PNG to base64
    return Buffer.from(output, 'binary').toString('base64');
  }

  // -----------------------------------------------------------------------
  // Device info
  // -----------------------------------------------------------------------

  async getDeviceInfo(): Promise<DeviceInfo> {
    const [sizeOut, densityOut, sdkOut, versionOut, modelOut, manufacturerOut] = await Promise.all([
      this.shell.exec(this.buildShellCommand(ADB_COMMANDS_EXT.WM_SIZE), {
        timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
      }),
      this.shell.exec(this.buildShellCommand(ADB_COMMANDS_EXT.WM_DENSITY), {
        timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
      }),
      this.shell.exec(
        this.buildShellCommand(`${ADB_COMMANDS_EXT.GETPROP} ${ANDROID_PROPS.SDK_VERSION}`),
        { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
      ),
      this.shell.exec(
        this.buildShellCommand(`${ADB_COMMANDS_EXT.GETPROP} ${ANDROID_PROPS.ANDROID_VERSION}`),
        { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
      ),
      this.shell.exec(
        this.buildShellCommand(`${ADB_COMMANDS_EXT.GETPROP} ${ANDROID_PROPS.DEVICE_MODEL}`),
        { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
      ),
      this.shell.exec(
        this.buildShellCommand(`${ADB_COMMANDS_EXT.GETPROP} ${ANDROID_PROPS.DEVICE_MANUFACTURER}`),
        { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
      ),
    ]);

    // Parse "Physical size: 1080x1920"
    const sizeMatch = /(\d+)x(\d+)/.exec(sizeOut);
    // Parse "Physical density: 420"
    const densityMatch = /(\d+)/.exec(densityOut);

    return {
      screenWidth: sizeMatch ? Number(sizeMatch[1]) : 0,
      screenHeight: sizeMatch ? Number(sizeMatch[2]) : 0,
      density: densityMatch ? Number(densityMatch[1]) : 0,
      sdkVersion: Number(sdkOut.trim()) || 0,
      androidVersion: versionOut.trim(),
      model: modelOut.trim(),
      manufacturer: manufacturerOut.trim(),
    };
  }

  // -----------------------------------------------------------------------
  // System dialog detection
  // -----------------------------------------------------------------------

  async detectSystemDialogs(tree: UnifiedUINode): Promise<SystemDialog[]> {
    const dialogs: SystemDialog[] = [];
    this.findSystemDialogNodes(tree, dialogs);
    return dialogs;
  }

  private findSystemDialogNodes(node: UnifiedUINode, results: SystemDialog[]): void {
    const isSystemPackage = SYSTEM_PACKAGES.some((pkg) => node.packageName === pkg);

    if (isSystemPackage && node.children.length > 0) {
      // Extract dialog info: find title text and button labels
      const texts: string[] = [];
      const buttons: string[] = [];
      this.extractDialogContent(node, texts, buttons);

      if (texts.length > 0 || buttons.length > 0) {
        results.push({
          packageName: node.packageName,
          title: texts[0] ?? '',
          buttons,
        });
      }
      return; // Don't recurse into system dialog children
    }

    for (const child of node.children) {
      this.findSystemDialogNodes(child, results);
    }
  }

  private extractDialogContent(node: UnifiedUINode, texts: string[], buttons: string[]): void {
    if (node.text) {
      if (node.clickable) {
        buttons.push(node.text);
      } else {
        texts.push(node.text);
      }
    }
    for (const child of node.children) {
      this.extractDialogContent(child, texts, buttons);
    }
  }

  // -----------------------------------------------------------------------
  // Retry helper
  // -----------------------------------------------------------------------

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < RETRY.MAX_ATTEMPTS - 1) {
          const delay = RETRY.BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }
}
