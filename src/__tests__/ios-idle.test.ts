import { describe, it, expect, vi } from 'vitest';
import { snapshotIosTree, waitForIosIdle } from '../ios/idle.js';
import type { WdaClient } from '../ios/wda-client.js';
import { IdleTimeoutError } from '../errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_WDA_TREE = {
  type: 'XCUIElementTypeApplication',
  name: 'com.example.app',
  rect: { x: 0, y: 0, width: 390, height: 844 },
  enabled: true,
  visible: true,
  children: [
    {
      type: 'XCUIElementTypeButton',
      label: 'Login',
      rect: { x: 10, y: 100, width: 80, height: 44 },
      enabled: true,
      visible: true,
      children: [],
    },
  ],
};

const CHANGED_WDA_TREE = {
  type: 'XCUIElementTypeApplication',
  name: 'com.example.app',
  rect: { x: 0, y: 0, width: 390, height: 844 },
  enabled: true,
  visible: true,
  children: [
    {
      type: 'XCUIElementTypeStaticText',
      label: 'Welcome',
      rect: { x: 10, y: 200, width: 200, height: 30 },
      enabled: true,
      visible: true,
      children: [],
    },
  ],
};

function makeMockClient(getSourceImpl: () => Promise<Record<string, unknown>>): WdaClient {
  return {
    getSource: vi.fn().mockImplementation(getSourceImpl),
    ensureSession: vi.fn().mockResolvedValue('mock-session'),
    getSessionId: vi.fn().mockReturnValue('mock-session'),
    closeSession: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ state: 'success' }),
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
    performW3CActions: vi.fn().mockResolvedValue(undefined),
  } as unknown as WdaClient;
}

// ---------------------------------------------------------------------------
// snapshotIosTree
// ---------------------------------------------------------------------------

describe('snapshotIosTree', () => {
  it('fetches source and returns a parsed UnifiedUINode', async () => {
    const client = makeMockClient(() => Promise.resolve(MINIMAL_WDA_TREE));

    const tree = await snapshotIosTree(client, 'com.example.app');

    expect(tree.className).toBe('XCUIElementTypeApplication');
    expect(tree.packageName).toBe('com.example.app');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.text).toBe('Login');
  });

  it('calls client.getSource exactly once per snapshot', async () => {
    const getSource = vi.fn().mockResolvedValue(MINIMAL_WDA_TREE);
    const client = makeMockClient(() => getSource());

    await snapshotIosTree(client, 'com.example.app');

    expect(getSource).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// waitForIosIdle
// ---------------------------------------------------------------------------

describe('waitForIosIdle', () => {
  it('returns stable tree when two consecutive snapshots have the same fingerprint', async () => {
    // Return the same tree twice — should stabilise after the first identical pair
    const client = makeMockClient(() => Promise.resolve(MINIMAL_WDA_TREE));

    const result = await waitForIosIdle(client, 'com.example.app', {
      timeoutMs: 5000,
      pollIntervalMs: 10,
      requiredStableCount: 2,
    });

    expect(result.tree.className).toBe('XCUIElementTypeApplication');
  });

  it('keeps polling when tree changes between snapshots', async () => {
    // Serve changing tree 4 times, then stable tree
    let callCount = 0;
    const getSource = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(
        callCount <= 4
          ? callCount % 2 === 0
            ? CHANGED_WDA_TREE
            : MINIMAL_WDA_TREE
          : MINIMAL_WDA_TREE,
      );
    });
    const client = makeMockClient(() => getSource());

    const result = await waitForIosIdle(client, 'com.example.app', {
      timeoutMs: 5000,
      pollIntervalMs: 5,
      requiredStableCount: 2,
    });

    // Should eventually settle
    expect(result.tree).toBeDefined();
    expect(getSource.mock.calls.length).toBeGreaterThan(2);
  });

  it('throws IdleTimeoutError when the UI never settles within the timeout', async () => {
    // Always serve alternating trees to prevent stability
    let callCount = 0;
    const client = makeMockClient(() => {
      callCount++;
      return Promise.resolve(callCount % 2 === 0 ? CHANGED_WDA_TREE : MINIMAL_WDA_TREE);
    });

    await expect(
      waitForIosIdle(client, 'com.example.app', {
        timeoutMs: 50,
        pollIntervalMs: 5,
        requiredStableCount: 2,
      }),
    ).rejects.toBeInstanceOf(IdleTimeoutError);
  });
});
