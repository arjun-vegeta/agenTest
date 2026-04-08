import { describe, expect, it } from 'vitest';
import { AdbClient } from '../android/adb.js';
import { LOGCAT } from '../constants.js';
import { handleDeviceInfo } from '../tools/device-info.js';
import { handleGetLogs } from '../tools/get-logs.js';
import { handleScreenshot } from '../tools/screenshot.js';
import { MockShellExecutor } from './mock-shell.js';

// ---------------------------------------------------------------------------
// lazytest_get_logs
// ---------------------------------------------------------------------------

describe('handleGetLogs', () => {
  it('returns filtered logcat output', async () => {
    const shell = new MockShellExecutor();
    shell.when('pidof com.example.myapp', '12345\n');
    shell.when(
      'logcat',
      '04-08 12:00:01.123 12345 12345 D MyApp: Started\n04-08 12:00:02.456 12345 12345 E MyApp: Error occurred\n',
    );

    const result = await handleGetLogs(shell, 'com.example.myapp');

    expect(result.packageName).toBe('com.example.myapp');
    expect(result.logs).toContain('MyApp: Started');
    expect(result.logs).toContain('Error occurred');
  });

  it('falls back to unfiltered logcat when pidof fails', async () => {
    const shell = new MockShellExecutor();
    // pidof throws — app not running
    shell.when('logcat', '04-08 12:00:01.123 System log line\n');

    const result = await handleGetLogs(shell, 'com.example.myapp');

    expect(result.logs).toContain('System log line');
  });

  it('passes maxLines parameter', async () => {
    const shell = new MockShellExecutor();
    shell.when('pidof', '12345\n');
    shell.when('logcat', 'log line 1\nlog line 2\n');

    await handleGetLogs(shell, 'com.example.myapp', 50);

    const calls = shell.getCallsMatching('logcat');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain('-t 50');
  });

  it('uses default maxLines from constants', async () => {
    const shell = new MockShellExecutor();
    shell.when('pidof', '12345\n');
    shell.when('logcat', 'log output\n');

    await handleGetLogs(shell, 'com.example.myapp');

    const calls = shell.getCallsMatching('logcat');
    expect(calls[0]).toContain(`-t ${LOGCAT.MAX_LINES}`);
  });
});

// ---------------------------------------------------------------------------
// lazytest_screenshot
// ---------------------------------------------------------------------------

