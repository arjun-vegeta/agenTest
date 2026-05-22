import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WdaRunner } from '../ios/wda-runner.js';
import { WdaConnectionError } from '../errors.js';
import net from 'node:net';
import fs from 'node:fs';

describe('WdaRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('findPrecompiledXctestrun', () => {
    it('returns dummy path in test mode', () => {
      const path = WdaRunner.findPrecompiledXctestrun();
      expect(path).toBe('/mock/path/WebDriverAgentRunner.xctestrun');
    });

    it('prefers environmental override if present and exists', () => {
      process.env['AGENTEST_WDA_XCTESTRUN_PATH'] = '/custom/path/WDA.xctestrun';
      const existsMock = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      const path = WdaRunner.findPrecompiledXctestrun();
      expect(path).toBe('/custom/path/WDA.xctestrun');
      expect(existsMock).toHaveBeenCalledWith('/custom/path/WDA.xctestrun');
      delete process.env['AGENTEST_WDA_XCTESTRUN_PATH'];
    });
  });

  describe('isPortAvailable', () => {
    it('returns true for free ports and false for bound ports', async () => {
      // Find a port
      const port = 9023;
      const available = await WdaRunner.isPortAvailable(port);
      expect(available).toBe(true);

      // Bind to it
      const server = net.createServer();
      await new Promise<void>((res) => {
        server.listen(port, '127.0.0.1', () => res());
      });

      const availableAfter = await WdaRunner.isPortAvailable(port);
      expect(availableAfter).toBe(false);

      await new Promise<void>((res) => {
        server.close(() => res());
      });
    });
  });

  describe('findFreePort', () => {
    it('finds the first available port', async () => {
      const port = await WdaRunner.findFreePort(12000);
      expect(port).toBeGreaterThanOrEqual(12000);
    });
  });

  describe('start & liveness', () => {
    it('succeeds immediately if checkLiveness returns true', async () => {
      const runner = new WdaRunner('some-udid', 8100);
      
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ value: { state: 'success' } }),
      } as Response);

      await runner.start();
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8100/status', expect.any(Object));
    });

    it('launches mock successfully', async () => {
      const runner = new WdaRunner('some-udid', 8101);
      
      // First call false (not running), then mock start returns instantly in test mode
      vi.spyOn(runner, 'checkLiveness').mockResolvedValue(false);

      await runner.start();
      // Should not throw, and should bypass real xcodebuild spawn due to mock path
    });

    it('throws WdaConnectionError if checkLiveness fails repeatedly until timeout', async () => {
      const runner = new WdaRunner('some-udid', 8102, {
        xctestrunPath: '/custom/dummy.xctestrun', // bypasses test escape hatch to force spawn path
      });

      vi.spyOn(runner, 'checkLiveness').mockResolvedValue(false);

      const startPromise = runner.start(100);

      // Run timers to trigger timeout
      await vi.advanceTimersByTimeAsync(200);

      await expect(startPromise).rejects.toThrow(WdaConnectionError);
    });
  });
});
