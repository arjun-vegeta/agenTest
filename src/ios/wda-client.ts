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

  /**
   * Clear text from the currently focused field.
   * Strategy: triple-tap to select all, then send a single backspace to delete.
   * @param x - x coordinate of the text field center
   * @param y - y coordinate of the text field center
   * @param tapIntervalMs - delay between individual taps in the triple-tap
   */
  async clearText(x: number, y: number, tapIntervalMs = 80): Promise<void> {
    const sid = await this.ensureSession();
    // Triple-tap selects all text in a UITextField/UITextView on iOS
    await this.request(`/session/${sid}/wda/tap`, 'POST', { x, y });
    await sleep(tapIntervalMs);
    await this.request(`/session/${sid}/wda/tap`, 'POST', { x, y });
    await sleep(tapIntervalMs);
    await this.request(`/session/${sid}/wda/tap`, 'POST', { x, y });
    await sleep(tapIntervalMs);
    // One backspace deletes the entire selection
    await this.request(`/session/${sid}/wda/keys`, 'POST', { value: ['\ue003'] });
  }

  /**
   * Execute arbitrary W3C Actions (multi-touch, etc.).
   * See https://www.w3.org/TR/webdriver/#actions
   */
  async performW3CActions(actions: unknown[]): Promise<void> {
    const sid = await this.ensureSession();
    await this.request(`/session/${sid}/actions`, 'POST', { actions });
  }

  /**
   * Two-finger pinch gesture around a center point.
   * @param cx - center x
   * @param cy - center y
   * @param startRadius - initial distance from center for each finger
   * @param endRadius - final distance from center for each finger
   * @param durationMs - gesture duration in milliseconds
   */
  async pinch(
    cx: number,
    cy: number,
    startRadius: number,
    endRadius: number,
    durationMs = 500,
  ): Promise<void> {
    const actions = buildPinchActions(cx, cy, startRadius, endRadius, durationMs);
    await this.performW3CActions(actions);
  }

  /**
   * Two-finger rotation gesture around a center point.
   * @param cx - center x
   * @param cy - center y
   * @param radius - distance from center for each finger
   * @param startAngleDeg - starting angle in degrees (0 = right)
   * @param endAngleDeg - ending angle in degrees
   * @param durationMs - gesture duration in milliseconds
   */
  async rotate(
    cx: number,
    cy: number,
    radius: number,
    startAngleDeg: number,
    endAngleDeg: number,
    durationMs = 500,
  ): Promise<void> {
    const actions = buildRotateActions(cx, cy, radius, startAngleDeg, endAngleDeg, durationMs);
    await this.performW3CActions(actions);
  }

  /**
   * Get the text of the currently displayed system alert, or null if none.
   */
  async getAlert(): Promise<string | null> {
    try {
      const sid = await this.ensureSession();
      const text = await this.request<string>(`/session/${sid}/alert/text`);
      return text ?? null;
    } catch {
      // No alert present — WDA returns 404 or error
      return null;
    }
  }

  /**
   * Accept (tap the default/OK button on) the active system alert.
   */
  async acceptAlert(): Promise<void> {
    const sid = await this.ensureSession();
    await this.request(`/session/${sid}/alert/accept`, 'POST');
  }

  /**
   * Dismiss (tap the cancel button on) the active system alert.
   */
  async dismissAlert(): Promise<void> {
    const sid = await this.ensureSession();
    await this.request(`/session/${sid}/alert/dismiss`, 'POST');
  }
}

// ---------------------------------------------------------------------------
// W3C Actions builders (pure helpers — no class state)
// ---------------------------------------------------------------------------

interface W3CPointerAction {
  type: 'pointerMove' | 'pointerDown' | 'pointerUp' | 'pause';
  x?: number;
  y?: number;
  duration?: number;
  button?: number;
  origin?: string;
}

interface W3CPointerSequence {
  type: 'pointer';
  id: string;
  parameters: { pointerType: 'touch' };
  actions: W3CPointerAction[];
}

function buildPinchActions(
  cx: number,
  cy: number,
  startRadius: number,
  endRadius: number,
  durationMs: number,
): W3CPointerSequence[] {
  const makeFingerSequence = (
    id: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): W3CPointerSequence => ({
    type: 'pointer',
    id,
    parameters: { pointerType: 'touch' },
    actions: [
      {
        type: 'pointerMove',
        x: Math.round(startX),
        y: Math.round(startY),
        duration: 0,
        origin: 'viewport',
      },
      { type: 'pointerDown', button: 0 },
      {
        type: 'pointerMove',
        x: Math.round(endX),
        y: Math.round(endY),
        duration: durationMs,
        origin: 'viewport',
      },
      { type: 'pointerUp', button: 0 },
    ],
  });

  return [
    makeFingerSequence('finger1', cx - startRadius, cy, cx - endRadius, cy),
    makeFingerSequence('finger2', cx + startRadius, cy, cx + endRadius, cy),
  ];
}

function buildRotateActions(
  cx: number,
  cy: number,
  radius: number,
  startAngleDeg: number,
  endAngleDeg: number,
  durationMs: number,
): W3CPointerSequence[] {
  const STEPS = 8;
  const startRad = (startAngleDeg * Math.PI) / 180;
  const endRad = (endAngleDeg * Math.PI) / 180;
  const stepDuration = Math.round(durationMs / STEPS);

  const makeArcSequence = (id: string, angleOffset: number): W3CPointerSequence => {
    const startAngle = startRad + angleOffset;
    const endAngle = endRad + angleOffset;

    const moveActions: W3CPointerAction[] = [];
    for (let s = 0; s <= STEPS; s++) {
      const t = s / STEPS;
      const angle = startAngle + (endAngle - startAngle) * t;
      const x = Math.round(cx + radius * Math.cos(angle));
      const y = Math.round(cy + radius * Math.sin(angle));
      if (s === 0) {
        moveActions.push({ type: 'pointerMove', x, y, duration: 0, origin: 'viewport' });
        moveActions.push({ type: 'pointerDown', button: 0 });
      } else {
        moveActions.push({ type: 'pointerMove', x, y, duration: stepDuration, origin: 'viewport' });
      }
    }
    moveActions.push({ type: 'pointerUp', button: 0 });

    return { type: 'pointer', id, parameters: { pointerType: 'touch' }, actions: moveActions };
  };

  return [makeArcSequence('finger1', 0), makeArcSequence('finger2', Math.PI)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
