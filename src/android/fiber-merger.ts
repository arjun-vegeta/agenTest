/**
 * Merge React Fiber nodes with the accessibility tree to produce
 * inherited labels for unlabeled interactive elements. Phase 3.6.
 *
 * The input:
 *   - A `UnifiedUINode` tree from the a11y dump
 *   - A `FiberNode[]` from `extractFibersWithBounds`
 *   - An optional density factor (physical pixels / DIPs)
 *
 * The output:
 *   - A `Map<nodeId, string>` of a11y node id → inherited label
 *
 * The same map is fed into `hoistClickableLabels` as `externalLabels`
 * and takes priority over the BFS descendant fallback.
 *
 * Correlation strategy (three stages, in descending confidence):
 *
 *   Stage A — exact testID / accessibilityLabel match. When a fiber
 *   has either prop set, RN guarantees it flows through to the
 *   underlying View as `resource-id` (testID) or `content-desc`
 *   (accessibilityLabel). We match by value and attach the fiber's
 *   component name or icon prop. 100% reliable, zero bounds needed.
 *
 *   Stage B — bounds intersection. For unmatched fibers with measured
 *   bounds, convert DIPs → physical pixels using `densityFactor` and
 *   find a11y nodes whose bounds match within a jitter tolerance.
 *   Medium confidence; ambiguous matches are rejected.
 *
 *   Stage C — fiber dedup. Before emitting, dedupe fibers that all
 *   resolve to the same component name within the same bounds bucket
 *   (this is what an SVG icon tree looks like — one `<Camera>` is
 *   actually 6 separate host fibers for the path/group/svg). Keep the
 *   outermost one.
 *
 * The merger ONLY produces labels for a11y nodes that have no own
 * label (no text, description, hintText, or tooltipText). It NEVER
 * overwrites an existing label — hoisting is pure enrichment.
 */

import type { UnifiedUINode } from '../types.js';
import type { FiberBounds, FiberNode } from './fiber-extractor.js';

/** How much bounds jitter to tolerate when matching fiber to a11y node. */
const BOUNDS_JITTER_PX = 8;

/** Size tolerance for the offset calibration pass — fibers and a11y
 *  nodes with matching widths/heights within this tolerance count as
 *  candidates for computing the vertical offset. */
const CALIBRATION_SIZE_TOLERANCE_PX = 4;

/**
 * Generic host component classes — these are the RN primitives that
 * every layout wrapper renders under the hood. When multiple fibers
 * share the same bounds, we prefer ones with more specific hosts
 * (e.g. RNSVGSvgViewAndroid, ViewManagerAdapter_*, RCTText, ReactEditText)
 * over these generic wrappers.
 *
 * The key insight that generalizes across every RN app ever written:
 * `RCTView` is the native host for `<View>`. Pressable, TouchableOpacity,
 * and every layout wrapper renders an `RCTView` internally. When a fiber
 * is an `RCTView`, walking up its owner chain always finds the nearest
 * USER-defined component, which is almost always the screen name
 * (`ProfilePage`, `ChatScreen`, etc.) rather than the icon inside. We
 * want the icon, not the screen.
 *
 * By contrast, every other host is a SPECIALIZED widget:
 * - `RNSVGSvgViewAndroid` / `RNSVGPath` — rendered by icon components
 * - `ViewManagerAdapter_ExpoImage` / `RCTImageView` — specific image widgets
 * - `ReactEditText` / `RCTTextInput` — text inputs
 * - `RCTText` / `RCTRawText` — text leaves
 * These hosts only appear when a specific widget component is on screen,
 * so their fiber's nearest non-generic ancestor IS the icon/widget name.
 */
const GENERIC_HOSTS = new Set([
  'RCTView',
  'RCTScrollView',
  'RCTSafeAreaView',
  'RNCSafeAreaView',
  'RNCSafeAreaProvider',
  'RNGestureHandlerRootView',
  'RNSScreen',
  'RNSScreenStack',
  'RNSScreenContentWrapper',
  'KeyboardControllerView',
]);

