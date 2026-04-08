import type { ShellExecOptions, ShellExecutor } from '../types.js';

interface CommandResponse {
  pattern: string | RegExp;
  response: string;
}

export class MockShellExecutor implements ShellExecutor {
  private responses: CommandResponse[] = [];
  private callLog: string[] = [];

  /** Register a response for commands matching a pattern */
  when(pattern: string | RegExp, response: string): this {
    this.responses.push({ pattern, response });
    return this;
  }

  /** Get all commands that were executed */
  getCalls(): string[] {
    return [...this.callLog];
  }

  /** Get commands matching a pattern */
  getCallsMatching(pattern: string | RegExp): string[] {
    return this.callLog.filter((cmd) =>
      typeof pattern === 'string' ? cmd.includes(pattern) : pattern.test(cmd),
    );
  }

  /** Clear all recorded calls */
  clearCalls(): void {
    this.callLog = [];
  }

  async exec(command: string, _options?: ShellExecOptions): Promise<string> {
    this.callLog.push(command);

    for (const { pattern, response } of this.responses) {
      const matches =
        typeof pattern === 'string' ? command.includes(pattern) : pattern.test(command);
      if (matches) {
        return response;
      }
    }

    throw new Error(`MockShellExecutor: no response configured for command: ${command}`);
  }
}
