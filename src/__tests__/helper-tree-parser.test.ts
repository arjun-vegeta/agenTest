/**
 * Tests for parseHelperJsonTree — the function that converts the on-device
 * helper APK's JSON tree response into a UnifiedUINode (the same shape as
 * the existing XML parser produces).
 */

import { describe, expect, it } from 'vitest';
import { parseHelperJsonTree, type HelperTreeResponse } from '../android/tree-parser.js';
import { TreeParseError } from '../errors.js';

function makeResponse(tree: HelperTreeResponse['tree']): HelperTreeResponse {
  return { ok: true, packageName: 'com.example', compact: false, tree };
}

describe('parseHelperJsonTree', () => {
  it('throws when helper response is not ok', () => {
    expect(() =>
      parseHelperJsonTree({
        ok: false,
        packageName: '',
        compact: false,
        tree: { bounds: '[0,0][0,0]' },
      }),
    ).toThrow(TreeParseError);
  });

  it('parses a simple flat tree', () => {
    const node = parseHelperJsonTree(
      makeResponse({
        class: 'android.widget.FrameLayout',
        packageName: 'com.example',
        bounds: '[0,0][1080,1920]',
        children: [
          {
            id: 'com.example:id/email',
            class: 'android.widget.EditText',
            text: '',
            packageName: 'com.example',
            bounds: '[48,240][1032,384]',
            enabled: true,
            clickable: true,
          },
          {
            id: 'com.example:id/login',
            class: 'android.widget.Button',
            text: 'Sign in',
            packageName: 'com.example',
            bounds: '[48,500][1032,600]',
            enabled: true,
            clickable: true,
          },
        ],
      }),
    );

    expect(node.children).toHaveLength(2);
    expect(node.children[0]?.resourceId).toBe('com.example:id/email');
    expect(node.children[0]?.role).toBe('text_field');
    expect(node.children[0]?.actions).toContain('tap');
    expect(node.children[0]?.actions).toContain('type');
    expect(node.children[1]?.role).toBe('button');
    expect(node.children[1]?.text).toBe('Sign in');
  });

  it('computes bounds and center correctly', () => {
    const node = parseHelperJsonTree(
      makeResponse({
        class: 'android.widget.Button',
        bounds: '[100,200][300,400]',
        clickable: true,
      }),
    );
    expect(node.bounds).toEqual({ left: 100, top: 200, right: 300, bottom: 400 });
    expect(node.center).toEqual({ x: 200, y: 300 });
  });

  it('treats omitted state flags as defaults', () => {
    const node = parseHelperJsonTree(
      makeResponse({
        class: 'android.widget.TextView',
        bounds: '[0,0][100,100]',
      }),
    );
    expect(node.enabled).toBe(true); // default true
    expect(node.clickable).toBe(false);
    expect(node.checked).toBe(false);
    expect(node.scrollable).toBe(false);
    expect(node.password).toBe(false);
  });

  it('maps Compose container to container role', () => {
    const node = parseHelperJsonTree(
      makeResponse({
        class: 'androidx.compose.ui.platform.AndroidComposeView',
        bounds: '[0,0][1080,1920]',
      }),
    );
    expect(node.role).toBe('container');
  });

  it('maps React Native ViewGroup to container role', () => {
    const node = parseHelperJsonTree(
      makeResponse({
        class: 'com.facebook.react.views.view.ReactViewGroup',
        bounds: '[0,0][500,500]',
      }),
    );
    expect(node.role).toBe('container');
  });

  it('handles nested children with correct path-based ids', () => {
    const node = parseHelperJsonTree(
      makeResponse({
        class: 'android.widget.LinearLayout',
        bounds: '[0,0][1080,1920]',
        children: [
          {
            class: 'android.widget.LinearLayout',
            bounds: '[0,0][540,1920]',
            children: [
              {
                class: 'android.widget.TextView',
                text: 'Hello',
                bounds: '[0,0][540,100]',
              },
            ],
          },
        ],
      }),
    );

    // Root id is "0", first child "0.0", grandchild "0.0.0"
    expect(node.id).toBe('0');
    expect(node.children[0]?.id).toBe('0.0');
    expect(node.children[0]?.children[0]?.id).toBe('0.0.0');
    expect(node.children[0]?.children[0]?.text).toBe('Hello');
  });

  it('derives scroll action from scrollable flag', () => {
    const node = parseHelperJsonTree(
      makeResponse({
        class: 'androidx.recyclerview.widget.RecyclerView',
        bounds: '[0,0][1080,1920]',
        scrollable: true,
      }),
    );
    expect(node.scrollable).toBe(true);
    expect(node.actions).toContain('scroll');
    expect(node.role).toBe('list');
  });
});
