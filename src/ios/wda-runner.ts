import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WdaConnectionError } from '../errors.js';

export interface WdaRunnerOptions {
  xctestrunPath?: string;
  startupTimeoutMs?: number;
}

export class WdaRunner {
  private process: ChildProcess | null = null;
  private readonly xctestrunPath: string;

  constructor(
    private readonly udid: string,
    public readonly port: number,
    options: WdaRunnerOptions = {},
  ) {
    const resolvedPath = options.xctestrunPath ?? WdaRunner.findPrecompiledXctestrun();
    if (!resolvedPath) {
      throw new WdaConnectionError(
        'Could not locate precompiled WebDriverAgentRunner.xctestrun binary in the npm bundle candidate paths.',
      );
    }
    this.xctestrunPath = resolvedPath;
  }

  /**
   * Helper to verify if a local port is open and available.
   */
  static async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((res) => {
      const server = createServer();
      server.once('error', () => {
        res(false);
      });
      server.once('listening', () => {
        server.close(() => {
          res(true);
        });
      });
      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * Scan local ports starting from 8100 and return the first available one.
   */
  static async findFreePort(startPort: number = 8100): Promise<number> {
    let port = startPort;
    while (!(await WdaRunner.isPortAvailable(port))) {
      port++;
      if (port > 65535) {
        throw new WdaConnectionError('Failed to find a free port for WebDriverAgent on localhost.');
      }
    }
    return port;
  }

  /**
   * Locate the precompiled WebDriverAgentRunner.xctestrun file.
   */
  static findPrecompiledXctestrun(): string | null {
    const envPath = process.env['AGENTEST_WDA_XCTESTRUN_PATH'];
    if (envPath && fs.existsSync(envPath)) {
      return envPath;
    }

    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '..', '..', 'ios-helper', 'prebuilt'),
      resolve(here, '..', '..', '..', 'ios-helper', 'prebuilt'),
    ];

    for (const dir of candidates) {
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          const xctestrun = files.find((f) => f.endsWith('.xctestrun'));
          if (xctestrun) {
            return resolve(dir, xctestrun);
          }
        } catch {
          // Continue scanning if readdir fails
        }
      }
    }

    // In testing or dummy mode, if no real file exists, return a dummy if we are under a test flag
    if (process.env['NODE_ENV'] === 'test' || process.env['AGENTEST_WDA_DUMMY'] === '1') {
      return '/mock/path/WebDriverAgentRunner.xctestrun';
    }

    return null;
  }

  /**
   * Check WDA liveness on the designated port.
   */
  async checkLiveness(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { value?: { state?: string } };
      return data?.value?.state === 'success';
    } catch {
      return false;
    }
  }

  /**
   * Start WDA in the background and poll its status until it is ready.
   */
  async start(startupTimeoutMs: number = 45000): Promise<void> {
    // If WDA is already running and responds to status, reuse it!
    const alreadyRunning = await this.checkLiveness();
    if (alreadyRunning) {
      console.error(`[agentest wda] WebDriverAgent is already running on port ${this.port}. Reusing.`);
      return;
    }

    if (this.xctestrunPath === '/mock/path/WebDriverAgentRunner.xctestrun') {
      // Test mock escape path
      console.error('[agentest wda] Mock mode active. Skipping real xcodebuild launch.');
      return;
    }

    const args = [
      'test-without-building',
      '-xctestrun',
      this.xctestrunPath,
      '-destination',
      `id=${this.udid}`,
      '-userPort',
      String(this.port),
    ];

    console.error(`[agentest wda] Spawning xcodebuild test-without-building for destination=${this.udid} port=${this.port}`);
    
    this.process = spawn('xcodebuild', args, {
      stdio: 'ignore',
      detached: false,
    });

    this.process.on('error', (err) => {
      console.error(`[agentest wda] xcodebuild process error: ${err.message}`);
    });

    this.process.on('exit', (code, signal) => {
      console.error(`[agentest wda] xcodebuild exited with code=${code} signal=${signal}`);
      this.process = null;
    });

    // Poll /status with exponential backoff until it responds with success
    const startTime = Date.now();
    let delay = 100;
    const maxDelay = 2000;

    while (Date.now() - startTime < startupTimeoutMs) {
      if (await this.checkLiveness()) {
        console.error(`[agentest wda] WebDriverAgent is fully launched and listening on port ${this.port}.`);
        return;
      }

      await new Promise((resolvePoll) => setTimeout(resolvePoll, delay));
      delay = Math.min(delay * 1.5, maxDelay);
    }

    // If we timed out, clean up and throw
    await this.shutdown();
    throw new WdaConnectionError(
      `WebDriverAgent failed to start on port ${this.port} within ${startupTimeoutMs}ms.`,
    );
  }

  /**
   * Terminate the WDA xcodebuild process.
   */
  async shutdown(): Promise<void> {
    if (this.process) {
      const proc = this.process;
      this.process = null;
      
      return new Promise<void>((resolveShutdown) => {
        proc.once('exit', () => {
          resolveShutdown();
        });
        
        try {
          proc.kill('SIGTERM');
          // Fallback force kill after 2s
          setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // Ignore if already dead
            }
            resolveShutdown();
          }, 2000);
        } catch {
          resolveShutdown();
        }
      });
    }
  }
}
