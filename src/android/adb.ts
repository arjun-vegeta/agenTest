import { resolveAdbPath } from '../adb-path.js';
import {
  ADB,
  ADB_COMMANDS,
  ADB_COMMANDS_EXT,
  ANDROID_PROPS,
  IDLING_BRIDGE,
  KEYCODES,
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
    const parts: string[] = [resolveAdbPath()];
    if (this.deviceId) {
      parts.push(ADB.DEVICE_FLAG, this.deviceId);
    }
    parts.push(...args);
    return parts.join(' ');
  }

  private buildShellCommand(command: string): string {
    // Quote the command so compound operators (&&, |, etc.) run on the device,
    // not the host shell
    return this.buildCommand(ADB.SHELL, `"${command}"`);
  }

  /** Build `adb [-s device] emu <args>` for emulator console commands. */
  private buildEmuCommand(...args: string[]): string {
    return this.buildCommand(ADB_COMMANDS_EXT.EMU, ...args);
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
      // Batched: rm stale + dump + cat in a single adb shell call (1 process spawn instead of 3)
      const xml = await this.shell.exec(
        this.buildShellCommand(
          `rm -f ${ADB.DUMP_PATH} && ${ADB_COMMANDS.UI_DUMP} ${ADB.DUMP_PATH} > /dev/null 2>&1 && ${ADB_COMMANDS.CAT} ${ADB.DUMP_PATH}`,
        ),
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
    if (this.isAsciiPrintable(text)) {
      // Fast path: adb shell input text with escaping
      const escaped = text
        .replace(/%/g, '%%')
        .replace(/ /g, '%s')
        .replace(/[&|;`$"'\\<>(){}!#*?[\]]/g, '\\$&');

      await this.shell.exec(this.buildShellCommand(`${ADB_COMMANDS.INPUT_TEXT} "${escaped}"`), {
        timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS,
      });
    } else {
      // Clipboard path for unicode, emoji, special chars
      await this.typeViaClipboard(text);
    }
  }

  private isAsciiPrintable(text: string): boolean {
    return /^[\x20-\x7E]*$/.test(text);
  }

  private async typeViaClipboard(text: string): Promise<void> {
    // Set clipboard via broadcast, then paste
    const escaped = text.replace(/'/g, "'\\''");
    await this.shell.exec(
      this.buildShellCommand(`am broadcast -a clipboardSetText --es text '${escaped}'`),
      { timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS },
    );
    await this.shell.exec(
      this.buildShellCommand(`${ADB_COMMANDS.INPUT_KEYEVENT} ${KEYCODES.PASTE}`),
      { timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS },
    );
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

  async clearTextField(): Promise<void> {
    // Select all text (Ctrl+A) then delete
    await this.shell.exec(
      this.buildShellCommand(`${ADB_COMMANDS.INPUT_KEYEVENT} KEYCODE_MOVE_END`),
      { timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS },
    );
    // Hold shift + press home to select all, then delete
    await this.shell.exec(
      this.buildShellCommand(
        `${ADB_COMMANDS.INPUT_KEYEVENT} --longpress KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL`,
      ),
      { timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS },
    );
    // Try Ctrl+A, Delete as a more reliable approach
    await this.shell
      .exec(this.buildShellCommand(`input keyevent 29 --meta ctrl_on`), {
        timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS,
      })
      .catch(() => {
        // Fallback: older Android may not support --meta
      });
    await this.shell
      .exec(this.buildShellCommand(`${ADB_COMMANDS.INPUT_KEYEVENT} KEYCODE_FORWARD_DEL`), {
        timeoutMs: TIMEOUTS.ACTION_TIMEOUT_MS,
      })
      .catch(() => {
        // Fallback: already cleared via longpress delete
      });
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
  // App state inspection (SharedPreferences, SQLite)
  // -----------------------------------------------------------------------

  /**
   * Read a SharedPreferences XML file from a debuggable app's storage.
   * Requires the app to be a debuggable build (run-as fails on release builds).
   */
  async getSharedPrefs(packageName: string, file: string): Promise<string> {
    const safeFile = file.endsWith('.xml') ? file : `${file}.xml`;
    const cmd = `${ADB_COMMANDS_EXT.RUN_AS} ${packageName} cat ${ADB_COMMANDS_EXT.SHARED_PREFS_DIR}/${safeFile}`;
    try {
      const output = await this.shell.exec(this.buildShellCommand(cmd), {
        timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
      });
      return output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('run-as: package not debuggable') || msg.includes('No such file')) {
        throw new AdbCommandError(
          `Cannot read shared_prefs for "${packageName}": app must be a debuggable build with file "${safeFile}" present`,
          cmd,
        );
      }
      throw err;
    }
  }

  /**
   * Run a SQL query against an app's SQLite database via run-as + sqlite3.
   * Requires a debuggable build.
   */
  async queryDatabase(packageName: string, database: string, query: string): Promise<string> {
    // Escape single quotes in query for shell
    const escapedQuery = query.replace(/'/g, "'\\''");
    const dbPath = `${ADB_COMMANDS_EXT.DATABASES_DIR}/${database}`;
    const cmd = `${ADB_COMMANDS_EXT.RUN_AS} ${packageName} ${ADB_COMMANDS_EXT.SQLITE3} ${dbPath} '${escapedQuery}'`;
    try {
      const output = await this.shell.exec(this.buildShellCommand(cmd), {
        timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
      });
      return output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('run-as: package not debuggable')) {
        throw new AdbCommandError(
          `Cannot query database for "${packageName}": app must be a debuggable build`,
          cmd,
        );
      }
      if (msg.includes('No such file')) {
        throw new AdbCommandError(`Database "${database}" not found for "${packageName}"`, cmd);
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Network condition simulation
  // -----------------------------------------------------------------------

  /**
   * Set emulator network speed using a preset (gsm, edge, 3g, lte, full)
   * or custom up:down kbps.
   */
  async setNetworkSpeed(speed: string): Promise<void> {
    await this.shell.exec(this.buildEmuCommand(ADB_COMMANDS_EXT.NETWORK_SPEED, speed), {
      timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
    });
  }

  /**
   * Set emulator network latency using a preset (none, gprs, edge, umts)
   * or custom min:max ms.
   */
  async setNetworkDelay(delay: string): Promise<void> {
    await this.shell.exec(this.buildEmuCommand(ADB_COMMANDS_EXT.NETWORK_DELAY, delay), {
      timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
    });
  }

  /** Toggle WiFi on/off via svc command. */
  async setWifi(enabled: boolean): Promise<void> {
    const action = enabled ? 'enable' : 'disable';
    await this.shell.exec(this.buildShellCommand(`${ADB_COMMANDS_EXT.SVC_WIFI} ${action}`), {
      timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
    });
  }

  /** Toggle mobile data on/off via svc command. */
  async setMobileData(enabled: boolean): Promise<void> {
    const action = enabled ? 'enable' : 'disable';
    await this.shell.exec(this.buildShellCommand(`${ADB_COMMANDS_EXT.SVC_DATA} ${action}`), {
      timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
    });
  }

  /** Toggle airplane mode on/off via cmd connectivity. */
  async setAirplaneMode(enabled: boolean): Promise<void> {
    const action = enabled ? 'enable' : 'disable';
    await this.shell.exec(this.buildShellCommand(`${ADB_COMMANDS_EXT.AIRPLANE_MODE} ${action}`), {
      timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
    });
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
  // Helper APK lifecycle (Phase 3)
  // -----------------------------------------------------------------------

  /** `adb install -r -t <path>` — replace if present, allow test APKs. */
  async installApk(apkPath: string): Promise<void> {
    await this.shell.exec(
      this.buildCommand(
        ADB_COMMANDS_EXT.INSTALL,
        ADB_COMMANDS_EXT.INSTALL_REPLACE,
        ADB_COMMANDS_EXT.INSTALL_TEST,
        `"${apkPath}"`,
      ),
      { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
    );
  }

  /** `adb uninstall <package>` — best-effort, ignores "not installed" errors. */
  async uninstallPackage(packageName: string): Promise<void> {
    try {
      await this.shell.exec(this.buildCommand(ADB_COMMANDS_EXT.UNINSTALL, packageName), {
        timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('not installed') && !msg.includes('DELETE_FAILED')) {
        throw err;
      }
    }
  }

  /** Check whether a package is installed on the device. */
  async isPackageInstalled(packageName: string): Promise<boolean> {
    const out = await this.shell.exec(
      this.buildShellCommand(`${ADB_COMMANDS_EXT.PM_LIST_PKGS} ${packageName}`),
      { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
    );
    return out.split('\n').some((line) => line.trim() === `package:${packageName}`);
  }

  /**
   * Read the versionCode of an installed package via `dumpsys package`.
   * Returns null if not installed or if dumpsys output is unexpected.
   */
  async getPackageVersionCode(packageName: string): Promise<number | null> {
    try {
      const out = await this.shell.exec(
        this.buildShellCommand(`${ADB_COMMANDS_EXT.DUMPSYS_PACKAGE} ${packageName}`),
        { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
      );
      const match = /versionCode=(\d+)/.exec(out);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  /** `adb forward tcp:<host> tcp:<device>` — set up port forward. */
  async forwardPort(hostPort: number, devicePort: number): Promise<void> {
    await this.shell.exec(
      this.buildCommand(ADB_COMMANDS_EXT.FORWARD, `tcp:${hostPort}`, `tcp:${devicePort}`),
      { timeoutMs: TIMEOUTS.SHELL_COMMAND_MS },
    );
  }

  /** Remove a port forward; ignores errors if it wasn't set. */
  async removeForward(hostPort: number): Promise<void> {
    try {
      await this.shell.exec(this.buildCommand('forward', '--remove', `tcp:${hostPort}`), {
        timeoutMs: TIMEOUTS.SHELL_COMMAND_MS,
      });
    } catch {
      // best-effort
    }
  }

  /**
   * Build the `adb shell am instrument` command for launching the helper.
   * Returns the full command string — caller is responsible for executing it
   * (typically as a long-lived background process via the shell executor).
   */
  buildInstrumentCommand(testPackage: string, runner: string): string {
    return this.buildShellCommand(`${ADB_COMMANDS_EXT.AM_INSTRUMENT} ${testPackage}/${runner}`);
  }

  // -----------------------------------------------------------------------
  // AgenTest Idling Bridge (Phase 3.10)
  // -----------------------------------------------------------------------

  /**
   * Query the opt-in AgenTest idling bridge ContentProvider (if the user's
   * app includes the `agentest-idling-bridge` AAR). Returns `null` when the
   * provider is absent, unresolvable, or `content query` failed — callers
   * treat null as "no idle bridge attached, skip this sync channel".
   *
   * Wire format (from `AgenTestIdlingProvider`):
   *   `Row: 0 idle_count=<N>, idle_names=<csv>, version=<N>`
   *
   * The `content query` CLI is available since API 21. Output is a series
   * of `Row: <N> col=val, col=val, ...` lines. We parse the first row only.
   *
   * The returned `version` comes straight from the bridge's cursor so
   * callers can detect stale AARs (user updated AgenTest via npm but hasn't
   * rebuilt their app to pick up the new AAR from node_modules).
   */
  async queryIdlingBridge(
    packageName: string,
  ): Promise<{ idleCount: number; busy: string[]; version: number } | null> {
    const authority = `${packageName}${IDLING_BRIDGE.AUTHORITY_SUFFIX}`;
    const uri = `content://${authority}/${IDLING_BRIDGE.QUERY_PATH}`;
    let output: string;
    try {
      output = await this.shell.exec(
        this.buildShellCommand(`${ADB_COMMANDS_EXT.CONTENT_QUERY} --uri ${uri}`),
        { timeoutMs: IDLING_BRIDGE.QUERY_TIMEOUT_MS },
      );
    } catch {
      return null;
    }

    const firstRow = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('Row:'));
    if (!firstRow) {
      // `content query` prints "No result found." when the provider is
      // unregistered — same as absent for our purposes.
      return null;
    }

    // Row: 0 idle_count=2, idle_names=NetworkIdling,DbIdling, version=1
    const match = /idle_count=(\d+).*?idle_names=([^,]*(?:,[^,]*)*?),\s*version=(\d+)/.exec(
      firstRow,
    );
    if (!match) {
      return null;
    }
    const idleCount = Number(match[1]);
    const busyCsv = match[2] ?? '';
    const version = Number(match[3]);
    const busy = busyCsv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { idleCount, busy, version };
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
