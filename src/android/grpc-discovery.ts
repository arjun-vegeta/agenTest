/**
 * Discovers the gRPC auth token for a running Android emulator.
 *
 * Newer emulators require JWT auth on the gRPC port. The emulator writes a
 * discovery file at:
 *   $TMPDIR/avd/running/pid_<pid>.ini  (Linux/macOS)
 *
 * macOS TMPDIR typically resolves to ~/Library/Caches/TemporaryItems/
 *
 * The file contains key=value lines including:
 *   port.serial=5554      — console port (emulator-5554)
 *   grpc.port=8554        — gRPC port
 *   grpc.token=<base64>   — bearer token for auth
 *
 * The token is sent as `authorization: Bearer <token>` metadata on each RPC.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform, tmpdir } from 'node:os';

export interface EmulatorDiscovery {
  grpcPort: number;
  token: string;
  pid: string;
}

/**
 * Returns candidate directories where emulator discovery files may live.
 *
 * The emulator writes pid_*.ini files to a temp directory, but the exact
 * location varies by OS and configuration:
 * - macOS: ~/Library/Caches/TemporaryItems/avd/running/
 * - Linux: /tmp/android-$USER/avd/running/
 * - Fallback: $TMPDIR/avd/running/
 */
function getDiscoveryDirs(): string[] {
  const dirs: string[] = [];

  if (platform() === 'darwin') {
    // macOS emulator uses ~/Library/Caches/TemporaryItems/ not $TMPDIR
    dirs.push(join(homedir(), 'Library', 'Caches', 'TemporaryItems', 'avd', 'running'));
  }

  if (platform() === 'linux') {
    // Linux emulator typically uses /tmp/android-$USER/
    const user = process.env['USER'] ?? process.env['USERNAME'] ?? '';
    if (user) {
      dirs.push(join('/tmp', `android-${user}`, 'avd', 'running'));
    }
  }

  // Always try $TMPDIR as fallback
  dirs.push(join(tmpdir(), 'avd', 'running'));

  return dirs;
}

/**
 * Parse a pid_*.ini file into a key-value map.
 */
function parseIniFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

/**
 * Discover the gRPC auth token for a running emulator by its console port.
 *
 * Scans all pid_*.ini files in the discovery directory and returns the one
 * whose `port.serial` matches the given console port.
 *
 * Returns undefined if no matching emulator is found (e.g., older emulator
 * versions that don't write discovery files, or physical devices).
 */
export async function discoverEmulatorToken(
  consolePort: number,
): Promise<EmulatorDiscovery | undefined> {
  for (const dir of getDiscoveryDirs()) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      // Directory doesn't exist — try next candidate
      continue;
    }

    const iniFiles = files.filter((f) => f.startsWith('pid_') && f.endsWith('.ini'));

    for (const iniFile of iniFiles) {
      try {
        const content = await readFile(join(dir, iniFile), 'utf-8');
        const config = parseIniFile(content);

        const serialPort = config['port.serial'];
        if (serialPort && Number(serialPort) === consolePort) {
          const token = config['grpc.token'];
          const grpcPort = config['grpc.port'];

          if (token && grpcPort) {
            const pid = iniFile.replace('pid_', '').replace('.ini', '');
            return {
              grpcPort: Number(grpcPort),
              token,
              pid,
            };
          }
        }
      } catch {
        // Skip unreadable files
        continue;
      }
    }
  }

  return undefined;
}