function isGenericHost(host: string | null | undefined): boolean {
  return host === null || host === undefined || GENERIC_HOSTS.has(host);
}

/**
 * Component names that are too generic to be useful labels on their
 * own. When `fiber.component` is one of these, we prefer props or
 * skip the fiber entirely.
 */
const GENERIC_COMPONENTS = new Set([
  // Core RN primitives
  'View',
  'Text',
  'Image',
  'Pressable',
  'TouchableOpacity',
  'TouchableWithoutFeedback',
  'TouchableHighlight',
  'TouchableNativeFeedback',
  // SVG primitives
  'Svg',
  'G',
  'Path',
  'Rect',
  'Circle',
  'Line',
  'Ellipse',
  'Polygon',
  'Polyline',
  'Defs',
  'ClipPath',
  'Mask',
  'Use',
  'SvgXml',
  'SvgAst',
  // Native host classes
  'RCTView',
  'RCTText',
  'RCTImageView',
  // Gradient / blur / decorative
  'ExpoLinearGradient',
  'NativeLinearGradient',
  'LinearGradient',
  'BlurView',
  'ExpoBlurView',
  'GlassContainer',
  'GlassCard',
  // Animation wrappers
  'AnimatedComponent(View)',
  'Animated(View)',
  'Animated(Anonymous)',
  'PureComponentWrapper',
  // Scroll primitives
  'ScrollView',
  'ScrollComponent',
  'AnimatedComponent(ScrollView)',
  'KeyboardAvoidingView',
  'SafeAreaView',
  // App-level structural wrappers — never useful labels
  'SafeAreaProvider',
  'SafeAreaProviderCompat',
  'SafeAreaListener',
  'GestureHandlerRootView',
  'ScreenStack',
  'ScreenStackHeaderConfig',
  'SceneView',
  'NativeStackView',
  'NativeStackNavigator',
  'Navigation',
  'NavigationContainer',
  'Root',
  'App',
  'AppContainer',
  'RootComponent',
  'PerformanceLoggerContext',
  'KeyboardProvider',
  'MenuProvider',
  'Menu',
  'MenuTrigger',
  'Screen',
  'Page',
  // FlashList / RecyclerListView internals
  'AutoLayoutView',
  'ViewRenderer',
  'StickyContainer',
  // Debugging overlays
  'DebuggingOverlay',
]);

export interface FiberLabel {
  /** The human-readable label to attach. */
  label: string;
  /** Where it came from — used for debugging, not emitted to the LLM. */
  source: 'testID' | 'accessibilityLabel' | 'bounds';
}

/** Breakdown of why the merger produced (or didn't produce) labels. */
export interface FiberMergerStats {
  totalFibers: number;
  dedupedFibers: number;
  fibersWithBounds: number;
  unlabeledA11yNodes: number;
  stageAMatches: number;
  stageBMatches: number;
  stageBNoMatch: number;
  /** Vertical offset auto-detected during Stage B calibration. */
  calibrationOffsetY?: number;
}

/**
 * The main entry point. Returns a map of `UnifiedUINode.id` to an
 * inherited label derived from the fiber tree.
 *
 * `densityFactor` converts fiber bounds (logical pixels / DIPs) to
 * a11y-tree bounds (physical pixels). Pass `deviceInfo.density / 160`
 * or, if unavailable, 1 (which matches most emulators at density=160
 * or skips bounds correlation on high-density devices).
 */
