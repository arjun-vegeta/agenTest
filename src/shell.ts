import { exec } from 'node:child_process';
import { TIMEOUTS } from './constants.js';
import type { ShellExecOptions, ShellExecutor } from './types.js';

export class ProcessShellExecutor implements ShellExecutor {
  async exec(command: string, options?: ShellExecOptions): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? TIMEOUTS.SHELL_COMMAND_MS;

    return new Promise<string>((resolve, reject) => {
      const child = exec(command, { timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${command}\n${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      });

      // Handle abort signal
      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          child.kill();
          reject(new Error(`Command aborted: ${command}`));
        });
      }
    });
  }
}
