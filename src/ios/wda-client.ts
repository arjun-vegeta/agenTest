import { WdaCommandError, WdaConnectionError } from '../errors.js';

export interface WdaStatus {
  state: 'success' | string;
  os?: {
    name: string;
    version: string;
  };
}

export class WdaClient {
  private sessionId: string | null = null;

  constructor(
    private readonly port: number,
    sessionId?: string,
  ) {
    if (sessionId) {
      this.sessionId = sessionId;
    }
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    body?: unknown,
  ): Promise<T> {
    const url = `http://127.0.0.1:${this.port}${path}`;
    try {
      const headers: Record<string, string> = {};
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        throw new WdaCommandError(`WebDriverAgent command failed with status=${res.status}`, url);
      }

      const data = (await res.json()) as { value?: T; error?: string; message?: string };
      if (data?.error) {
        throw new WdaCommandError(
          `WebDriverAgent returned error: ${data.error} - ${data.message ?? ''}`,
          url,
        );
      }

      return data.value as T;
    } catch (err) {
      if (err instanceof WdaCommandError) {
        throw err;
      }
      throw new WdaConnectionError(
        `Failed to communicate with WebDriverAgent on port ${this.port}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Check WDA status.
   */
  async getStatus(): Promise<WdaStatus> {
    return this.request<WdaStatus>('/status');
  }

  /**
   * Create a new session.
   */
  async ensureSession(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }

    const res = await this.request<{ sessionId: string }>('/session', 'POST', {
      capabilities: {
        alwaysMatch: {
          platformName: 'iOS',
        },
      },
    });

    const sid = res.sessionId;
    if (!sid) {
      throw new WdaConnectionError('Failed to parse sessionId from WebDriverAgent response.');
    }
    this.sessionId = sid;
    return sid;
  }

  /**
   * Get active session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Close the active session.
   */
  async closeSession(): Promise<void> {
    if (this.sessionId) {
      const sid = this.sessionId;
      this.sessionId = null;
      try {
        await this.request(`/session/${sid}`, 'DELETE');
      } catch {
        // Silently catch teardown failures
      }
    }
  }

  /**
   * Fetch raw accessibility tree from WDA.
   */
  async getSource(): Promise<Record<string, unknown>> {
    const sid = await this.ensureSession();
    return this.request<Record<string, unknown>>(`/session/${sid}/source?format=json`);
  }

  /**
   * Tap coordinates on the screen.
   */
  async tap(x: number, y: number): Promise<void> {
    const sid = await this.ensureSession();
    await this.request(`/session/${sid}/wda/tap`, 'POST', { x, y });
  }

  /**
   * Double tap coordinates.
   */
  async doubleTap(x: number, y: number): Promise<void> {
    const sid = await this.ensureSession();
    await this.request(`/session/${sid}/wda/doubleTap`, 'POST', { x, y });
  }

  /**
   * Long press coordinates.
   */
  async longPress(x: number, y: number, durationMs = 1000): Promise<void> {
    const sid = await this.ensureSession();
    // WDA touchAndHold duration is in seconds
    await this.request(`/session/${sid}/wda/touchAndHold`, 'POST', {
      x,
      y,
      duration: durationMs / 1000,
    });
  }

  /**
   * Swipe / drag from one coordinate to another.
   */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    const sid = await this.ensureSession();
    // WDA expects: fromX, fromY, toX, toY, duration (seconds)
    await this.request(`/session/${sid}/wda/drag`, 'POST', {
      fromX: x1,
      fromY: y1,
      toX: x2,
      toY: y2,
      duration: durationMs / 1000,
    });
  }

  /**
   * Type text on the active keyboard.
   */
  async type(text: string): Promise<void> {
    const sid = await this.ensureSession();
    // Send keyboard keys
    await this.request(`/session/${sid}/wda/keys`, 'POST', {
      value: text.split(''),
    });
  }
}