export function mergeFiberLabels(
  tree: UnifiedUINode,
  fibers: FiberNode[],
  densityFactor: number,
  stats?: FiberMergerStats,
): Map<string, FiberLabel> {
  const out = new Map<string, FiberLabel>();

  // Flatten the a11y tree for faster lookups.
  const allNodes: UnifiedUINode[] = [];
  collectNodes(tree, allNodes);

  if (stats) {
    stats.totalFibers = fibers.length;
    stats.fibersWithBounds = fibers.filter((f) => f.bounds).length;
    stats.unlabeledA11yNodes = allNodes.filter((n) => !hasOwnLabel(n)).length;
  }

  // Build quick lookup structures.
  const nodesByResourceId = new Map<string, UnifiedUINode[]>();
  const nodesByDescription = new Map<string, UnifiedUINode[]>();
  for (const node of allNodes) {
    if (node.resourceId) {
      const key = shortResourceId(node.resourceId);
      if (!nodesByResourceId.has(key)) nodesByResourceId.set(key, []);
      const arr = nodesByResourceId.get(key);
      if (arr) arr.push(node);
    }
    if (node.description) {
      const d = node.description.trim();
      if (!nodesByDescription.has(d)) nodesByDescription.set(d, []);
      const arr = nodesByDescription.get(d);
      if (arr) arr.push(node);
    }
  }

  // Dedupe fibers: group by (component, bounds-bucket) and keep the
  // outermost (largest bounds) per group. An SVG icon like <Camera>
  // produces 6 host fibers (View, Svg, G, Path, Path, Path) all with
  // component="Camera" and overlapping bounds — we only want one label
  // per visual icon.
  const dedupedFibers = dedupeFibers(fibers);
  if (stats) stats.dedupedFibers = dedupedFibers.length;

  // Stage A: exact prop matches (testID and accessibilityLabel).
  for (const fiber of dedupedFibers) {
    const label = preferredLabel(fiber);
    if (!label) continue;

    if (fiber.props['testID']) {
      const nodes = nodesByResourceId.get(fiber.props['testID']) ?? [];
      for (const n of nodes) {
        if (hasOwnLabel(n)) continue;
        if (!out.has(n.id)) {
          out.set(n.id, { label, source: 'testID' });
          if (stats) stats.stageAMatches++;
        }
      }
    }

    if (fiber.props['accessibilityLabel']) {
      const nodes = nodesByDescription.get(fiber.props['accessibilityLabel']) ?? [];
      for (const n of nodes) {
        if (hasOwnLabel(n)) continue;
        if (!out.has(n.id)) {
          out.set(n.id, { label, source: 'accessibilityLabel' });
          if (stats) stats.stageAMatches++;
        }
      }
    }
  }

  // Stage B — a11y-first containment matching.
  //
  // The research-backed algorithm (see Phase 3.6 research report):
  //
  //   1. Build candidate fibers: any fiber with bounds, a non-generic
  //      host (i.e. not RCTView / RCTScrollView / SafeAreaProvider),
  //      and a preferred label. These are the fibers that represent
  //      user-visible visual content — icons, text, images, inputs.
  //
  //   2. For each unlabeled clickable a11y node, sorted by AREA
  //      ASCENDING, find the tightest fiber whose bounds are CONTAINED
  //      inside the a11y node's bounds. Ascending order means the
  //      innermost button (smallest bounds) claims labels first; a
  //      larger parent card doesn't steal the icon's label.
  //
  //   3. "Contained" handles the core RN flattening problem: a
  //      `<Pressable>` renders as ONE clickable a11y node at 48×48,
  //      but inside the fiber tree the Svg icon is at 24×24, nested
  //      within the Pressable's View. Exact-bounds matching would
  //      fail; containment matching finds the 24×24 Svg inside the
  //      48×48 tap target and picks it as the label.
  //
  //   4. Tightest wins because the LEAF fiber (smallest area) is the
  //      actual icon, while larger containing fibers are structural
  //      wrappers (Pressable, InputSection, ChatScreen, ...). The
  //      smallest-area tiebreaker naturally picks the right thing
  //      without any hardcoded component-name heuristics.
  //
  //   5. Each fiber labels at most ONE a11y node (tracked in `used`).
  //      Combined with ascending-area sort, this guarantees each
  //      fiber lands on the smallest a11y container that holds it.
  //
  // This matches the containment approach used by Chrome DevTools
  // Inspect, Android Studio's Layout Inspector for Compose, and
  // Flipper's React Native plugin.
  if (densityFactor > 0) {
    // Calibration: the fiber's measureInWindow coordinates may be
    // offset from the a11y tree's absolute screen coordinates — the
    // delta is whatever offset sits above/left of the React root view
    // (status bar + action bar on embedded apps; 0 on fullscreen RN
    // apps). We auto-detect it by finding fibers whose (width, height)
    // match an a11y node's exactly and voting on the most common
    // (Δx, Δy) delta. No hardcoded constants.
    const { offsetX, offsetY } = calibrateOffset(dedupedFibers, allNodes, densityFactor);
    if (stats) stats.calibrationOffsetY = offsetY;

    // Build candidate fiber list: fibers that represent real visual
    // content (non-generic host), with valid bounds and a preferred
    // label. We pre-compute physical bounds and areas once.
    interface Candidate {
      fiber: FiberNode;
      label: string;
      rect: PhysicalBounds;
      area: number;
      depth: number;
      hasExplicitProps: boolean;
    }
    const candidates: Candidate[] = [];
    for (const fiber of dedupedFibers) {
      if (isGenericHost(fiber.host)) continue;
      if (!fiber.bounds) continue;
      if (
        typeof fiber.bounds.x !== 'number' ||
        typeof fiber.bounds.y !== 'number' ||
        typeof fiber.bounds.width !== 'number' ||
        typeof fiber.bounds.height !== 'number'
      )
        continue;
      // Drop zero-size fibers — they're unmounted or clipped views.
      if (fiber.bounds.width <= 0 || fiber.bounds.height <= 0) continue;
      const label = preferredLabel(fiber);
      if (!label) continue;

      const rect = dipToPhysical(fiber.bounds, densityFactor, offsetX, offsetY);
      const area = (rect.right - rect.left) * (rect.bottom - rect.top);
      candidates.push({
        fiber,
        label,
        rect,
        area,
        depth: fiber.ancestors?.length ?? 0,
        hasExplicitProps:
          !!fiber.props['accessibilityLabel'] ||
          !!fiber.props['testID'] ||
          !!fiber.props['name'] ||
          !!fiber.props['icon'],
      });
    }

    // Collect unlabeled clickable a11y nodes, sort by area ascending.
    // Ascending order means the tightest tap target gets first pick,
    // so nested clickables (button-inside-card) resolve correctly.
    const clickables: UnifiedUINode[] = [];
    for (const node of allNodes) {
      if (!node.clickable && !node.actions.includes('tap')) continue;
      if (hasOwnLabel(node)) continue;
      if (out.has(node.id)) continue; // already labeled by Stage A
      clickables.push(node);
    }
    clickables.sort((a, b) => boundsArea(a.bounds) - boundsArea(b.bounds));

    const usedFiberTags = new Set<number>();
    for (const a of clickables) {
      let best: Candidate | undefined;
      for (const c of candidates) {
        if (c.fiber.tag != null && usedFiberTags.has(c.fiber.tag)) continue;
        if (!rectContains(a.bounds, c.rect, BOUNDS_JITTER_PX)) continue;
        if (!best) {
          best = c;
          continue;
        }
        // Tightest (smallest-area) wins. Ties: deeper in fiber tree
        // wins (more specific owner). Further ties: explicit props
        // (accessibilityLabel/testID/name/icon) beat component-name-only.
        if (c.area < best.area) {
          best = c;
        } else if (c.area === best.area) {
          if (c.depth > best.depth) {
            best = c;
          } else if (c.depth === best.depth && c.hasExplicitProps && !best.hasExplicitProps) {
            best = c;
          }
        }
      }
      if (best) {
        out.set(a.id, { label: best.label, source: 'bounds' });
        if (best.fiber.tag != null) usedFiberTags.add(best.fiber.tag);
        if (stats) stats.stageBMatches++;
      } else {
        if (stats) stats.stageBNoMatch++;
      }
    }
  }

  return out;
}

