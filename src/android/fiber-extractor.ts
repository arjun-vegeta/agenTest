/**
 * React Fiber tree extraction from a running React Native app via Hermes
 * CDP Runtime.evaluate. Phase 3.6.
 *
 * This is how AgenTest identifies unlabeled icon buttons in Bolt/v0/Lovable
 * codegen apps: walk the React Fiber tree exposed via
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` and extract each host component's nearest
 * meaningful React ancestor (`ArrowLeft`, `Settings`, `Camera`, `SendIcon`
 * and friends — Lucide/Ionicons/vector-icons component names). The host
 * side then correlates these with accessibility-tree nodes in
 * `fiber-merger.ts` and emits them as labels in the compact tree.
 *
 * Lifecycle:
 *   1. `extractReactFiberTree(client)` — one CDP `Runtime.evaluate` call
 *      that walks the fiber tree synchronously, returns {tag, host,
 *      component, ancestors, props} for every HostComponent fiber, and
 *      ALSO kicks off `stateNode.measureInWindow` callbacks in the
 *      background that stash results in `globalThis.__agentest_measures`.
 *   2. Host waits ~150ms for those callbacks to fire on the UI thread.
 *   3. `fetchFiberMeasurements(client)` — a second synchronous call
 *      reads `globalThis.__agentest_measures` and returns the populated
 *      map. Also clears it for the next call.
 *
 * Why the two-call pattern: Hermes's CDP `awaitPromise: true` flag is
 * unreliable — `Promise.resolve(42)` returns the internal Promise
 * representation instead of the awaited value. We confirmed this
 * empirically against the example chat app on 2026-04-10. The two-call
 * stateful pattern sidesteps the issue entirely: every piece of code
 * sent to Hermes is pure synchronous, and async measurements are
 * collected via a global rendezvous point.
 *
 * Debug-build only — Hermes inspector is disabled in release. The
 * caller must already have an attached `HermesCdpClient` (i.e. Hermes
 * was discovered during `agentest_connect` and framework-sync is active).
 */

import type { HermesCdpClient } from './hermes-cdp.js';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * A single HostComponent fiber extracted from the React Fiber tree. One
 * per native view on the RN side — many of these per React component.
 */
export interface FiberNode {
  /** Native view tag assigned by RN's UIManager. The correlation key. */
  tag: number | null;
  /** Host component class like "RCTView", "RNSVGPath". */
  host: string | null;
  /** Nearest meaningful ancestor component name from the React tree. */
  component: string | null;
  /** Chain of named ancestors, nearest first (e.g., ["Svg","Camera","Pressable"]). */
  ancestors: string[];
  /** Picked props from the host's React owner chain. */
  props: Record<string, string>;
  /** Logical pixel bounds (DIPs) — populated by the second call. */
  bounds?: FiberBounds;
}

/** Bounds returned by `stateNode.measureInWindow` — logical/DIP pixels. */
export interface FiberBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Result of the first-call fiber walker. */
interface FiberWalkerResult {
  ok: boolean;
  reason?: string;
  count?: number;
  nodes?: FiberNode[];
}

/** Result of the second-call measurements fetcher. */
interface FiberMeasurementsResult {
  ok: boolean;
  measures?: Record<string, FiberBounds>;
}

// ---------------------------------------------------------------------------
// CDP expressions
// ---------------------------------------------------------------------------

/**
 * Fiber walker — runs inside Hermes's JS runtime. Sync only: walks the
 * tree via `__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots`, collects host
 * fibers, and for each calls `stateNode.measureInWindow(cb)` to stash
 * async bounds into `globalThis.__agentest_measures` keyed by tag. The
 * return value is the synchronous list of {tag, host, component,
 * ancestors, props} — bounds come from the second call.
 *
 * Prop keys picked: the ones codegen tools actually set. Ionicons uses
 * `name`, Lucide uses component name, react-native-vector-icons uses
 * `name`, Expo Image uses `source` (URI extracted), explicit
 * accessibility uses `accessibilityLabel` or `testID`.
 */
