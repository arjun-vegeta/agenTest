import { describe, expect, it } from 'vitest';
import { parseWdaJsonTree, XCUI_TO_ROLE } from '../ios/tree-parser.js';
import { UNIFIED_ROLES } from '../types.js';

describe('parseWdaJsonTree', () => {
  it('maps standard element roles and rectangle bounds correctly', () => {
    const rawMock = {
      type: 'XCUIElementTypeApplication',
      name: 'TestApp',
      rect: { x: 0, y: 0, width: 375, height: 812 },
      children: [
        {
          type: 'XCUIElementTypeButton',
          name: 'login_button',
          label: 'Log In',
          rect: { x: 20, y: 100, width: 335, height: 50 },
          enabled: true,
        },
        {
          type: 'XCUIElementTypeTextField',
          name: 'username_input',
          value: 'johndoe',
          rect: { x: 20, y: 180, width: 335, height: 40 },
          enabled: 1,
        },
        {
          type: 'XCUIElementTypeSwitch',
          name: 'remember_switch',
          value: '1',
          rect: { x: 300, y: 250, width: 55, height: 30 },
          enabled: 'true',
        },
      ],
    };

    const tree = parseWdaJsonTree(rawMock, 'ai.rumik.ira');

    expect(tree.id).toBe('0');
    expect(tree.packageName).toBe('ai.rumik.ira');
    expect(tree.role).toBe(UNIFIED_ROLES.CONTAINER);
    expect(tree.children).toHaveLength(3);

    // Button
    const btn = tree.children[0]!;
    expect(btn.id).toBe('0.0');
    expect(btn.role).toBe(UNIFIED_ROLES.BUTTON);
    expect(btn.description).toBe('Log In');
    expect(btn.resourceId).toBe('login_button');
    expect(btn.bounds).toEqual({ left: 20, top: 100, right: 355, bottom: 150 });
    expect(btn.center).toEqual({ x: 188, y: 125 });
    expect(btn.clickable).toBe(true);
    expect(btn.actions).toContain('tap');

    // Text field
    const txt = tree.children[1]!;
    expect(txt.id).toBe('0.1');
    expect(txt.role).toBe(UNIFIED_ROLES.TEXT_FIELD);
    expect(txt.text).toBe('johndoe');
    expect(txt.bounds).toEqual({ left: 20, top: 180, right: 355, bottom: 220 });
    expect(txt.clickable).toBe(false);
    expect(txt.actions).toContain('type');

    // Switch
    const sw = tree.children[2]!;
    expect(sw.id).toBe('0.2');
    expect(sw.role).toBe(UNIFIED_ROLES.SWITCH);
    expect(sw.checked).toBe(true);
    expect(sw.checkable).toBe(true);
    expect(sw.clickable).toBe(true);
    expect(sw.actions).toContain('check');
  });

  it('unwraps value field if it exists', () => {
    const rawMock = {
      value: {
        type: 'XCUIElementTypeButton',
        name: 'test',
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
    };

    const tree = parseWdaJsonTree(rawMock);
    expect(tree.role).toBe(UNIFIED_ROLES.BUTTON);
  });
});