/** Compute area of a UnifiedUINode's bounds in physical pixels². */
function boundsArea(b: UnifiedUINode['bounds']): number {
  return Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
}

/**
 * Rectangle containment with jitter: is `inner` contained inside `outer`?
 * The jitter allows for sub-pixel rounding and minor layout differences
 * between the fiber's `measureInWindow` pixels and the a11y tree's
 * `getBoundsInScreen` pixels.
 */
function rectContains(
  outer: UnifiedUINode['bounds'],
  inner: PhysicalBounds,
  jitter: number,
): boolean {
  return (
    inner.left >= outer.left - jitter &&
    inner.top >= outer.top - jitter &&
    inner.right <= outer.right + jitter &&
    inner.bottom <= outer.bottom + jitter
  );
}

/**
 * Flatten the fiber map to a `Map<nodeId, string>` — what
 * `hoistClickableLabels` expects as its `externalLabels` argument.
 */
export function fiberLabelsToPlainMap(map: Map<string, FiberLabel>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, { label }] of map) out.set(id, label);
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick the best user-facing label from a fiber's data. Prefers
 * explicit a11y props, then visible text props, then the component
 * name itself (if not generic).
 */
function preferredLabel(fiber: FiberNode): string | null {
  const p = fiber.props;
  if (p['accessibilityLabel']) return p['accessibilityLabel'];
  if (p['title']) return p['title'];
  if (p['label']) return p['label'];
  if (p['alt']) return p['alt'];
  if (p['name']) return p['name'];
  if (p['icon']) return p['icon'];
  if (p['contentDescription']) return p['contentDescription'];
  if (fiber.component && !GENERIC_COMPONENTS.has(fiber.component)) return fiber.component;
  return null;
}