const FIBER_WALKER_EXPR = `(function () {
  try {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || hook.renderers.size === 0) {
      return { ok: false, reason: 'no-devtools-hook' };
    }

    // Reset the measurements bag for this walk. Keep it on globalThis
    // so the second CDP call can read it without another handshake.
    globalThis.__agentest_measures = {};

    var PROP_KEYS = ['icon','name','accessibilityLabel','testID','title','label','source','alt','contentDescription'];
    // Generic component names to skip when walking up the React tree
    // looking for a meaningful ancestor name. Stays in sync with the
    // GENERIC_COMPONENTS set in fiber-merger.ts. The walker has its
    // own copy because it runs inside Hermes and can't import from
    // the host TS code.
    //
    // The critical bit: when an icon like Lucide's ArrowLeft renders
    // <Svg><Path/></Svg>, the React tree is:
    //   ArrowLeft → Svg → RNSVGSvgViewAndroid
    // The host fiber's _debugOwner is Svg. We need to skip "Svg" and
    // keep walking up to find "ArrowLeft" — that's the user-facing
    // semantic name. Without this, every icon ends up labeled "Svg".
    var SKIP_NAMES = {
      'View': 1, 'Text': 1, 'Image': 1, 'Pressable': 1,
      'TouchableOpacity': 1, 'TouchableWithoutFeedback': 1,
      'TouchableHighlight': 1, 'TouchableNativeFeedback': 1,
      'Svg': 1, 'G': 1, 'Path': 1, 'Rect': 1, 'Circle': 1,
      'Line': 1, 'Ellipse': 1, 'Polygon': 1, 'Polyline': 1,
      'Defs': 1, 'ClipPath': 1, 'Mask': 1, 'Use': 1,
      'SvgXml': 1, 'SvgAst': 1,
      'RCTView': 1, 'RCTText': 1, 'RCTImageView': 1,
      'ExpoLinearGradient': 1, 'NativeLinearGradient': 1, 'LinearGradient': 1,
      'BlurView': 1, 'ExpoBlurView': 1,
      'AnimatedComponent(View)': 1, 'Animated(View)': 1, 'Animated(Anonymous)': 1,
      'PureComponentWrapper': 1,
      'ScrollView': 1, 'ScrollComponent': 1,
      'AnimatedComponent(ScrollView)': 1,
      'KeyboardAvoidingView': 1, 'SafeAreaView': 1,
    };
    var nodes = [];

    function nameFor(fiber) {
      var f = fiber;
      var depth = 0;
      while (f && depth < 50) {
        var t = f.type;
        if (t) {
          var n = (typeof t === 'string') ? t : (t.displayName || t.name || null);
          if (n && n.length > 0 && n !== 'Unknown' && !SKIP_NAMES[n]) return n;
        }
        f = f._debugOwner || f.return;
        depth++;
      }
      return null;
    }

    function ancestorChain(fiber) {
      var chain = [];
      var f = fiber._debugOwner || fiber.return;
      var depth = 0;
      while (f && depth < 10 && chain.length < 6) {
        var t = f.type;
        if (t) {
          var n = (typeof t === 'string') ? t : (t.displayName || t.name || null);
          if (n && n.length > 0 && n !== 'Unknown' && chain.indexOf(n) === -1) chain.push(n);
        }
        f = f._debugOwner || f.return;
        depth++;
      }
      return chain;
    }

    function pickProps(p) {
      if (!p || typeof p !== 'object') return {};
      var r = {};
      for (var i = 0; i < PROP_KEYS.length; i++) {
        var k = PROP_KEYS[i];
        if (p[k] != null) {
          var v = p[k];
          if (typeof v === 'object') {
            r[k] = v.uri || v.name || v.iconName || JSON.stringify(v).slice(0, 80);
          } else {
            r[k] = String(v).slice(0, 80);
          }
        }
      }
      return r;
    }

    function kickMeasure(stateNode, tag) {
      try {
        var fn = (stateNode.canonical && stateNode.canonical.measureInWindow) || stateNode.measureInWindow;
        if (typeof fn !== 'function') return;
        fn.call(stateNode.canonical || stateNode, function (x, y, w, h) {
          globalThis.__agentest_measures[String(tag)] = { x: x, y: y, width: w, height: h };
        });
      } catch (e) { /* ignore */ }
    }

    function collect(fiber, depth) {
      if (!fiber || depth > 2000) return;
      // tag 5 = HostComponent in React's WorkTag enum (stable since React 16).
      if (fiber.tag === 5) {
        var sn = fiber.stateNode;
        var tag = sn && (sn._nativeTag || (sn.canonical && sn.canonical.nativeTag) || sn.__nativeTag);
        if (sn) {
          nodes.push({
            tag: tag || null,
            host: typeof fiber.type === 'string' ? fiber.type : null,
            component: nameFor(fiber._debugOwner || fiber.return),
            ancestors: ancestorChain(fiber),
            props: pickProps(fiber.memoizedProps),
          });
          if (tag) kickMeasure(sn, tag);
        }
      }
      collect(fiber.child, depth + 1);
      collect(fiber.sibling, depth + 1);
    }

    var rendererIds = [];
    hook.renderers.forEach(function (_, k) { rendererIds.push(k); });
    for (var j = 0; j < rendererIds.length; j++) {
      var roots = hook.getFiberRoots(rendererIds[j]);
      if (!roots) continue;
      roots.forEach(function (root) { collect(root.current, 0); });
    }

    return { ok: true, count: nodes.length, nodes: nodes };
  } catch (err) {
    return { ok: false, reason: 'exception', error: String(err) };
  }
})()`;

