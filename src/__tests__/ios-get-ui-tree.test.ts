import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGetUiTree } from '../tools/get-ui-tree.js';
import { WdaClient } from '../ios/wda-client.js';
import { MockShellExecutor } from './mock-shell.js';
import { RefRegistry } from '../android/ref-registry.js';

describe('iOS get_ui_tree tool', () => {
  let shell: MockShellExecutor;
  let registry: RefRegistry;

  beforeEach(() => {
    shell = new MockShellExecutor();
    registry = new RefRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully returns compact and full UI trees for iOS', async () => {
    // Mock WDA Client
    const sourceMock = vi.spyOn(WdaClient.prototype, 'getSource').mockResolvedValue({
      type: 'XCUIElementTypeApplication',
      name: 'TestApp',
      rect: { x: 0, y: 0, width: 375, height: 812 },
      children: [
        {
          type: 'XCUIElementTypeButton',
          name: 'btn',
          label: 'Click Me',
          rect: { x: 10, y: 20, width: 100, height: 40 },
          enabled: true,
        },
      ],
    });

    const resCompact = await handleGetUiTree(
      shell,
      registry,
      { format: 'compact' },
      'UDID-1234',
      undefined,
      undefined,
      undefined,
      'ios',
      8100,
      'com.example.app',
    );

    expect(sourceMock).toHaveBeenCalled();
    expect(resCompact.format).toBe('compact');
    expect(resCompact.uiTree).toContain('@b1 btn "Click Me"');

    const resFull = await handleGetUiTree(
      shell,
      registry,
      { format: 'full' },
      'UDID-1234',
      undefined,
      undefined,
      undefined,
      'ios',
      8100,
      'com.example.app',
    );

    expect(resFull.format).toBe('full');
    expect(resFull.uiTree).toHaveProperty('role', 'container');
  });
});
