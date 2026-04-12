/**
 * Auto-discover the `adb` binary path. Checks standard SDK locations so users
 * don't need to configure PATH manually.
 *
 * Resolution order:
 *  1. ANDROID_HOME/platform-tools/adb
 *  2. ANDROID_SDK_ROOT/platform-tools/adb
 *  3. ~/Library/Android/sdk/platform-tools/adb  (macOS default)
 *  4. ~/Android/Sdk/platform-tools/adb          (Linux default)
 *  5. %LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe (Windows)
 *  6. Bare 'adb' (hope it's on PATH)
 */

import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

let cached: string | undefined;

export function resolveAdbPath(): string {
  if (cached) return cached;

  const isWin = platform() === 'win32';
  const bin = isWin ? 'adb.exe' : 'adb';
  const suffix = join('platform-tools', bin);

  const candidates: string[] = [];

  // Env vars first
  const androidHome = process.env['ANDROID_HOME'];
  if (androidHome) candidates.push(join(androidHome, suffix));

  const sdkRoot = process.env['ANDROID_SDK_ROOT'];
  if (sdkRoot) candidates.push(join(sdkRoot, suffix));

  // Platform-specific default SDK locations
  const home = homedir();
  if (platform() === 'darwin') {
    candidates.push(join(home, 'Library', 'Android', 'sdk', suffix));
  } else if (isWin) {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData) candidates.push(join(localAppData, 'Android', 'Sdk', suffix));
  } else {
    // Linux
    candidates.push(join(home, 'Android', 'Sdk', suffix));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cached = candidate;
      return cached;
    }
  }

  // Fallback: bare 'adb' — works if it's on PATH
  cached = bin;
  return cached;
}
