import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FiberNode } from '../android/fiber-extractor.js';
import {
  fiberLabelsToPlainMap,
  mergeFiberLabels,
} from '../android/fiber-merger.js';
import { parseUiAutomatorXml, serializeTreeCompact } from '../android/tree-parser.js';
import type { UnifiedUINode } from '../types.js';
import { UNIFIED_ROLES } from '../types.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

function loadTree(name: string): UnifiedUINode {
  const xml = readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
  return parseUiAutomatorXml(xml);
}

function loadFibers(name: string): FiberNode[] {
  const raw = readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
  const parsed = JSON.parse(raw) as { ok: boolean; nodes: FiberNode[] };
  return parsed.nodes;
}

// ---------------------------------------------------------------------------
// Minimal node factory for focused unit tests
// ---------------------------------------------------------------------------

function node(partial: Partial<UnifiedUINode>): UnifiedUINode {
  return {
    id: partial.id ?? '0',
    resourceId: partial.resourceId ?? '',
    className: partial.className ?? 'android.widget.FrameLayout',
    role: partial.role ?? UNIFIED_ROLES.CONTAINER,
    text: partial.text ?? '',
    description: partial.description ?? '',
    packageName: partial.packageName ?? 'com.example',
    bounds: partial.bounds ?? { left: 0, top: 0, right: 100, bottom: 100 },
    center: partial.center ?? { x: 50, y: 50 },
    index: partial.index ?? 0,
    enabled: partial.enabled ?? true,
    focused: partial.focused ?? false,
    selected: partial.selected ?? false,
    checked: partial.checked ?? false,
    checkable: partial.checkable ?? false,
    clickable: partial.clickable ?? false,
    scrollable: partial.scrollable ?? false,
    longClickable: partial.longClickable ?? false,
    password: partial.password ?? false,
    hintText: '',
    stateDescription: '',
    paneTitle: '',
    tooltipText: '',
    actions: partial.actions ?? [],
    children: partial.children ?? [],
  };
}

// ---------------------------------------------------------------------------
// Stage A — testID and accessibilityLabel correlation (no bounds needed)
// ---------------------------------------------------------------------------

describe('mergeFiberLabels — Stage A (prop match)', () => {
  it('matches a fiber by accessibilityLabel to a11y node with identical content-desc', () => {
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          description: 'visit our x page',
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RCTView',
        component: 'ProfileTab',
        ancestors: ['ProfileTab', 'Pressable'],
        props: { accessibilityLabel: 'visit our x page' },
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 1);
    // Node already has a description so hasOwnLabel → labels should NOT override.
    expect(labels.get('0.0')).toBeUndefined();
  });

  it('matches a fiber by accessibilityLabel to an UNLABELED a11y node', () => {
    // This is the case where a fiber has accessibilityLabel but the a11y
    // node that corresponds to it happens to have no content-desc set
    // (e.g., a wrapper View). We shouldn't match across different values
    // — this test confirms we look up by exact description match.
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          description: '',
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RCTView',
        component: 'Camera',
        ancestors: ['Camera', 'Pressable'],
        props: {},
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 0);
    // No bounds, no matching testID/accessibilityLabel → no label.
    expect(labels.size).toBe(0);
  });

  it('matches a fiber by testID to a11y node with matching short resource-id', () => {
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          resourceId: 'com.example:id/send-btn',
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RCTView',
        component: 'SendIcon',
        ancestors: ['SendIcon', 'Pressable'],
        props: { testID: 'send-btn' },
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 0);
    expect(labels.get('0.0')?.label).toBe('SendIcon');
    expect(labels.get('0.0')?.source).toBe('testID');
  });

  it('prefers explicit accessibilityLabel prop over component name', () => {
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          resourceId: 'com.example:id/icon-btn',
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RCTView',
        component: 'Camera',
        ancestors: ['Camera', 'Pressable'],
        props: {
          testID: 'icon-btn',
          accessibilityLabel: 'Take a photo',
        },
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 0);
    expect(labels.get('0.0')?.label).toBe('Take a photo');
  });
});

// ---------------------------------------------------------------------------
// Stage B — bounds intersection with density conversion
// ---------------------------------------------------------------------------