/**
 * Second-call reader. Returns whatever `measureInWindow` callbacks have
 * populated since the walker ran. Also clears the global for the next
 * cycle so we don't leak state across snapshots.
 */
const MEASUREMENTS_READER_EXPR = `(function () {
  try {
    var m = globalThis.__agentest_measures || {};
    globalThis.__agentest_measures = {};
    return { ok: true, measures: m };
  } catch (err) {
    return { ok: false };
  }
})()`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Timing knob — how long to wait between the walker call and the
 * measurements read. measureInWindow callbacks fire on the next JS event
 * loop turn after the native UI thread measures each view; 150ms is
 * plenty for a ~200-view tree on a warm emulator.
 */
export const FIBER_MEASURE_DELAY_MS = 150;

/**
 * Run the fiber walker once. Returns the list of host fibers (without
 * bounds yet — those come from `fetchFiberMeasurements` after a short
 * wait). Returns null on any failure: no hook, stale Hermes connection,
 * parse error, etc. Silent degradation.
 */
export async function extractReactFiberTree(client: HermesCdpClient): Promise<FiberNode[] | null> {
  let raw: unknown;
  try {
    raw = await client.evaluate(FIBER_WALKER_EXPR);
  } catch (err) {
    console.error(
      `[agentest fiber] walker evaluate threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (!raw || typeof raw !== 'object' || !('ok' in raw)) {
    return null;
  }
  const result = raw as FiberWalkerResult;
  if (!result.ok || !Array.isArray(result.nodes)) {
    if (result.reason) {
      console.error(`[agentest fiber] walker returned ok:false reason=${result.reason}`);
    }
    return null;
  }

  return result.nodes;
}

/**
 * Read the measurements collected by the walker's background
 * `measureInWindow` callbacks. Expects the caller to have waited at
 * least `FIBER_MEASURE_DELAY_MS` milliseconds since the walker
 * returned. Returns an empty map on failure — callers should fall
 * through to non-bounds correlation strategies (testID / accessibilityLabel).
 */
export async function fetchFiberMeasurements(
  client: HermesCdpClient,
): Promise<Map<number, FiberBounds>> {
  let raw: unknown;
  try {
    raw = await client.evaluate(MEASUREMENTS_READER_EXPR);
  } catch {
    return new Map();
  }
  if (!raw || typeof raw !== 'object' || !('ok' in raw)) {
    return new Map();
  }
  const result = raw as FiberMeasurementsResult;
  if (!result.ok || !result.measures) return new Map();

  const map = new Map<number, FiberBounds>();
  for (const [tagStr, bounds] of Object.entries(result.measures)) {
    const tag = Number(tagStr);
    if (Number.isFinite(tag) && bounds && typeof bounds === 'object') {
      map.set(tag, bounds);
    }
  }
  return map;
}

/**
 * Convenience: run the full two-call extraction pipeline. Walks the
 * fiber tree, waits for measurements, fetches them, and returns the
 * nodes with bounds attached where available. Nodes without bounds
 * still come through — correlation in `fiber-merger.ts` handles them
 * via testID / accessibilityLabel fallbacks.
 *
 * Returns null on walker failure. Returns an array (possibly with
 * some missing bounds) on partial failure.
 */
export async function extractFibersWithBounds(
  client: HermesCdpClient,
  delayMs = FIBER_MEASURE_DELAY_MS,
): Promise<FiberNode[] | null> {
  const nodes = await extractReactFiberTree(client);
  if (!nodes) return null;

  await sleep(delayMs);
  const measures = await fetchFiberMeasurements(client);

  for (const node of nodes) {
    if (node.tag != null) {
      const b = measures.get(node.tag);
      if (b) node.bounds = b;
    }
  }
  return nodes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
