import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeIosAction, detectIosSystemDialogs } from '../ios/input.js';
import type { UnifiedUINode, Bounds } from '../types.js';
import { UNIFIED_ROLES } from '../types.js';
import type { WdaClient } from '../ios/wda-client.js';

// ---------------------------------------------------------------------------
// Minimal WdaClient mock
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<UnifiedUINode> = {}): UnifiedUINode {
  return {
    id: '0',
    resourceId: '',
    className: 'XCUIElementTypeButton',
    role: UNIFIED_ROLES.BUTTON,
    text: 'OK',
    description: '',
    packageName: 'com.example.app',
    bounds: { left: 10, top: 20, right: 110, bottom: 70 },
    center: { x: 60, y: 45 },
    index: 0,
    enabled: true,
    focused: false,
    selected: false,
    checked: false,
    checkable: false,
    clickable: true,
    scrollable: false,
    longClickable: true,
    password: false,
    hintText: '',
    stateDescription: '',
    paneTitle: '',
    tooltipText: '',
    actions: [],
    children: [],
    ...overrides,
  };
}

const SCREEN_BOUNDS: Bounds = { left: 0, top: 0, right: 390, bottom: 844 };

function makeMockClient(): WdaClient {
  return {
    tap: vi.fn().mockResolvedValue(undefined),
    doubleTap: vi.fn().mockResolvedValue(undefined),
    longPress: vi.fn().mockResolvedValue(undefined),
    swipe: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    clearText: vi.fn().mockResolvedValue(undefined),
    pinch: vi.fn().mockResolvedValue(undefined),
    rotate: vi.fn().mockResolvedValue(undefined),
    getAlert: vi.fn().mockResolvedValue(null),
    acceptAlert: vi.fn().mockResolvedValue(undefined),
    dismissAlert: vi.fn().mockResolvedValue(undefined),
    getSource: vi.fn().mockResolvedValue({}),
    ensureSession: vi.fn().mockResolvedValue('mock-session'),
    getSessionId: vi.fn().mockReturnValue('mock-session'),
    closeSession: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ state: 'success' }),
    performW3CActions: vi.fn().mockResolvedValue(undefined),
  } as unknown as WdaClient;
}

// ---------------------------------------------------------------------------
// executeIosAction — action routing
// ---------------------------------------------------------------------------

describe('executeIosAction', () => {
  let client: WdaClient;
  let tree: UnifiedUINode;

  beforeEach(() => {
    client = makeMockClient();
    tree = makeNode({ text: 'OK' });
  });

  it('tap: calls client.tap with element center', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'tap', target: { text: 'OK' } },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.tap).toHaveBeenCalledWith(60, 45);
  });

  it('tap_coordinates: calls client.tap with raw coordinates', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'tap_coordinates', x: 100, y: 200 },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.tap).toHaveBeenCalledWith(100, 200);
  });

  it('double_tap: calls client.doubleTap with element center', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'double_tap', target: { text: 'OK' } },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.doubleTap).toHaveBeenCalledWith(60, 45);
  });

  it('double_tap_coordinates: calls client.doubleTap with raw coords', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'double_tap_coordinates', x: 50, y: 100 },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.doubleTap).toHaveBeenCalledWith(50, 100);
  });

  it('long_press: calls client.longPress with element center', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'long_press', target: { text: 'OK' }, durationMs: 1500 },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.longPress).toHaveBeenCalledWith(60, 45, 1500);
  });

  it('long_press_coordinates: calls client.longPress with raw coords', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'long_press_coordinates', x: 30, y: 60, durationMs: 800 },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.longPress).toHaveBeenCalledWith(30, 60, 800);
  });

  it('type: taps element to focus then calls client.type', async () => {
    const inputNode = makeNode({
      className: 'XCUIElementTypeTextField',
      role: UNIFIED_ROLES.TEXT_FIELD,
      text: '',
      center: { x: 195, y: 300 },
    });
    const inputTree = makeNode({ children: [inputNode], text: '' });

    await executeIosAction(
      client,
      inputTree,
      { action: 'type', target: { className: 'XCUIElementTypeTextField' }, value: 'hello' },
      SCREEN_BOUNDS,
      'com.example.app',
    );

    expect(client.tap).toHaveBeenCalledWith(195, 300);
    expect(client.type).toHaveBeenCalledWith('hello');
  });

  it('clear_text: calls client.clearText with element center', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'clear_text', target: { text: 'OK' } },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.clearText).toHaveBeenCalledWith(60, 45, expect.any(Number));
  });

  it('swipe with no target uses screen bounds', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'swipe', direction: 'up' },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.swipe).toHaveBeenCalledTimes(1);
    // Swipe up: y1 > y2
    const [, y1, , y2] = (client.swipe as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
      number,
      number,
      number,
      number,
    ];
    expect(y1).toBeGreaterThan(y2);
  });

  it('swipe_coordinates: passes raw coordinates to client.swipe', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'swipe_coordinates', x1: 10, y1: 20, x2: 30, y2: 40 },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.swipe).toHaveBeenCalledWith(10, 20, 30, 40, expect.any(Number));
  });

  it('pinch: delegates to client.pinch', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'pinch', cx: 200, cy: 400, startRadius: 100, endRadius: 50 },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.pinch).toHaveBeenCalledWith(200, 400, 100, 50, expect.any(Number));
  });

  it('rotate: delegates to client.rotate', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'rotate', cx: 200, cy: 400, radius: 100, startAngleDeg: 0, endAngleDeg: 90 },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.rotate).toHaveBeenCalledWith(200, 400, 100, 0, 90, expect.any(Number));
  });

  it('wait: does not call any gesture methods', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'wait', timeoutMs: 1 },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.tap).not.toHaveBeenCalled();
    expect(client.swipe).not.toHaveBeenCalled();
  });

  it('assertion steps: are no-ops', async () => {
    await executeIosAction(
      client,
      tree,
      { action: 'assert_visible', target: { text: 'OK' } },
      SCREEN_BOUNDS,
      'com.example.app',
    );
    expect(client.tap).not.toHaveBeenCalled();
  });

  it('throws ElementNotFoundError when selector matches nothing', async () => {
    await expect(
      executeIosAction(
        client,
        tree,
        { action: 'tap', target: { text: 'NonExistent' } },
        SCREEN_BOUNDS,
        'com.example.app',
      ),
    ).rejects.toThrow('No element found');
  });
});

// ---------------------------------------------------------------------------
// detectIosSystemDialogs
// ---------------------------------------------------------------------------

describe('detectIosSystemDialogs', () => {
  it('returns empty array when no alert is present', async () => {
    const client = makeMockClient();
    (client.getAlert as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const dialogs = await detectIosSystemDialogs(client);
    expect(dialogs).toHaveLength(0);
  });

  it('returns a SystemDialog when an alert is present', async () => {
    const client = makeMockClient();
    (client.getAlert as ReturnType<typeof vi.fn>).mockResolvedValue(
      '"App" wants to access your location',
    );

    const dialogs = await detectIosSystemDialogs(client);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.title).toContain('location');
    expect(dialogs[0]?.buttons).toEqual(expect.arrayContaining(['Accept', 'Dismiss']));
  });
});
