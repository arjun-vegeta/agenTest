/**
 * Auto-install + launch the AgenTest helper APK on first connect.
 *
 * Zero user input required: the prebuilt APKs ship inside the npm package
 * (under android-helper/prebuilt/), and this module's `ensureHelper` function
 * checks installed versions, installs the APKs if needed, sets up `adb
 * forward`, fires `am instrument` as a background process, and polls
 * /status until the device-side server is ready.
 *
 * UX guarantee: ensureHelper never throws on a survivable failure. It either
 * returns a healthy HelperClient or returns null so callers can transparently
 * fall back to the slower ADB / gRPC paths.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAdbPath } from '../adb-path.js';

import { HELPER } from '../constants.js';
import type { ShellExecutor } from '../types.js';
import { AdbClient } from './adb.js';
import { HelperClient, type HelperStatus } from './helper-client.js';

export interface HelperHandle {
  client: HelperClient;
  status: HelperStatus;
  /** Stop the helper: kill instrumentation, remove forward, optionally uninstall. */
  shutdown(uninstall?: boolean): Promise<void>;
}

export interface EnsureHelperOptions {
  /**
   * Override the startup readiness timeout. Useful for tests that don't have
   * a real emulator and want failure to surface quickly. Defaults to
   * HELPER.STARTUP_TIMEOUT_MS (30s in production).
   */
  startupTimeoutMs?: number;
}

interface PrebuiltApks {
  main: string;
  test: string;
}

/**
 * Locate the prebuilt APKs shipped inside the npm package.
 *
 * Resolution order:
 *  1. Sibling android-helper/prebuilt/ relative to this source file (dev mode)
 *  2. android-helper/prebuilt/ relative to dist/ (production builds)
 *  3. AGENTEST_HELPER_APK_DIR env var (test/CI escape hatch)
 *
 * Returns null if neither APK can be found — the caller falls back to ADB.
 */