function hasOwnLabel(node: UnifiedUINode): boolean {
  return !!(node.text || node.description || node.hintText || node.tooltipText);
}

function collectNodes(node: UnifiedUINode, out: UnifiedUINode[]): void {
  out.push(node);
  for (const child of node.children) collectNodes(child, out);
}

/** Strip the package prefix from a resource-id to match bare testIDs. */
function shortResourceId(resourceId: string): string {
  const slash = resourceId.indexOf('/');
  return slash >= 0 ? resourceId.slice(slash + 1) : resourceId;
}

/**
 * Dedupe fibers that all resolve to the same component within
 * near-identical bounds. Keeps the outermost (largest area) fiber
 * per group. When bounds aren't available, dedupe by (component, tag)
 * which at least drops exact duplicates.
 */
function dedupeFibers(fibers: FiberNode[]): FiberNode[] {
  const groups = new Map<string, FiberNode[]>();
  for (const f of fibers) {
    if (!f.component || GENERIC_COMPONENTS.has(f.component)) {
      // Component not useful as a grouping key — keep fiber as-is if
      // it has explicit props, drop otherwise.
      const hasProps = !!f.props['testID'] || !!f.props['accessibilityLabel'] || !!f.props['name'];
      if (!hasProps) continue;
    }

    const key = f.bounds
      ? `${f.component}|${Math.round(f.bounds.x / 10)}|${Math.round(f.bounds.y / 10)}|${Math.round(f.bounds.width / 10)}|${Math.round(f.bounds.height / 10)}`
      : `${f.component}|${f.tag ?? '?'}`;
    if (!groups.has(key)) groups.set(key, []);
    const arr = groups.get(key);
    if (arr) arr.push(f);
  }

  const out: FiberNode[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      const first = group[0];
      if (first) out.push(first);
      continue;
    }
    // Multi-fiber group: pick the one with the largest area (outermost)
    // — that's usually the parent container, not the child SVG path.
    let best = group[0];
    let bestArea = best && best.bounds ? best.bounds.width * best.bounds.height : -1;
    for (let i = 1; i < group.length; i++) {
      const f = group[i];
      if (!f) continue;
      const area = f.bounds ? f.bounds.width * f.bounds.height : -1;
      if (area > bestArea) {
        best = f;
        bestArea = area;
      }
    }
    if (best) out.push(best);
  }
  return out;
}