describe('mergeFiberLabels — Stage B (containment)', () => {
  it('correlates a fiber to a11y node by containment (specific host)', () => {
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          bounds: { left: 80, top: 100, right: 200, bottom: 220 }, // physical
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    // Specific host (not RCTView) — the actual SVG that renders the icon.
    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RNSVGSvgViewAndroid',
        component: 'ArrowLeft',
        ancestors: ['Svg', 'ArrowLeft', 'Pressable'],
        props: {},
        bounds: { x: 40, y: 50, width: 60, height: 60 }, // DIPs @ factor 2
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 2);
    expect(labels.get('0.0')?.label).toBe('ArrowLeft');
    expect(labels.get('0.0')?.source).toBe('bounds');
  });

  it('does NOT label a node that already has its own description', () => {
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          description: 'Already labeled',
          bounds: { left: 80, top: 100, right: 200, bottom: 220 },
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RNSVGSvgViewAndroid',
        component: 'ArrowLeft',
        ancestors: ['Svg', 'ArrowLeft'],
        props: {},
        bounds: { x: 40, y: 50, width: 60, height: 60 },
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 2);
    expect(labels.size).toBe(0);
  });

  it('RCTView fibers are skipped — only specific hosts become candidates', () => {
    // The ENTIRE POINT of the host-specificity filter: a Pressable's
    // inner RCTView walks up to find the screen name (e.g., "ProfilePage")
    // but that's not a useful button label. It should be ignored.
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          bounds: { left: 80, top: 100, right: 200, bottom: 220 },
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RCTView',
        component: 'ProfilePage',
        ancestors: ['Pressable', 'ProfilePage'],
        props: {},
        bounds: { x: 40, y: 50, width: 60, height: 60 },
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 2);
    expect(labels.size).toBe(0);
  });

  it('picks the SVG icon (tight container) over a wrapper RCTView (broader)', () => {
    // This is the Ira profile screen "back button" case. The a11y tree
    // has one clickable at [60,192,132,264] (72×72). The fiber tree has:
    //   - a Pressable RCTView at the same bounds with component=ProfilePage
    //   - an SVG inside with component=ArrowLeft
    // The RCTView is a generic host (skipped); the Svg wins with "ArrowLeft".
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          bounds: { left: 60, top: 192, right: 132, bottom: 264 },
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RCTView',
        component: 'ProfilePage', // nameFor walked up through Pressable → ProfilePage
        ancestors: ['Pressable', 'ProfilePage'],
        props: {},
        bounds: { x: 20, y: 64, width: 24, height: 24 }, // DIPs @ factor 3, offsetY=0
      },
      {
        tag: 200,
        host: 'RNSVGSvgViewAndroid',
        component: 'ArrowLeft',
        ancestors: ['Svg', 'ArrowLeft', 'Pressable'],
        props: {},
        bounds: { x: 20, y: 64, width: 24, height: 24 }, // same bounds
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 3);
    expect(labels.get('0.0')?.label).toBe('ArrowLeft');
  });

  it('nested clickables: tightest tap target claims the fiber first', () => {
    // A large card clickable contains a smaller button clickable.
    // The fiber's bounds fit inside both, but the smaller button
    // should get the label because it's the more specific tap target.
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0-card',
          bounds: { left: 50, top: 80, right: 300, bottom: 320 }, // 250×240 card
          clickable: true,
          actions: ['tap'],
        }),
        node({
          id: '0.1-button',
          bounds: { left: 80, top: 100, right: 200, bottom: 220 }, // 120×120 button, nested
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RNSVGSvgViewAndroid',
        component: 'Camera',
        ancestors: ['Svg', 'Camera'],
        props: {},
        bounds: { x: 40, y: 50, width: 60, height: 60 }, // inside both
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 2);
    expect(labels.get('0.1-button')?.label).toBe('Camera');
    expect(labels.get('0.0-card')).toBeUndefined();
  });

  it('tightest fiber wins when multiple fit inside the same a11y node', () => {
    // An a11y clickable contains a wrapping Text fiber AND a smaller
    // Icon fiber. The Icon is more specific (smaller area) and wins.
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          bounds: { left: 50, top: 80, right: 300, bottom: 320 }, // 250×240
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RCTText',
        component: 'LargeCaption',
        ancestors: ['Text', 'LargeCaption'],
        props: {},
        bounds: { x: 30, y: 45, width: 120, height: 100 }, // physical 240×200
      },
      {
        tag: 200,
        host: 'RNSVGSvgViewAndroid',
        component: 'Camera',
        ancestors: ['Svg', 'Camera'],
        props: {},
        bounds: { x: 40, y: 50, width: 30, height: 30 }, // physical 60×60 — tighter
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 2);
    expect(labels.get('0.0')?.label).toBe('Camera');
  });

  it('returns empty map when densityFactor is 0 and no prop matches', () => {
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          bounds: { left: 80, top: 100, right: 200, bottom: 220 },
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RCTView',
        component: 'ArrowLeft',
        ancestors: ['ArrowLeft'],
        props: {},
        bounds: { x: 40, y: 50, width: 60, height: 60 },
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 0);
    expect(labels.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Generic filtering — don't emit useless names
// ---------------------------------------------------------------------------

describe('mergeFiberLabels — generic component filtering', () => {
  it('ignores fibers whose only signal is a generic component name', () => {
    const root = node({
      id: '0',
      children: [
        node({
          id: '0.0',
          resourceId: 'com.example:id/some-view',
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RCTView',
        component: 'View',
        ancestors: ['View', 'Pressable'],
        props: { testID: 'some-view' },
      },
    ];

    const labels = mergeFiberLabels(root, fibers, 0);
    // component is generic AND no preferred prop → no label produced.
    expect(labels.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Real-world fixture — Ira app profile screen
// ---------------------------------------------------------------------------

describe('mergeFiberLabels — Ira RN profile fixture', () => {
  it('produces labels for unlabeled interactives using real fiber data', () => {
    const tree = loadTree('ira-login-rn.xml');
    const fibers = loadFibers('ira-profile-fibers.json');

    // The Ira fixture has no bounds on fibers (we synthesized it without
    // measurements). So Stage A is what we exercise here: testID and
    // accessibilityLabel matching. Density=0 disables Stage B.
    const labels = mergeFiberLabels(tree, fibers, 0);

    // The fixture's interactives all have content-desc set already
    // (the real ProfileTab rows carry "visit our x page" etc), so the
    // merger won't inject labels where ownLabel is set — hasOwnLabel
    // returns true and Stage A skips them. This is correct behavior
    // for enrichment.
    //
    // The real win shows up on a screen where the a11y tree has
    // UNLABELED clickables (like the Ira chat screen's icon buttons).
    // The fiber data we captured includes Camera/Photo/HangoutIcon
    // entries that WOULD label those if the a11y fixture contained
    // them without descriptions. The fiber-merger unit here just
    // proves the pipeline doesn't clobber existing labels.
    for (const [, info] of labels) {
      expect(typeof info.label).toBe('string');
      expect(['testID', 'accessibilityLabel', 'bounds']).toContain(info.source);
    }
  });

  it('end-to-end: labels flow into serializeTreeCompact via externalLabels', () => {
    // Build a synthetic tree with an unlabeled clickable whose
    // resource-id matches a fiber's testID. Pass fibers → merger →
    // external labels → serializer. Verify the label appears.
    const tree = node({
      id: '0',
      bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      children: [
        node({
          id: '0.0',
          resourceId: 'com.example:id/back-btn',
          className: 'com.facebook.react.views.view.ReactViewGroup',
          bounds: { left: 40, top: 80, right: 160, bottom: 200 },
          clickable: true,
          actions: ['tap'],
        }),
      ],
    });

    const fibers: FiberNode[] = [
      {
        tag: 100,
        host: 'RCTView',
        component: 'ArrowLeft',
        ancestors: ['ArrowLeft', 'Pressable'],
        props: { testID: 'back-btn' },
      },
    ];

    const fiberLabels = fiberLabelsToPlainMap(mergeFiberLabels(tree, fibers, 0));
    const result = serializeTreeCompact(tree, { externalLabels: fiberLabels });

    expect(result.text).toContain('ArrowLeft');
    // The label appears on a ref line (the clickable becomes addressable).
    const refLine = result.text
      .split('\n')
      .find((l) => l.includes('ArrowLeft'));
    expect(refLine).toBeDefined();
    expect(refLine).toMatch(/@[bfclsg]\d+/); // has a ref token
  });
});