function findPrebuiltApks(): PrebuiltApks | null {
  const envDir = process.env['AGENTEST_HELPER_APK_DIR'];
  if (envDir) {
    // Env var is authoritative: use it or fail. This makes tests that point
    // at a nonexistent directory return null cleanly instead of accidentally
    // falling back to a real APK in the dev tree.
    const main = resolve(envDir, HELPER.MAIN_APK_FILENAME);
    const test = resolve(envDir, HELPER.TEST_APK_FILENAME);
    return existsSync(main) && existsSync(test) ? { main, test } : null;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  // src/android/helper-installer.ts -> ../../android-helper/prebuilt
  // dist/android/helper-installer.js -> ../../android-helper/prebuilt
  const candidates = [
    resolve(here, '..', '..', 'android-helper', 'prebuilt'),
    resolve(here, '..', '..', '..', 'android-helper', 'prebuilt'),
  ];
  for (const dir of candidates) {
    const main = resolve(dir, HELPER.MAIN_APK_FILENAME);
    const test = resolve(dir, HELPER.TEST_APK_FILENAME);
    if (existsSync(main) && existsSync(test)) return { main, test };
  }
  return null;
}

/**
 * Top-level: ensure the helper is installed and running, return a client.
 *
 * Steps:
 *   1. Locate prebuilt APKs (return null if missing → fallback path)
 *   2. Compare installed versionCode against MIN_VERSION_CODE; reinstall if stale
 *   3. Set up `adb forward HOST_PORT -> DEVICE_PORT`
 *   4. Spawn `am instrument` as a background child process
 *   5. Poll /status until ready (or timeout)
 *   6. Return the HelperHandle
 */
export async function ensureHelper(
  shell: ShellExecutor,
  deviceId?: string,
  options: EnsureHelperOptions = {},
): Promise<HelperHandle | null> {
  // Test escape hatch: tests run against MockShellExecutor and can't install
  // a real APK. They set AGENTEST_DISABLE_HELPER=1 so this returns null and
  // the rest of the connect flow falls back to the ADB+gRPC path.
  if (process.env['AGENTEST_DISABLE_HELPER'] === '1') {
    return null;
  }

  const apks = findPrebuiltApks();
  if (!apks) {
    // Helper APKs not bundled — running from a partial source checkout, or
    // the build tree was tampered with. Fall back gracefully.
    return null;
  }

  const adb = new AdbClient(shell, deviceId);

  // Step 1: ensure both APKs are installed at the right version
  await ensureInstalled(adb, apks);

  // Step 2: tear down any stale forward + instrumentation from a previous run
  await adb.removeForward(HELPER.HOST_PORT);
  // Best-effort: kill any existing instrumentation. We don't have a clean
  // PID, so we POST /shutdown to whatever might be running on the port. The
  // call is allowed to fail.
  try {
    const stale = new HelperClient(HELPER.HOST_PORT);
    const staleStatus = await stale.status(500);
    if (staleStatus) {
      await stale.shutdown();
      await sleep(200);
    }
  } catch {
    // ignore
  }

  // Step 3: forward host port to device port
  await adb.forwardPort(HELPER.HOST_PORT, HELPER.DEVICE_PORT);

  // Step 4: launch am instrument as a background process. We use spawn
  // directly here (not the ShellExecutor) because we need a long-lived child
  // we can kill on shutdown — ShellExecutor.exec returns a Promise<string>
  // that resolves only when the process exits.
  const instrumentationProc = spawnInstrumentation(deviceId);
  if (!instrumentationProc) {
    await adb.removeForward(HELPER.HOST_PORT);
    return null;
  }

  // Step 5: poll /status until ready
  const client = new HelperClient(HELPER.HOST_PORT);
  let status: HelperStatus;
  try {
    status = await client.waitForReady(options.startupTimeoutMs);
  } catch (err) {
    // Tear down on failure so we don't leak the child process
    instrumentationProc.kill('SIGTERM');
    await adb.removeForward(HELPER.HOST_PORT);
    console.error(
      `[agentest] helper failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  return {
    client,
    status,
    async shutdown(uninstall = false) {
      try {
        await client.shutdown();
      } catch {
        // ignore
      }
      instrumentationProc.kill('SIGTERM');
      await adb.removeForward(HELPER.HOST_PORT);
      if (uninstall) {
        await adb.uninstallPackage(HELPER.TEST_PACKAGE);
        await adb.uninstallPackage(HELPER.PACKAGE);
      }
    },
  };
}

/**
 * Install (or reinstall) the helper APKs if the on-device version is missing
 * or stale. Reinstalls both APKs together because they're a signed pair.
 */
async function ensureInstalled(adb: AdbClient, apks: PrebuiltApks): Promise<void> {
  const [mainInstalled, testInstalled] = await Promise.all([
    adb.isPackageInstalled(HELPER.PACKAGE),
    adb.isPackageInstalled(HELPER.TEST_PACKAGE),
  ]);

  let needsReinstall = !mainInstalled || !testInstalled;
  if (mainInstalled) {
    const versionCode = await adb.getPackageVersionCode(HELPER.PACKAGE);
    if (versionCode === null || versionCode < HELPER.MIN_VERSION_CODE) {
      needsReinstall = true;
    }
  }

  if (!needsReinstall) return;

  // Uninstall any half-installed pair so signatures don't conflict.
  if (mainInstalled) await adb.uninstallPackage(HELPER.PACKAGE);
  if (testInstalled) await adb.uninstallPackage(HELPER.TEST_PACKAGE);

  // Install main first (the test APK targets it).
  await adb.installApk(apks.main);
  await adb.installApk(apks.test);
}

/**
 * Spawn `adb shell am instrument` as a long-running background process.
 *
 * The process stays alive for the duration of the MCP session — the on-device
 * helper blocks on a CountDownLatch until it receives /shutdown. We capture
 * stdout/stderr to avoid pipe buffer fill-up and surface fatal errors.
 */
function spawnInstrumentation(deviceId?: string): ChildProcess | null {
  const args: string[] = [];
  if (deviceId) {
    args.push('-s', deviceId);
  }
  args.push('shell', 'am', 'instrument', '-w', '-r', `${HELPER.TEST_PACKAGE}/${HELPER.RUNNER}`);

  const adbBinary = resolveAdbPath();

  let proc: ChildProcess;
  try {
    proc = spawn(adbBinary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (err) {
    console.error(
      `[agentest helper] failed to spawn am instrument: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // Drain pipes so the OS doesn't backpressure the device-side server.
  proc.stdout?.on('data', (chunk: Buffer) => {
    // The instrumentation runner prints status lines like
    // "INSTRUMENTATION_STATUS: ...". They're informational; we don't parse
    // them but we do log on stderr if the helper crashes.
    const text = chunk.toString();
    if (text.includes('INSTRUMENTATION_FAILED') || text.includes('Process crashed')) {
      console.error(`[agentest helper] ${text.trim()}`);
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[agentest helper] ${chunk.toString().trim()}`);
  });
  proc.on('error', (err) => {
    console.error(`[agentest helper] failed to spawn am instrument: ${err.message}`);
  });

  return proc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
