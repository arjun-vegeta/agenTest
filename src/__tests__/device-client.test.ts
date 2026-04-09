import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { GrpcImage } from '../android/grpc-types.js';
import { MockShellExecutor } from './mock-shell.js';

// ---------------------------------------------------------------------------
// Mock gRPC client factory
// ---------------------------------------------------------------------------

interface MockGrpc {
  sendTouch: ReturnType<typeof vi.fn>;
  sendKey: ReturnType<typeof vi.fn>;
  getScreenshot: ReturnType<typeof vi.fn>;
  setClipboard: ReturnType<typeof vi.fn>;
  getClipboard: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
}

function createMockGrpc(connected = true): MockGrpc {
  return {
    sendTouch: vi.fn().mockResolvedValue({}),
    sendKey: vi.fn().mockResolvedValue({}),
    getScreenshot: vi.fn().mockResolvedValue({
      image: Buffer.from('fake-png'),
      format: { format: 0 },
    } satisfies GrpcImage),
    setClipboard: vi.fn().mockResolvedValue(undefined),
    getClipboard: vi.fn().mockResolvedValue('clipboard-text'),
    getStatus: vi.fn().mockResolvedValue({ booted: true }),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    isConnected: vi.fn().mockReturnValue(connected),
  };
}

// ---------------------------------------------------------------------------
// Helper: create a shell mock with basic ADB responses
// ---------------------------------------------------------------------------

function createShellWithAdbDefaults(): MockShellExecutor {
  const shell = new MockShellExecutor();
  shell.when('input tap', '');
  shell.when('input swipe', '');
  shell.when('input keyevent', '');
  shell.when('input text', '');
  shell.when('screencap', Buffer.from('adb-png').toString('binary'));
  return shell;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeviceClient', () => {
  let shell: MockShellExecutor;

  beforeEach(() => {
    shell = createShellWithAdbDefaults();
  });

  describe('with gRPC available', () => {
    it('routes tap through gRPC', async () => {
      const grpc = createMockGrpc();
      const device = new DeviceClient(shell, undefined, grpc as unknown as GrpcEmulatorClient);

      await device.tap(100, 200);

      expect(grpc.sendTouch).toHaveBeenCalled();
      expect(shell.getCallsMatching('input tap')).toHaveLength(0);
    });

    it('routes keyEvent through gRPC for mapped keycodes', async () => {
      const grpc = createMockGrpc();
      const device = new DeviceClient(shell, undefined, grpc as unknown as GrpcEmulatorClient);

      await device.keyEvent('KEYCODE_BACK');

      expect(grpc.sendKey).toHaveBeenCalledWith(expect.objectContaining({ key: 'GoBack' }));
      expect(shell.getCallsMatching('input keyevent')).toHaveLength(0);
    });

    it('falls through to ADB for unmapped keycodes', async () => {
      const grpc = createMockGrpc();
      const device = new DeviceClient(shell, undefined, grpc as unknown as GrpcEmulatorClient);

      await device.keyEvent('KEYCODE_VOLUME_UP');

      expect(grpc.sendKey).not.toHaveBeenCalled();
      expect(shell.getCallsMatching('input keyevent')).toHaveLength(1);
    });

    it('routes type through ADB even with gRPC (clipboard paste unreliable)', async () => {
      const grpc = createMockGrpc();
      const device = new DeviceClient(shell, undefined, grpc as unknown as GrpcEmulatorClient);

      await device.type('hello');

      // type always uses ADB — gRPC can't reliably do Ctrl+V paste
      expect(grpc.setClipboard).not.toHaveBeenCalled();
      expect(shell.getCallsMatching('input text')).toHaveLength(1);
    });

    it('routes captureScreenshot through gRPC', async () => {
      const grpc = createMockGrpc();
      const device = new DeviceClient(shell, undefined, grpc as unknown as GrpcEmulatorClient);

      const result = await device.captureScreenshot();

      expect(grpc.getScreenshot).toHaveBeenCalled();
      expect(result).toBe(Buffer.from('fake-png').toString('base64'));
      expect(shell.getCallsMatching('screencap')).toHaveLength(0);
    });

    it('reports backend as grpc', () => {
      const grpc = createMockGrpc();
      const device = new DeviceClient(shell, undefined, grpc as unknown as GrpcEmulatorClient);

      expect(device.backend).toBe('grpc');
    });
  });

  describe('without gRPC', () => {
    it('routes tap through ADB', async () => {
      const device = new DeviceClient(shell);

      await device.tap(100, 200);

      expect(shell.getCallsMatching('input tap')).toHaveLength(1);
    });

    it('reports backend as adb', () => {
      const device = new DeviceClient(shell);

      expect(device.backend).toBe('adb');
    });
  });

  describe('gRPC fallback on failure', () => {
    it('falls back to ADB when gRPC tap fails', async () => {
      const grpc = createMockGrpc();
      grpc.sendTouch.mockRejectedValue(new Error('gRPC unavailable'));
      const device = new DeviceClient(shell, undefined, grpc as unknown as GrpcEmulatorClient);

      // Suppress expected console.error
      const consoleSpy = vi.spyOn(console, 'error').mockReturnValue(undefined);

      await device.tap(100, 200);

      // Should have tried gRPC first, then fallen back to ADB
      expect(grpc.sendTouch).toHaveBeenCalled();
      expect(shell.getCallsMatching('input tap')).toHaveLength(1);

      // Backend should now be 'adb' after failure
      expect(device.backend).toBe('adb');

      consoleSpy.mockRestore();
    });

    it('throws in strict mode instead of falling back', async () => {
      const grpc = createMockGrpc();
      grpc.sendTouch.mockRejectedValue(new Error('gRPC unavailable'));
      const device = new DeviceClient(
        shell,
        undefined,
        grpc as unknown as GrpcEmulatorClient,
        true, // strictGrpc
      );

      await expect(device.tap(100, 200)).rejects.toThrow('gRPC unavailable');
    });
  });

  describe('always-ADB methods', () => {
    it('dumpUiTree always goes through ADB even with gRPC', async () => {
      const grpc = createMockGrpc();
      shell.when('uiautomator dump', '<hierarchy rotation="0"><node /></hierarchy>');
      const device = new DeviceClient(shell, undefined, grpc as unknown as GrpcEmulatorClient);

      const result = await device.dumpUiTree();

      expect(result).toContain('<hierarchy');
      // gRPC should not have been called for tree dump
    });
  });
});
