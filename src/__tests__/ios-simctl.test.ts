import { describe, expect, it } from 'vitest';
import { SimctlClient } from '../ios/simctl.js';
import { SimctlCommandError, SimctlConnectionError } from '../errors.js';
import { MockShellExecutor } from './mock-shell.js';

function createMockSimctl(udid?: string) {
  const shell = new MockShellExecutor();
  const simctl = new SimctlClient(shell, udid);
  return { shell, simctl };
}

const mockDevicesJson = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
      {
        udid: 'E8A2F2B1-40F1-42DF-8692-054527DF8100',
        name: 'iPhone 15',
        state: 'Shutdown',
        isAvailable: true,
      },
      {
        udid: 'A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D',
        name: 'iPhone 15 Pro',
        state: 'Booted',
        isAvailable: true,
      },
      {
        udid: 'NOT-AVAILABLE-UDID',
        name: 'iPhone 14',
        state: 'Booted',
        isAvailable: false,
      },
    ],
  },
});

describe('SimctlClient.getDevices', () => {
  it('parses available devices correctly', async () => {
    const { shell, simctl } = createMockSimctl();
    shell.when('list devices --json', mockDevicesJson);

    const devices = await simctl.getDevices();
    expect(devices).toHaveLength(2);
    expect(devices[0]?.name).toBe('iPhone 15');
    expect(devices[1]?.name).toBe('iPhone 15 Pro');
    expect(devices.map((d) => d.udid)).not.toContain('NOT-AVAILABLE-UDID');
  });

  it('throws SimctlCommandError on execution failure', async () => {
    const { simctl } = createMockSimctl();

    await expect(simctl.getDevices()).rejects.toThrow(SimctlCommandError);
  });
});

describe('SimctlClient.getBootedDevices', () => {
  it('filters only booted devices', async () => {
    const { shell, simctl } = createMockSimctl();
    shell.when('list devices --json', mockDevicesJson);

    const booted = await simctl.getBootedDevices();
    expect(booted).toEqual(['A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D']);
  });
});

describe('SimctlClient.assertDeviceConnected', () => {
  it('passes when simulator is booted', async () => {
    const { shell, simctl } = createMockSimctl('A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D');
    shell.when('list devices --json', mockDevicesJson);

    await expect(simctl.assertDeviceConnected()).resolves.toBeUndefined();
  });

  it('throws when specific simulator is not booted', async () => {
    const { shell, simctl } = createMockSimctl('E8A2F2B1-40F1-42DF-8692-054527DF8100');
    shell.when('list devices --json', mockDevicesJson);

    await expect(simctl.assertDeviceConnected()).rejects.toThrow(SimctlConnectionError);
  });

  it('throws when no simulators are booted', async () => {
    const { shell, simctl } = createMockSimctl('A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D');
    shell.when(
      'list devices --json',
      JSON.stringify({
        devices: {
          'iOS 17.0': [
            {
              udid: 'A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D',
              name: 'iPhone 15 Pro',
              state: 'Shutdown',
              isAvailable: true,
            },
          ],
        },
      }),
    );

    await expect(simctl.assertDeviceConnected()).rejects.toThrow(SimctlConnectionError);
  });
});

describe('SimctlClient.boot', () => {
  it('skips booting if simulator is already booted', async () => {
    const { shell, simctl } = createMockSimctl('A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D');
    shell.when('list devices --json', mockDevicesJson);

    await simctl.boot();
    const calls = shell.getCallsMatching('boot');
    expect(calls).toHaveLength(0);
  });

  it('calls boot command when simulator is shutdown', async () => {
    const { shell, simctl } = createMockSimctl('E8A2F2B1-40F1-42DF-8692-054527DF8100');
    shell.when('list devices --json', mockDevicesJson);
    shell.when('boot E8A2F2B1-40F1-42DF-8692-054527DF8100', '');

    await simctl.boot();
    const calls = shell.getCallsMatching('boot');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('boot E8A2F2B1-40F1-42DF-8692-054527DF8100');
  });

  it('throws SimctlConnectionError when no UDID is set', async () => {
    const { simctl } = createMockSimctl();
    await expect(simctl.boot()).rejects.toThrow(SimctlConnectionError);
  });
});

describe('SimctlClient app operations', () => {
  it('installs the application correctly', async () => {
    const { shell, simctl } = createMockSimctl('A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D');
    shell.when('install A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D /path/to/app.app', '');

    await simctl.installApp('/path/to/app.app');
    const calls = shell.getCallsMatching('install');
    expect(calls).toHaveLength(1);
  });

  it('uninstalls the application correctly', async () => {
    const { shell, simctl } = createMockSimctl('A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D');
    shell.when('uninstall A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D com.example.app', '');

    await simctl.uninstallApp('com.example.app');
    const calls = shell.getCallsMatching('uninstall');
    expect(calls).toHaveLength(1);
  });

  it('launches the application correctly after boot check', async () => {
    const { shell, simctl } = createMockSimctl('A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D');
    shell.when('list devices --json', mockDevicesJson);
    shell.when(
      'launch A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D com.example.app',
      'com.example.app: 12345\n',
    );

    await simctl.launchApp('com.example.app');
    const calls = shell.getCallsMatching('launch');
    expect(calls).toHaveLength(1);
  });

  it('terminates the application correctly', async () => {
    const { shell, simctl } = createMockSimctl('A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D');
    shell.when('terminate A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D com.example.app', '');

    await simctl.terminateApp('com.example.app');
    const calls = shell.getCallsMatching('terminate');
    expect(calls).toHaveLength(1);
  });
});

describe('SimctlClient.takeScreenshot', () => {
  it('runs io screenshot command correctly', async () => {
    const { shell, simctl } = createMockSimctl('A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D');
    shell.when('io A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D screenshot /tmp/snap.png', '');

    await simctl.takeScreenshot('/tmp/snap.png');
    const calls = shell.getCallsMatching('io');
    expect(calls).toHaveLength(1);
  });
});
