/**
 * Tests for the Phase 3 helper-lifecycle methods added to AdbClient:
 * installApk, uninstallPackage, isPackageInstalled, getPackageVersionCode,
 * forwardPort, removeForward, buildInstrumentCommand.
 */

import { describe, expect, it } from 'vitest';
import { AdbClient } from '../android/adb.js';
import { HELPER } from '../constants.js';
import { MockShellExecutor } from './mock-shell.js';

describe('AdbClient helper lifecycle methods', () => {
  it('installApk runs adb install -r -t with the path', async () => {
    const shell = new MockShellExecutor().when('install -r -t', 'Success');
    const adb = new AdbClient(shell, 'emulator-5554');
    await adb.installApk('/tmp/some.apk');
    const call = shell.getCalls()[0];
    expect(call).toContain('-s emulator-5554');
    expect(call).toContain('install -r -t');
    expect(call).toContain('/tmp/some.apk');
  });

  it('uninstallPackage swallows "not installed" errors', async () => {
    const shell = new MockShellExecutor().when('uninstall', 'DELETE_FAILED_INTERNAL_ERROR');
    // Override exec to throw with "not installed" message
    const errorShell = new MockShellExecutor();
    errorShell.exec = async (command: string) => {
      if (command.includes('uninstall')) {
        throw new Error('Failure: not installed for user 0');
      }
      return shell.exec(command);
    };
    const adb = new AdbClient(errorShell);
    // Should not throw
    await expect(adb.uninstallPackage('com.example')).resolves.toBeUndefined();
  });

  it('uninstallPackage throws on unrelated errors', async () => {
    const shell = new MockShellExecutor();
    shell.exec = async () => {
      throw new Error('Unknown ADB error');
    };
    const adb = new AdbClient(shell);
    await expect(adb.uninstallPackage('com.example')).rejects.toThrow(/Unknown ADB error/);
  });

  it('isPackageInstalled returns true when pm list contains exact match', async () => {
    const shell = new MockShellExecutor().when(
      'pm list packages com.agentest.helper',
      'package:com.agentest.helper\n',
    );
    const adb = new AdbClient(shell);
    expect(await adb.isPackageInstalled('com.agentest.helper')).toBe(true);
  });

  it('isPackageInstalled returns false when pm list is empty', async () => {
    const shell = new MockShellExecutor().when('pm list packages com.example', '');
    const adb = new AdbClient(shell);
    expect(await adb.isPackageInstalled('com.example')).toBe(false);
  });

  it('isPackageInstalled distinguishes substring matches', async () => {
    // pm list with `com.example` filter would match com.example.thing too,
    // so isPackageInstalled needs to check for the exact line.
    const shell = new MockShellExecutor().when(
      'pm list packages com.agentest.helper',
      'package:com.agentest.helper.test\n',
    );
    const adb = new AdbClient(shell);
    // Only the .test variant is present — main package is not installed.
    expect(await adb.isPackageInstalled('com.agentest.helper')).toBe(false);
  });

  it('getPackageVersionCode parses dumpsys output', async () => {
    const dumpsys = `
Packages:
  Package [com.agentest.helper] (12345):
    versionCode=42 minSdk=24 targetSdk=34
    versionName=1.0.0
    `.trim();
    const shell = new MockShellExecutor().when('dumpsys package com.agentest.helper', dumpsys);
    const adb = new AdbClient(shell);
    expect(await adb.getPackageVersionCode('com.agentest.helper')).toBe(42);
  });

  it('getPackageVersionCode returns null when dumpsys fails', async () => {
    const shell = new MockShellExecutor();
    shell.exec = async () => {
      throw new Error('package not found');
    };
    const adb = new AdbClient(shell);
    expect(await adb.getPackageVersionCode('nope')).toBeNull();
  });

  it('forwardPort builds correct adb forward command', async () => {
    const shell = new MockShellExecutor().when('forward tcp:', '');
    const adb = new AdbClient(shell, 'emulator-5554');
    await adb.forwardPort(HELPER.HOST_PORT, HELPER.DEVICE_PORT);
    const call = shell.getCalls()[0];
    expect(call).toContain('-s emulator-5554');
    expect(call).toContain('forward');
    expect(call).toContain(`tcp:${HELPER.HOST_PORT}`);
    expect(call).toContain(`tcp:${HELPER.DEVICE_PORT}`);
  });

  it('removeForward swallows errors', async () => {
    const shell = new MockShellExecutor();
    shell.exec = async () => {
      throw new Error('not found');
    };
    const adb = new AdbClient(shell);
    await expect(adb.removeForward(8765)).resolves.toBeUndefined();
  });

  it('buildInstrumentCommand wraps am instrument in quoted shell command', () => {
    const shell = new MockShellExecutor();
    const adb = new AdbClient(shell, 'emulator-5554');
    const cmd = adb.buildInstrumentCommand(HELPER.TEST_PACKAGE, HELPER.RUNNER);
    expect(cmd).toContain('-s emulator-5554');
    expect(cmd).toContain('shell');
    expect(cmd).toContain('am instrument');
    expect(cmd).toContain(`${HELPER.TEST_PACKAGE}/${HELPER.RUNNER}`);
  });
});
