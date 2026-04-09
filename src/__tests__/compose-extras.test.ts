/**
 * Unit tests for Compose semantics passthrough (Phase 3.8).
 *
 * The on-device helper extracts `hintText` / `stateDescription` /
 * `paneTitle` / `tooltipText` from AccessibilityNodeInfo and emits them
 * in the `/tree` JSON. This test verifies that:
 *   1. `parseHelperJsonTree` preserves those fields on UnifiedUINode
 *   2. `serializeTreeForLlm` exposes them as `hint`/`state`/`pane`/`tooltip`
 *      on the compact LLM tree
 *   3. Compose-enriched nodes are no longer collapsed as "empty wrappers"
 */

import { describe, expect, it } from 'vitest';
import { parseHelperJsonTree, serializeTreeForLlm } from '../android/tree-parser.js';

describe('Compose helper tree extras', () => {
  it('preserves hintText on UnifiedUINode from helper JSON', () => {
    const tree = parseHelperJsonTree({
      ok: true,
      packageName: 'com.example.compose',
      compact: false,
      tree: {
        class: 'android.view.View',
        bounds: '[0,0][1080,1920]',
        children: [
          {
            class: 'android.widget.EditText',
            bounds: '[40,200][1040,340]',
            hintText: 'Email address',
            enabled: true,
            clickable: true,
          },
        ],
      },
    });

    const child = tree.children[0];
    expect(child).toBeDefined();
    expect(child?.hintText).toBe('Email address');
  });

  it('preserves stateDescription, paneTitle, tooltipText', () => {
    const tree = parseHelperJsonTree({
      ok: true,
      packageName: 'com.example.compose',
      compact: false,
      tree: {
        class: 'androidx.compose.ui.platform.ComposeView',
        bounds: '[0,0][1080,1920]',
        children: [
          {
            class: 'android.view.View',
            bounds: '[40,200][1040,340]',
            stateDescription: 'on',
            paneTitle: 'Settings',
            tooltipText: 'Toggle dark mode',
            enabled: true,
          },
        ],
      },
    });

    const child = tree.children[0];
    expect(child?.stateDescription).toBe('on');
    expect(child?.paneTitle).toBe('Settings');
    expect(child?.tooltipText).toBe('Toggle dark mode');
  });

  it('defaults Compose fields to empty strings when absent', () => {
    const tree = parseHelperJsonTree({
      ok: true,
      packageName: 'com.example.native',
      compact: false,
      tree: {
        class: 'android.widget.TextView',
        bounds: '[0,0][100,50]',
        text: 'Hello',
      },
    });

    expect(tree.hintText).toBe('');
    expect(tree.stateDescription).toBe('');
    expect(tree.paneTitle).toBe('');
    expect(tree.tooltipText).toBe('');
  });

  it('exposes Compose fields in the LLM tree', () => {
    const tree = parseHelperJsonTree({
      ok: true,
      packageName: 'com.example.compose',
      compact: false,
      tree: {
        class: 'android.widget.Switch',
        bounds: '[40,40][200,100]',
        stateDescription: 'on',
        hintText: 'Toggle notifications',
        enabled: true,
        clickable: true,
      },
    });

    const llm = serializeTreeForLlm(tree);
    expect(llm.state).toBe('on');
    expect(llm.hint).toBe('Toggle notifications');
  });

  it('does not collapse a wrapper that only has paneTitle as a "label"', () => {
    // A Compose pane is often a single-child wrapper — but its paneTitle is
    // the label we want to preserve in the LLM tree.
    const tree = parseHelperJsonTree({
      ok: true,
      packageName: 'com.example.compose',
      compact: false,
      tree: {
        class: 'android.view.ViewGroup',
        bounds: '[0,0][1080,1920]',
        paneTitle: 'Home',
        children: [
          {
            class: 'android.widget.TextView',
            bounds: '[40,40][300,100]',
            text: 'Welcome',
          },
        ],
      },
    });

    const llm = serializeTreeForLlm(tree);
    // The wrapper with paneTitle should remain visible in the LLM tree
    // (not collapsed into its child).
    expect(llm.pane).toBe('Home');
    expect(llm.children?.length).toBe(1);
  });
});