describe('handleScreenshot', () => {
  it('returns base64-encoded screenshot', async () => {
    const shell = new MockShellExecutor();
    // Simulate binary PNG output
    const fakePng = '\x89PNG\r\n\x1a\nfake-image-data';
    shell.when('screencap', fakePng);

    const result = await handleScreenshot(shell);

    expect(result.imageBase64).toBeDefined();
    expect(result.imageBase64.length).toBeGreaterThan(0);
    // Should be valid base64
    expect(() => Buffer.from(result.imageBase64, 'base64')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// lazytest_device_info
// ---------------------------------------------------------------------------

describe('handleDeviceInfo', () => {
  it('returns parsed device info', async () => {
    const shell = new MockShellExecutor();
    shell.when('wm size', 'Physical size: 1080x1920\n');
    shell.when('wm density', 'Physical density: 420\n');
    shell.when('ro.build.version.sdk', '33\n');
    shell.when('ro.build.version.release', '13\n');
    shell.when('ro.product.model', 'Pixel 6\n');
    shell.when('ro.product.manufacturer', 'Google\n');

    const result = await handleDeviceInfo(shell);

    expect(result.screenWidth).toBe(1080);
    expect(result.screenHeight).toBe(1920);
    expect(result.density).toBe(420);
    expect(result.sdkVersion).toBe(33);
    expect(result.androidVersion).toBe('13');
    expect(result.model).toBe('Pixel 6');
    expect(result.manufacturer).toBe('Google');
  });

  it('handles missing/empty values gracefully', async () => {
    const shell = new MockShellExecutor();
    shell.when('wm size', 'Physical size: \n');
    shell.when('wm density', '\n');
    shell.when('ro.build.version.sdk', '\n');
    shell.when('ro.build.version.release', '\n');
    shell.when('ro.product.model', '\n');
    shell.when('ro.product.manufacturer', '\n');

    const result = await handleDeviceInfo(shell);

    expect(result.screenWidth).toBe(0);
    expect(result.screenHeight).toBe(0);
    expect(result.density).toBe(0);
    expect(result.sdkVersion).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ADB retry logic
// ---------------------------------------------------------------------------

describe('ADB retry logic', () => {
  it('retries dumpUiTree on failure', async () => {
    const shell = new MockShellExecutor();
    let dumpCallCount = 0;

    // Batched dump: single command with rm + dump + cat
    shell.exec = async () => {
      dumpCallCount++;
      if (dumpCallCount < 3) {
        throw new Error('Dump failed');
      }
      return '<hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,1920]" /></hierarchy>';
    };

    const adb = new AdbClient(shell);
    const xml = await adb.dumpUiTree();

    expect(xml).toContain('<hierarchy');
    expect(dumpCallCount).toBe(3); // Failed twice, succeeded on third
  });

  it('throws after max retry attempts', async () => {
    const shell = new MockShellExecutor();
    shell.exec = async () => {
      throw new Error('Always fails');
    };

    const adb = new AdbClient(shell);
    await expect(adb.dumpUiTree()).rejects.toThrow('Always fails');
  });
});

// ---------------------------------------------------------------------------
// System dialog detection
// ---------------------------------------------------------------------------

describe('ADB system dialog detection', () => {
  it('detects permission dialog from system package', async () => {
    const shell = new MockShellExecutor();
    const adb = new AdbClient(shell);

    // Manually construct a tree with a system dialog
    const tree = {
      id: '0',
      resourceId: '',
      className: 'android.widget.FrameLayout',
      role: 'container' as const,
      text: '',
      description: '',
      packageName: 'com.example.myapp',
      bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      center: { x: 540, y: 960 },
      index: 0,
      enabled: true,
      focused: false,
      selected: false,
      checked: false,
      checkable: false,
      clickable: false,
      scrollable: false,
      longClickable: false,
      password: false,
      actions: [],
      children: [
        {
          id: '0.0',
          resourceId: '',
          className: 'android.widget.FrameLayout',
          role: 'container' as const,
          text: '',
          description: '',
          packageName: 'com.google.android.permissioncontroller',
          bounds: { left: 100, top: 400, right: 980, bottom: 800 },
          center: { x: 540, y: 600 },
          index: 0,
          enabled: true,
          focused: false,
          selected: false,
          checked: false,
          checkable: false,
          clickable: false,
          scrollable: false,
          longClickable: false,
          password: false,
          actions: [],
          children: [
            {
              id: '0.0.0',
              resourceId: '',
              className: 'android.widget.TextView',
              role: 'text_view' as const,
              text: 'Allow MyApp to access your location?',
              description: '',
              packageName: 'com.google.android.permissioncontroller',
              bounds: { left: 120, top: 420, right: 960, bottom: 500 },
              center: { x: 540, y: 460 },
              index: 0,
              enabled: true,
              focused: false,
              selected: false,
              checked: false,
              checkable: false,
              clickable: false,
              scrollable: false,
              longClickable: false,
              password: false,
              actions: [],
              children: [],
            },
            {
              id: '0.0.1',
              resourceId: '',
              className: 'android.widget.Button',
              role: 'button' as const,
              text: 'Allow',
              description: '',
              packageName: 'com.google.android.permissioncontroller',
              bounds: { left: 550, top: 700, right: 960, bottom: 780 },
              center: { x: 755, y: 740 },
              index: 1,
              enabled: true,
              focused: false,
              selected: false,
              checked: false,
              checkable: false,
              clickable: true,
              scrollable: false,
              longClickable: false,
              password: false,
              actions: ['tap' as const],
              children: [],
            },
            {
              id: '0.0.2',
              resourceId: '',
              className: 'android.widget.Button',
              role: 'button' as const,
              text: 'Deny',
              description: '',
              packageName: 'com.google.android.permissioncontroller',
              bounds: { left: 120, top: 700, right: 530, bottom: 780 },
              center: { x: 325, y: 740 },
              index: 2,
              enabled: true,
              focused: false,
              selected: false,
              checked: false,
              checkable: false,
              clickable: true,
              scrollable: false,
              longClickable: false,
              password: false,
              actions: ['tap' as const],
              children: [],
            },
          ],
        },
      ],
    };

    const dialogs = await adb.detectSystemDialogs(tree);

    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.packageName).toBe('com.google.android.permissioncontroller');
    expect(dialogs[0]?.title).toContain('Allow MyApp');
    expect(dialogs[0]?.buttons).toContain('Allow');
    expect(dialogs[0]?.buttons).toContain('Deny');
  });

  it('returns empty when no system dialogs present', async () => {
    const shell = new MockShellExecutor();
    const adb = new AdbClient(shell);

    const tree = {
      id: '0',
      resourceId: '',
      className: 'android.widget.FrameLayout',
      role: 'container' as const,
      text: '',
      description: '',
      packageName: 'com.example.myapp',
      bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      center: { x: 540, y: 960 },
      index: 0,
      enabled: true,
      focused: false,
      selected: false,
      checked: false,
      checkable: false,
      clickable: false,
      scrollable: false,
      longClickable: false,
      password: false,
      actions: [],
      children: [],
    };

    const dialogs = await adb.detectSystemDialogs(tree);
    expect(dialogs).toHaveLength(0);
  });
});
