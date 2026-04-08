import { describe, expect, it } from 'vitest';
import { AdbClient } from '../android/adb.js';
import { AdbCommandError, AdbConnectionError } from '../errors.js';
import { MockShellExecutor } from './mock-shell.js';

function createMockAdb() {
  const shell = new MockShellExecutor();
  const adb = new AdbClient(shell);
  return { shell, adb };
}

// ---------------------------------------------------------------------------
// getConnectedDevices
// ---------------------------------------------------------------------------

describe('AdbClient.getConnectedDevices', () => {
  it('parses device list correctly', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('devices', 'List of devices attached\nemulator-5554\tdevice\n\n');

    const devices = await adb.getConnectedDevices();
    expect(devices).toEqual(['emulator-5554']);
  });

  it('returns empty array when no devices', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('devices', 'List of devices attached\n\n');

    const devices = await adb.getConnectedDevices();
    expect(devices).toEqual([]);
  });

  it('parses multiple devices', async () => {
    const { shell, adb } = createMockAdb();
    shell.when(
      'devices',
      'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n\n',
    );

    const devices = await adb.getConnectedDevices();
    expect(devices).toEqual(['emulator-5554', 'emulator-5556']);
  });

  it('ignores offline devices', async () => {
    const { shell, adb } = createMockAdb();
    shell.when(
      'devices',
      'List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n\n',
    );

    const devices = await adb.getConnectedDevices();
    expect(devices).toEqual(['emulator-5554']);
  });
});

// ---------------------------------------------------------------------------
// assertDeviceConnected
// ---------------------------------------------------------------------------

describe('AdbClient.assertDeviceConnected', () => {
  it('passes when device is connected', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('devices', 'List of devices attached\nemulator-5554\tdevice\n\n');

    await expect(adb.assertDeviceConnected()).resolves.toBeUndefined();
  });

  it('throws when no devices connected', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('devices', 'List of devices attached\n\n');

    await expect(adb.assertDeviceConnected()).rejects.toThrow(AdbConnectionError);
  });

  it('throws when specific device not found', async () => {
    const shell = new MockShellExecutor();
    shell.when('devices', 'List of devices attached\nemulator-5554\tdevice\n\n');
    const adb = new AdbClient(shell, 'emulator-9999');

    await expect(adb.assertDeviceConnected()).rejects.toThrow(AdbConnectionError);
  });
});

// ---------------------------------------------------------------------------
// launchApp
// ---------------------------------------------------------------------------

describe('AdbClient.launchApp', () => {
  it('builds correct monkey command', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('monkey', 'Events injected: 1\n');

    await adb.launchApp('com.example.myapp');

    const calls = shell.getCallsMatching('monkey');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('monkey -p com.example.myapp');
    expect(calls[0]).toContain('-c android.intent.category.LAUNCHER');
    expect(calls[0]).toContain('1');
  });

  it('throws when no launcher activity found', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('monkey', 'No activities found to run');

    await expect(adb.launchApp('com.bad.app')).rejects.toThrow(AdbCommandError);
  });
});

// ---------------------------------------------------------------------------
// forceStopApp
// ---------------------------------------------------------------------------

describe('AdbClient.forceStopApp', () => {
  it('sends force-stop command', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('force-stop', '');

    await adb.forceStopApp('com.example.myapp');

    const calls = shell.getCallsMatching('force-stop');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('am force-stop com.example.myapp');
  });
});

// ---------------------------------------------------------------------------
// dumpUiTree
// ---------------------------------------------------------------------------

describe('AdbClient.dumpUiTree', () => {
  it('dumps and reads the UI tree', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('uiautomator dump', 'UI hierchary dumped to: /sdcard/window_dump.xml\n');
    shell.when(
      'cat /sdcard/window_dump.xml',
      '<hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,1920]" /></hierarchy>',
    );

    const xml = await adb.dumpUiTree();
    expect(xml).toContain('<hierarchy');
    expect(xml).toContain('FrameLayout');
  });

  it('throws when dump returns no XML', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('uiautomator dump', 'OK\n');
    shell.when('cat /sdcard/window_dump.xml', 'ERROR: could not get idle state');

    await expect(adb.dumpUiTree()).rejects.toThrow(AdbCommandError);
  });
});

// ---------------------------------------------------------------------------
// Input injection
// ---------------------------------------------------------------------------

describe('AdbClient.tap', () => {
  it('sends correct tap command', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('input tap', '');

    await adb.tap(540, 960);

    const calls = shell.getCallsMatching('input tap');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('input tap 540 960');
  });

  it('rounds coordinates', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('input tap', '');

    await adb.tap(540.7, 960.3);

    const calls = shell.getCallsMatching('input tap');
    expect(calls[0]).toContain('input tap 541 960');
  });
});

describe('AdbClient.type', () => {
  it('sends text command', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('input text', '');

    await adb.type('hello');

    const calls = shell.getCallsMatching('input text');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('input text');
    expect(calls[0]).toContain('hello');
  });

  it('escapes spaces', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('input text', '');

    await adb.type('hello world');

    const calls = shell.getCallsMatching('input text');
    expect(calls[0]).toContain('hello%sworld');
  });
});

describe('AdbClient.swipe', () => {
  it('sends swipe command with duration', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('input swipe', '');

    await adb.swipe(100, 200, 300, 400, 500);

    const calls = shell.getCallsMatching('input swipe');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('input swipe 100 200 300 400 500');
  });
});

describe('AdbClient.keyEvent', () => {
  it('sends keyevent command', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('input keyevent', '');

    await adb.keyEvent('KEYCODE_BACK');

    const calls = shell.getCallsMatching('input keyevent');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('input keyevent KEYCODE_BACK');
  });
});

describe('AdbClient.longPress', () => {
  it('sends zero-distance swipe for long press', async () => {
    const { shell, adb } = createMockAdb();
    shell.when('input swipe', '');

    await adb.longPress(540, 960, 1000);

    const calls = shell.getCallsMatching('input swipe');
    expect(calls).toHaveLength(1);
    // Same start and end coordinates
    expect(calls[0]).toContain('input swipe 540 960 540 960 1000');
  });
});

// ---------------------------------------------------------------------------
// Device-specific commands
// ---------------------------------------------------------------------------

describe('AdbClient with deviceId', () => {
  it('includes -s flag in commands', async () => {
    const shell = new MockShellExecutor();
    shell.when('devices', 'List of devices attached\nemulator-5554\tdevice\n\n');
    const adb = new AdbClient(shell, 'emulator-5554');

    await adb.getConnectedDevices();

    const calls = shell.getCalls();
    expect(calls[0]).toContain('adb -s emulator-5554');
  });
});
