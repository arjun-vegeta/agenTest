import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConnect, autoDetectPlatform } from '../tools/connect.js';
import { AdbClient } from '../android/adb.js';
import { SimctlClient } from '../ios/simctl.js';
import { WdaRunner } from '../ios/wda-runner.js';
import { WdaClient } from '../ios/wda-client.js';
import { MockShellExecutor } from './mock-shell.js';
import { RefRegistry } from '../android/ref-registry.js';

const mockDevicesJson = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
      {
        udid: 'UDID-1234',
        name: 'iPhone 15',
        state: 'Booted',
        isAvailable: true,
      },
    ],
  },
});

describe('iOS Connection Router & Auto-Detection', () => {
  let shell: MockShellExecutor;

  beforeEach(() => {
    shell = new MockShellExecutor();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('autoDetectPlatform', () => {
    it('returns android when only Android has active devices', async () => {
      vi.spyOn(AdbClient.prototype, 'getConnectedDevices').mockResolvedValue(['emulator-5554']);
      vi.spyOn(SimctlClient.prototype, 'getBootedDevices').mockResolvedValue([]);

      const platform = await autoDetectPlatform(shell);
      expect(platform).toBe('android');
    });

    it('returns ios when only iOS has booted simulators', async () => {
      vi.spyOn(AdbClient.prototype, 'getConnectedDevices').mockResolvedValue([]);
      vi.spyOn(SimctlClient.prototype, 'getBootedDevices').mockResolvedValue(['UDID-1234']);

      const platform = await autoDetectPlatform(shell);
      expect(platform).toBe('ios');
    });

    it('throws PLATFORM_CONFLICT when both platforms have active devices', async () => {
      vi.spyOn(AdbClient.prototype, 'getConnectedDevices').mockResolvedValue(['emulator-5554']);
      vi.spyOn(SimctlClient.prototype, 'getBootedDevices').mockResolvedValue(['UDID-1234']);

      await expect(autoDetectPlatform(shell)).rejects.toThrow(
        /Both Android and iOS active devices\/simulators were detected/,
      );
    });

    it('throws NO_DEVICES_FOUND when neither platform has active devices', async () => {
      vi.spyOn(AdbClient.prototype, 'getConnectedDevices').mockResolvedValue([]);
      vi.spyOn(SimctlClient.prototype, 'getBootedDevices').mockResolvedValue([]);

      await expect(autoDetectPlatform(shell)).rejects.toThrow(
        /No active Android devices\/emulators or iOS Simulators were detected/,
      );
    });
  });

  describe('handleConnect Routing', () => {
    it('successfully connects to iOS platform', async () => {
      // Mock shell commands
      shell.when('list devices --json', mockDevicesJson);
      shell.when('boot UDID-1234', '');
      shell.when('launch UDID-1234 com.example.app', 'Launched com.example.app');

      // Mock WDA Runner & Client
      vi.spyOn(WdaRunner.prototype, 'start').mockResolvedValue();
      vi.spyOn(WdaClient.prototype, 'ensureSession').mockResolvedValue('session-id-123');
      vi.spyOn(WdaClient.prototype, 'getSource').mockResolvedValue({
        type: 'XCUIElementTypeApplication',
        name: 'TestApp',
        rect: { x: 0, y: 0, width: 375, height: 812 },
        children: [
          {
            type: 'XCUIElementTypeButton',
            name: 'btn',
            label: 'Click Me',
            rect: { x: 10, y: 20, width: 100, height: 40 },
            enabled: true,
          },
        ],
      });

      const registry = new RefRegistry();

      const res = await handleConnect(
        shell,
        'com.example.app',
        'UDID-1234',
        'auto',
        undefined,
        undefined,
        undefined,
        registry,
        'ios',
      );

      expect(res.platform).toBe('ios');
      expect(res.deviceId).toBe('UDID-1234');
      expect(res.packageName).toBe('com.example.app');
      expect(res.backend).toBe('wda');
      expect(res.uiTree).toContain('@b1 btn "Click Me"');
      expect(res.wdaRunner).toBeDefined();
    });
  });
});