interface PhysicalBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function dipToPhysical(
  bounds: FiberBounds,
  factor: number,
  offsetX = 0,
  offsetY = 0,
): PhysicalBounds {
  return {
    left: Math.round(bounds.x * factor) + offsetX,
    top: Math.round(bounds.y * factor) + offsetY,
    right: Math.round((bounds.x + bounds.width) * factor) + offsetX,
    bottom: Math.round((bounds.y + bounds.height) * factor) + offsetY,
  };
}

/**
 * Auto-detect the physical-pixel offset between fiber window coordinates
 * and a11y screen coordinates. The delta is (almost always) just the
 * status bar / system UI inset top — ~72-156 px on modern Android.
 *
 * Algorithm: for each fiber whose (width, height) in physical pixels
 * matches an a11y node exactly, compute the (Δx, Δy) delta. Vote on
 * the most common (Δx, Δy) across all matches. Return the winner.
 *
 * Skips tiny fibers (< 10px) and full-viewport fibers (> 1000px on
 * either axis) to keep the calibration signal clean. Returns (0, 0)
 * if no reliable matches are found — Stage B will still try without
 * offset, so the worst case is no-op.
 */
function calibrateOffset(
  fibers: FiberNode[],
  allNodes: UnifiedUINode[],
  densityFactor: number,
): { offsetX: number; offsetY: number } {
  const deltaCounts = new Map<string, number>();

  for (const fiber of fibers) {
    if (!fiber.bounds) continue;
    if (
      typeof fiber.bounds.x !== 'number' ||
      typeof fiber.bounds.y !== 'number' ||
      typeof fiber.bounds.width !== 'number' ||
      typeof fiber.bounds.height !== 'number'
    )
      continue;

    const physX = Math.round(fiber.bounds.x * densityFactor);
    const physY = Math.round(fiber.bounds.y * densityFactor);
    const physW = Math.round(fiber.bounds.width * densityFactor);
    const physH = Math.round(fiber.bounds.height * densityFactor);

    // Skip calibration candidates that are too tiny (noise) or too
    // huge (root containers — those are the ones with weird negative
    // or extended-beyond-screen coordinates).
    if (physW < 10 || physH < 10) continue;
    if (physW > 1200 || physH > 2200) continue;

    for (const n of allNodes) {
      const nw = n.bounds.right - n.bounds.left;
      const nh = n.bounds.bottom - n.bounds.top;
      if (nw < 10 || nh < 10) continue;
      if (Math.abs(nw - physW) > CALIBRATION_SIZE_TOLERANCE_PX) continue;
      if (Math.abs(nh - physH) > CALIBRATION_SIZE_TOLERANCE_PX) continue;

      const dx = n.bounds.left - physX;
      const dy = n.bounds.top - physY;
      const key = `${dx},${dy}`;
      deltaCounts.set(key, (deltaCounts.get(key) ?? 0) + 1);
    }
  }

  let bestKey = '0,0';
  let bestCount = 0;
  for (const [key, count] of deltaCounts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }

  // Require at least 2 votes to accept a non-zero offset — a single
  // coincidental size match shouldn't move the offset.
  if (bestCount < 2) return { offsetX: 0, offsetY: 0 };

  const [dxStr, dyStr] = bestKey.split(',');
  return {
    offsetX: dxStr ? Number(dxStr) : 0,
    offsetY: dyStr ? Number(dyStr) : 0,
  };
}
