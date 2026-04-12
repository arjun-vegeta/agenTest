import { XMLParser } from 'fast-xml-parser';
import { ANDROID_CLASSES, BOUNDS_REGEX, DIFF_THRESHOLDS } from '../constants.js';
import { TreeParseError } from '../errors.js';
import type {
  Bounds,
  LlmTreeNode,
  Point,
  UnifiedAction,
  UnifiedRole,
  UnifiedUINode,
} from '../types.js';
import { UNIFIED_ACTIONS, UNIFIED_ROLES } from '../types.js';

// ---------------------------------------------------------------------------
// XML Parser (configured once, reused)
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (tagName: string) => {
    // Force 'node' tags to always be arrays so we handle single-child consistently
    return tagName === 'node';
  },
});

// ---------------------------------------------------------------------------
// Raw XML node shape (from fast-xml-parser)
// ---------------------------------------------------------------------------

interface RawXmlNode {
  index: string;
  text: string;
  'resource-id': string;
  class: string;
  package: string;
  'content-desc': string;
  checkable: string;
  checked: string;
  clickable: string;
  enabled: string;
  focusable: string;
  focused: string;
  scrollable: string;
  'long-clickable': string;
  password: string;
  selected: string;
  bounds: string;
  node?: RawXmlNode[];
}

interface RawXmlHierarchy {
  hierarchy: {
    rotation?: string;
    node?: RawXmlNode[];
  };
}

// ---------------------------------------------------------------------------
// Class → Role mapping
// ---------------------------------------------------------------------------

const CLASS_TO_ROLE: Record<string, UnifiedRole> = {
  [ANDROID_CLASSES.BUTTON]: UNIFIED_ROLES.BUTTON,
  [ANDROID_CLASSES.IMAGE_BUTTON]: UNIFIED_ROLES.IMAGE_BUTTON,
  [ANDROID_CLASSES.EDIT_TEXT]: UNIFIED_ROLES.TEXT_FIELD,
  [ANDROID_CLASSES.CHECK_BOX]: UNIFIED_ROLES.CHECK_BOX,
  [ANDROID_CLASSES.SWITCH]: UNIFIED_ROLES.SWITCH,
  [ANDROID_CLASSES.TOGGLE_BUTTON]: UNIFIED_ROLES.SWITCH,
  [ANDROID_CLASSES.RADIO_BUTTON]: UNIFIED_ROLES.RADIO_BUTTON,
  [ANDROID_CLASSES.SEEK_BAR]: UNIFIED_ROLES.SLIDER,
  [ANDROID_CLASSES.SPINNER]: UNIFIED_ROLES.SPINNER,
  [ANDROID_CLASSES.TEXT_VIEW]: UNIFIED_ROLES.TEXT_VIEW,
  [ANDROID_CLASSES.IMAGE_VIEW]: UNIFIED_ROLES.IMAGE,
  [ANDROID_CLASSES.PROGRESS_BAR]: UNIFIED_ROLES.PROGRESS_BAR,
  [ANDROID_CLASSES.SCROLL_VIEW]: UNIFIED_ROLES.SCROLL_VIEW,
  [ANDROID_CLASSES.HORIZONTAL_SCROLL_VIEW]: UNIFIED_ROLES.SCROLL_VIEW,
  [ANDROID_CLASSES.LIST_VIEW]: UNIFIED_ROLES.LIST,
  [ANDROID_CLASSES.RECYCLER_VIEW]: UNIFIED_ROLES.LIST,
  [ANDROID_CLASSES.WEB_VIEW]: UNIFIED_ROLES.WEB_VIEW,
  [ANDROID_CLASSES.TAB_WIDGET]: UNIFIED_ROLES.TAB,
  [ANDROID_CLASSES.TOOLBAR]: UNIFIED_ROLES.TOOLBAR,
  [ANDROID_CLASSES.ANDROIDX_TOOLBAR]: UNIFIED_ROLES.TOOLBAR,
};

// Layout container class name fragments — if the class contains one of these, it's a container
const CONTAINER_FRAGMENTS = ['Layout', 'ViewGroup', 'CardView', 'ComposeView', 'ReactViewGroup'];

function mapClassToRole(className: string): UnifiedRole {
  const direct = CLASS_TO_ROLE[className];
  if (direct) return direct;

  if (CONTAINER_FRAGMENTS.some((fragment) => className.includes(fragment))) {
    return UNIFIED_ROLES.CONTAINER;
  }

  return UNIFIED_ROLES.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Bounds parsing
// ---------------------------------------------------------------------------

export function parseBounds(boundsStr: string): Bounds {
  const match = BOUNDS_REGEX.exec(boundsStr);
  if (!match) {
    throw new TreeParseError(`Invalid bounds format: "${boundsStr}"`);
  }

  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
  };
}

export function boundsCenter(bounds: Bounds): Point {
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2),
  };
}

// ---------------------------------------------------------------------------
// Action derivation from state flags
// ---------------------------------------------------------------------------

function deriveActions(raw: RawXmlNode): UnifiedAction[] {
  const actions: UnifiedAction[] = [];

  if (raw.clickable === 'true') actions.push(UNIFIED_ACTIONS.TAP);
  if (raw['long-clickable'] === 'true') actions.push(UNIFIED_ACTIONS.LONG_PRESS);
  if (raw.scrollable === 'true') actions.push(UNIFIED_ACTIONS.SCROLL);
  if (raw.checkable === 'true') actions.push(UNIFIED_ACTIONS.CHECK);

  // EditText fields support typing
  if (raw.class === ANDROID_CLASSES.EDIT_TEXT) {
    actions.push(UNIFIED_ACTIONS.TYPE);
  }

  // SeekBar supports adjustment
  if (raw.class === ANDROID_CLASSES.SEEK_BAR) {
    actions.push(UNIFIED_ACTIONS.ADJUST);
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Bool helper
// ---------------------------------------------------------------------------

function parseBool(value: string): boolean {
  return value === 'true';
}

// ---------------------------------------------------------------------------
// Recursive node conversion
// ---------------------------------------------------------------------------

function convertNode(raw: RawXmlNode, pathPrefix: string): UnifiedUINode {
  const nodeIndex = raw.index ?? '0';
  const id = pathPrefix ? `${pathPrefix}.${nodeIndex}` : nodeIndex;
  const bounds = parseBounds(raw.bounds);

  const node: UnifiedUINode = {
    id,
    resourceId: raw['resource-id'] ?? '',
    className: raw.class ?? '',
    role: mapClassToRole(raw.class ?? ''),
    text: String(raw.text ?? ''),
    description: raw['content-desc'] ?? '',
    packageName: raw.package ?? '',
    bounds,
    center: boundsCenter(bounds),
    index: Number(nodeIndex),

    enabled: parseBool(raw.enabled),
    focused: parseBool(raw.focused),
    selected: parseBool(raw.selected),
    checked: parseBool(raw.checked),
    checkable: parseBool(raw.checkable),
    clickable: parseBool(raw.clickable),
    scrollable: parseBool(raw.scrollable),
    longClickable: parseBool(raw['long-clickable']),
    password: parseBool(raw.password),

    // Compose a11y extras — `uiautomator dump` XML doesn't expose them so
    // the XML path always defaults to empty. Helper JSON path populates
    // them when the app is built with Compose.
    hintText: '',
    stateDescription: '',
    paneTitle: '',
    tooltipText: '',

    actions: deriveActions(raw),
    children: [],
  };

  if (raw.node) {
    node.children = raw.node.map((child) => convertNode(child, id));
  }

  return node;
}

// ---------------------------------------------------------------------------
// Helper JSON tree shape (from on-device helper APK /tree endpoint)
// ---------------------------------------------------------------------------

/** Raw JSON shape returned by HelperServer's /tree endpoint (full mode). */
export interface HelperJsonNode {
  id?: string;
  class?: string;
  text?: string;
  description?: string;
  packageName?: string;
  bounds: string;
  enabled?: boolean;
  checked?: boolean;
  checkable?: boolean;
  focused?: boolean;
  selected?: boolean;
  clickable?: boolean;
  longClickable?: boolean;
  scrollable?: boolean;
  password?: boolean;
  /**
   * Compose-specific accessibility fields (Phase 3.8). These are populated
   * on API 26+/28+ when the running app is built with Jetpack Compose and
   * uses `Modifier.semantics { stateDescription = ... }` etc. Native Views
   * rarely set them so they're a strong Compose signal as well as useful
   * content for the LLM.
   */
  hintText?: string;
  stateDescription?: string;
  paneTitle?: string;
  tooltipText?: string;
  children?: HelperJsonNode[];
}

export interface HelperTreeResponse {
  ok: boolean;
  packageName: string;
  compact: boolean;
  tree: HelperJsonNode;
}

/**
 * Convert the helper APK's JSON tree directly to UnifiedUINode, skipping the
 * XML parsing path entirely. The helper produces this JSON in-process from
 * AccessibilityNodeInfo, ~5-10x faster than `uiautomator dump`.
 */
export function parseHelperJsonTree(json: HelperTreeResponse): UnifiedUINode {
  if (!json.ok) {
    throw new TreeParseError('Helper /tree returned ok=false');
  }
  return convertHelperNode(json.tree, '', 0);
}

function convertHelperNode(raw: HelperJsonNode, pathPrefix: string, index: number): UnifiedUINode {
  const id = pathPrefix ? `${pathPrefix}.${index}` : String(index);
  const bounds = parseBounds(raw.bounds);
  const className = raw.class ?? '';
  const clickable = raw.clickable ?? false;
  const longClickable = raw.longClickable ?? false;
  const scrollable = raw.scrollable ?? false;
  const checkable = raw.checkable ?? false;

  const actions: UnifiedAction[] = [];
  if (clickable) actions.push(UNIFIED_ACTIONS.TAP);
  if (longClickable) actions.push(UNIFIED_ACTIONS.LONG_PRESS);
  if (scrollable) actions.push(UNIFIED_ACTIONS.SCROLL);
  if (checkable) actions.push(UNIFIED_ACTIONS.CHECK);
  if (className === ANDROID_CLASSES.EDIT_TEXT) actions.push(UNIFIED_ACTIONS.TYPE);
  if (className === ANDROID_CLASSES.SEEK_BAR) actions.push(UNIFIED_ACTIONS.ADJUST);

  const node: UnifiedUINode = {
    id,
    resourceId: raw.id ?? '',
    className,
    role: mapClassToRole(className),
    text: raw.text ?? '',
    description: raw.description ?? '',
    packageName: raw.packageName ?? '',
    bounds,
    center: boundsCenter(bounds),
    index,
    enabled: raw.enabled ?? true,
    focused: raw.focused ?? false,
    selected: raw.selected ?? false,
    checked: raw.checked ?? false,
    checkable,
    clickable,
    scrollable,
    longClickable,
    password: raw.password ?? false,
    hintText: raw.hintText ?? '',
    stateDescription: raw.stateDescription ?? '',
    paneTitle: raw.paneTitle ?? '',
    tooltipText: raw.tooltipText ?? '',
    actions,
    children: [],
  };

  if (raw.children && raw.children.length > 0) {
    node.children = raw.children.map((child, i) => convertHelperNode(child, id, i));
  }

  return node;
}

// ---------------------------------------------------------------------------
// Public API: parse full XML → UnifiedUINode tree
// ---------------------------------------------------------------------------

export function parseUiAutomatorXml(xml: string): UnifiedUINode {
  let parsed: RawXmlHierarchy;
  try {
    parsed = xmlParser.parse(xml) as RawXmlHierarchy;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TreeParseError(`Failed to parse uiautomator XML: ${message}`);
  }

  if (!parsed.hierarchy) {
    throw new TreeParseError('XML missing <hierarchy> root element');
  }

  const rootNodes = parsed.hierarchy.node;
  if (!rootNodes || rootNodes.length === 0) {
    throw new TreeParseError('XML hierarchy contains no nodes');
  }

  // If single root node, return it directly; otherwise wrap in a virtual container
  const singleRoot = rootNodes.length === 1 ? rootNodes[0] : undefined;
  if (singleRoot) {
    return convertNode(singleRoot, '');
  }

  // Multiple roots — wrap in virtual node
  return {
    id: 'root',
    resourceId: '',
    className: 'hierarchy',
    role: UNIFIED_ROLES.CONTAINER,
    text: '',
    description: '',
    packageName: '',
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    center: { x: 0, y: 0 },
    index: 0,
    enabled: true,
    focused: false,
    selected: false,
    checked: false,
    checkable: false,
    clickable: false,
    scrollable: false,
    longClickable: false,
    password: false,
    hintText: '',
    stateDescription: '',
    paneTitle: '',
    tooltipText: '',
    actions: [],
    children: rootNodes.map((child, i) => convertNode(child, String(i))),
  };
}

// ---------------------------------------------------------------------------
// LLM-friendly serialization (compact JSON) with tree pruning
// ---------------------------------------------------------------------------

/** System UI packages to exclude from the LLM tree */
const SYSTEM_UI_PACKAGES = new Set(['com.android.systemui']);

/**
 * Check if a node should be excluded from the LLM tree entirely.
 */
function shouldPruneNode(node: UnifiedUINode): boolean {
  // Remove system UI (status bar, navigation bar)
  if (SYSTEM_UI_PACKAGES.has(node.packageName)) return true;

  // Remove zero-size / invisible elements
  const width = node.bounds.right - node.bounds.left;
  const height = node.bounds.bottom - node.bounds.top;
  if (width <= 0 || height <= 0) return true;

  // Remove completely off-screen elements
  if (node.bounds.right <= 0 || node.bounds.bottom <= 0) return true;

  return false;
}

/**
 * Check if a node is an empty wrapper that should be collapsed.
 * A wrapper is a container with no identifying info, not interactive,
 * and has exactly one child — the child should replace it.
 */
function isEmptyWrapper(node: UnifiedUINode): boolean {
  if (node.children.length !== 1) return false;
  if (node.resourceId || node.text || node.description) return false;
  // Compose semantic modifiers count as labels — never collapse nodes that
  // have stateDescription/paneTitle/hintText/tooltipText populated.
  if (node.hintText || node.stateDescription || node.paneTitle || node.tooltipText) return false;
  if (node.clickable || node.scrollable || node.checkable) return false;
  if (node.role !== UNIFIED_ROLES.CONTAINER && node.role !== UNIFIED_ROLES.UNKNOWN) return false;
  return true;
}

/**
 * Serialize a node, collapsing wrapper chains.
 * Walks down single-child wrapper chains and serializes the first meaningful node.
 */
function resolveNode(node: UnifiedUINode): UnifiedUINode {
  let current = node;
  while (isEmptyWrapper(current) && current.children[0]) {
    current = current.children[0];
  }
  return current;
}

function serializeNode(node: UnifiedUINode): LlmTreeNode {
  const result: LlmTreeNode = {
    role: node.role,
    bounds: `[${node.bounds.left},${node.bounds.top}][${node.bounds.right},${node.bounds.bottom}]`,
  };

  // Only include non-empty identifying fields
  if (node.resourceId) result.id = node.resourceId;
  if (node.text) result.text = node.text;
  if (node.description) result.desc = node.description;

  // Compose-specific a11y fields (Phase 3.8). When present, these are huge
  // signals for LLMs: a Switch without text/desc is ambiguous, but a Switch
  // with `state: "on"` is unambiguous. Emit whenever populated.
  if (node.hintText) result.hint = node.hintText;
  if (node.stateDescription) result.state = node.stateDescription;
  if (node.paneTitle) result.pane = node.paneTitle;
  if (node.tooltipText) result.tooltip = node.tooltipText;

  // For unlabeled elements, include short class name so the AI can identify them
  const hasLabel =
    node.resourceId ||
    node.text ||
    node.description ||
    node.hintText ||
    node.stateDescription ||
    node.paneTitle ||
    node.tooltipText;
  if (!hasLabel) {
    const shortClass = node.className.split('.').pop() ?? node.className;
    if (shortClass && shortClass !== 'View' && shortClass !== 'ViewGroup') {
      result.cls = shortClass;
    }
  }

  // Only include non-default state flags
  if (!node.enabled) result.enabled = false;
  if (node.checked) result.checked = true;
  if (node.focused) result.focused = true;
  if (node.selected) result.selected = true;
  if (node.password) result.password = true;

  // For unlabeled tappable elements, explicitly flag as clickable
  if (node.clickable && !hasLabel) result.clickable = true;

  // Flag scrollable containers
  if (node.scrollable) result.scrollable = true;

  // Include actions if any
  if (node.actions.length > 0) result.actions = node.actions;

  // Recurse children with pruning
  if (node.children.length > 0) {
    const serializedChildren: LlmTreeNode[] = [];
    for (const child of node.children) {
      // Skip invisible/system nodes
      if (shouldPruneNode(child)) continue;
      // Collapse wrapper chains
      const resolved = resolveNode(child);
      if (shouldPruneNode(resolved)) continue;
      serializedChildren.push(serializeNode(resolved));
    }
    if (serializedChildren.length > 0) {
      result.children = serializedChildren;
    }
  }

  return result;
}

export function serializeTreeForLlm(node: UnifiedUINode): LlmTreeNode {
  const resolved = resolveNode(node);
  return serializeNode(resolved);
}

// ---------------------------------------------------------------------------
// Element search
// ---------------------------------------------------------------------------

export function findElements(
  root: UnifiedUINode,
  selector: {
    id?: string;
    text?: string;
    textContains?: string;
    className?: string;
    description?: string;
    index?: number;
  },
): UnifiedUINode[] {
  const matches: UnifiedUINode[] = [];
  collectMatches(root, selector, matches);

  if (selector.index !== undefined) {
    const picked = matches[selector.index];
    return picked ? [picked] : [];
  }

  return matches;
}

function collectMatches(
  node: UnifiedUINode,
  selector: {
    id?: string;
    text?: string;
    textContains?: string;
    className?: string;
    description?: string;
  },
  results: UnifiedUINode[],
): void {
  if (matchesSelector(node, selector)) {
    results.push(node);
  }
  for (const child of node.children) {
    collectMatches(child, selector, results);
  }
}

function matchesSelector(
  node: UnifiedUINode,
  selector: {
    id?: string;
    text?: string;
    textContains?: string;
    className?: string;
    description?: string;
  },
): boolean {
  // At least one criterion must be specified
  const hasCriteria =
    selector.id !== undefined ||
    selector.text !== undefined ||
    selector.textContains !== undefined ||
    selector.className !== undefined ||
    selector.description !== undefined;

  if (!hasCriteria) return false;

  // All specified criteria must match
  if (selector.id !== undefined && !node.resourceId.includes(selector.id)) {
    return false;
  }
  if (selector.text !== undefined && node.text !== selector.text) {
    return false;
  }
  if (selector.textContains !== undefined && !node.text.includes(selector.textContains)) {
    return false;
  }
  if (
    selector.className !== undefined &&
    node.className !== selector.className &&
    !node.className.endsWith(`.${selector.className}`) &&
    !node.className.includes(selector.className)
  ) {
    return false;
  }
  if (selector.description !== undefined && !node.description.includes(selector.description)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Fingerprinting (shared between idle detection and screenChanged gating)
// ---------------------------------------------------------------------------

/** Matches common time patterns like "12:34", "3:45 PM", "12:34:56" — these
 *  look like live timestamps and would otherwise wreck fingerprint stability. */
const TIMESTAMP_PATTERN = /^\d{1,2}:\d{2}(:\d{2})?(\s?(AM|PM|am|pm))?$/;

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * FNV-1a 32-bit hash → base36, padded to 6 chars. Stable, fast, no deps.
 * Plenty of bits for screen-fingerprint use: collisions across different
 * screens within a single session are statistically zero.
 */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

/**
 * Idle fingerprint: stable across cursor blink + bounds jitter + live
 * timestamps. Used by `idle.ts` to detect "is the UI still in flux?"
 * Includes EditText text content because typing IS a UI change as far as
 * idle detection cares.
 */
export function computeIdleFingerprint(node: UnifiedUINode): string {
  const parts: string[] = [];
  collectIdleFingerprint(node, parts);
  return parts.join('|');
}

function collectIdleFingerprint(node: UnifiedUINode, parts: string[]): void {
  parts.push(node.role);
  parts.push(node.resourceId);

  // Skip text that looks like a live timestamp
  if (node.text && !TIMESTAMP_PATTERN.test(node.text)) {
    parts.push(node.text);
  }

  parts.push(node.description);

  // Round bounds to nearest BOUNDS_JITTER_PX to ignore micro-shifts
  const jitter = DIFF_THRESHOLDS.BOUNDS_JITTER_PX;
  parts.push(
    String(roundTo(node.bounds.left, jitter)),
    String(roundTo(node.bounds.top, jitter)),
    String(roundTo(node.bounds.right, jitter)),
    String(roundTo(node.bounds.bottom, jitter)),
  );

  // Include key state flags (skip focused — cursor blink)
  parts.push(node.enabled ? '1' : '0', node.checked ? '1' : '0', node.selected ? '1' : '0');

  for (const child of node.children) {
    collectIdleFingerprint(child, parts);
  }
}

/**
 * Screen fingerprint: a 6-char hash that identifies "what screen am I on?"
 * for the `run_flow` screenChanged gate.
 *
 * Critical difference from idle fingerprint: text content of EditText fields
 * is EXCLUDED. Typing into a field changes the field's text but is NOT a
 * screen change — the LLM should not need a fresh tree just because it
 * typed a few characters. The LLM verifies type success via `assert_*`
 * which takes its own fresh snapshot, or via the final tree on `!success`.
 *
 * Other exclusions inherited from the idle fingerprint:
 * - cursor blink (focused state)
 * - sub-pixel bounds jitter
 * - live timestamp text
 *
 * System UI nodes are excluded so a transient permission dialog or status
 * bar update doesn't flip the fingerprint on every action.
 */
export function computeScreenFingerprint(node: UnifiedUINode): string {
  const parts: string[] = [];
  collectScreenFingerprint(node, parts);
  return shortHash(parts.join('|'));
}

function collectScreenFingerprint(node: UnifiedUINode, parts: string[]): void {
  if (shouldPruneNode(node)) return;

  parts.push(node.role);
  parts.push(node.resourceId);

  // EXCLUDE EditText text content — typing should not flip the fingerprint
  // (concern #1 from the plan review). Anything that supports the `type`
  // action or extends EditText is treated as an editable field.
  const isEditableField =
    node.className === ANDROID_CLASSES.EDIT_TEXT || node.actions.includes(UNIFIED_ACTIONS.TYPE);
  if (!isEditableField) {
    if (node.text && !TIMESTAMP_PATTERN.test(node.text)) {
      parts.push(node.text);
    }
  }

  parts.push(node.description);

  // Compose semantic fields are part of the screen identity (Phase 3.8)
  if (node.hintText) parts.push(`h:${node.hintText}`);
  if (node.stateDescription) parts.push(`s:${node.stateDescription}`);
  if (node.paneTitle) parts.push(`p:${node.paneTitle}`);

  // Bounds quantized — ignore tiny shifts
  const jitter = DIFF_THRESHOLDS.BOUNDS_JITTER_PX;
  parts.push(
    String(roundTo(node.bounds.left, jitter)),
    String(roundTo(node.bounds.top, jitter)),
    String(roundTo(node.bounds.right, jitter)),
    String(roundTo(node.bounds.bottom, jitter)),
  );

  // State flags (skip focused — cursor blink)
  parts.push(node.enabled ? '1' : '0', node.checked ? '1' : '0', node.selected ? '1' : '0');

  // Interactivity contributes to identity — a button becoming disabled IS
  // a meaningful screen change (e.g., form validation flipping submit on/off).
  parts.push(node.clickable ? '1' : '0', node.scrollable ? '1' : '0', node.checkable ? '1' : '0');

  for (const child of node.children) {
    collectScreenFingerprint(child, parts);
  }
}

// ---------------------------------------------------------------------------
// Compact text serialization (the main wire format)
// ---------------------------------------------------------------------------
//
// Replaces the JSON `LlmTreeNode` shape with an indented text format that
// is dense in the two signals zero-a11y apps actually have: visible text and
// hierarchy. Every interactive element is prefixed with a short ref token
// (`@b1`, `@f2`, …) the LLM can use as a selector via `{ ref: "@b1" }`.
//
// Example output for the login fixture:
//
//   screen 1080x1920 com.example.myapp #a1b2c3
//     "Login"
//     @f1 input "Email" focused
//     @f2 input password
//     @c1 check "Remember me"
//     @b1 btn "Sign in"
//     @l1 link "Forgot Password?"
//
// Format rules:
//   - Header: `screen WxH packageName #fingerprint`
//   - Indent: 2 spaces per level of (post-collapse) hierarchy
//   - Ref prefixes (per-prefix counters, reset per snapshot):
//       @b#  buttons & image-buttons
//       @f#  text fields (EditText / TextInput / nodes with TYPE action)
//       @c#  checkables (CheckBox / Switch / RadioButton / ToggleButton)
//       @l#  links — clickable text views
//       @s#  scrollables
//       @g#  generic clickables (anything else with click)
//   - Plain text nodes: `"text"` on their own line
//   - State tokens appended after the (optional) quoted label: focused,
//     password, checked, selected, disabled
//   - Wrapper containers (single child OR no own label/actions) are
//     collapsed transparently — children appear at the parent's indent
//   - System UI / off-screen / zero-size nodes are pruned
//
// Critical for the Bolt/v0/Lovable target user: clickable wrappers with no
// own label inherit a label from their first labeled descendant, via the
// `hoistClickableLabels` pass. This is what makes the format usable on apps
// where most operables are unlabeled `RCTView` / `GestureDetector` wrappers
// around a single `Text` child.
// ---------------------------------------------------------------------------

export interface CompactSerializeOptions {
  /** Hard cap on emitted lines. Anything beyond this is summarized in a
   *  truncation footer. Defaults to 200. (Concern #4) */
  maxLines?: number;
  /** Max indent depth. Subtrees deeper than this are summarized as a count
   *  on their parent line. 0 = unlimited. Defaults to 0 (unlimited). */
  maxDepth?: number;
  /** Drop plain text lines (text views that aren't already labels of a
   *  nearby interactive). Hoisting still puts the relevant labels onto
   *  interactives, so this is usually safe. Defaults to false. */
  onlyInteractive?: boolean;
  /**
   * Pre-computed labels keyed by `UnifiedUINode.id`. Takes priority over
   * BFS descendant hoisting when an interactive node has no own label.
   * Populated by `fiber-merger.ts` in Phase 3.6 — the correlation
   * between the React Fiber tree and the a11y tree produces labels
   * like `"ArrowLeft"` / `"Settings"` for otherwise-anonymous icon
   * buttons. Optional; when absent, behavior is unchanged.
   */
  externalLabels?: Map<string, string>;
}

export interface CompactSerializeResult {
  /** The indented text representation, ready to send to the LLM. */
  text: string;
  /** Screen fingerprint (6-char) — same value as computeScreenFingerprint. */
  fingerprint: string;
  /** Map from ref token (e.g. "@b1") to the underlying UnifiedUINode. */
  refMap: Map<string, UnifiedUINode>;
  /** Total interactive elements that received refs. */
  refCount: number;
  /** Number of lines emitted (interactive + text + structural). */
  lineCount: number;
  /** True if the maxLines cap kicked in. */
  truncated: boolean;
}

/**
 * The single mandatory pre-pass: walk the tree once and compute an
 * "effective label" for every clickable container that has no own
 * text/desc/hint/tooltip. The label is the first non-empty
 * text/desc/hint/tooltip from the subtree, BFS order.
 *
 * This is the make-or-break primitive for testing apps generated by Bolt /
 * v0 / Lovable / Cursor: those tools never set testID or contentDescription,
 * so almost every operable in the tree is a `RCTView` / `GestureDetector` /
 * `TouchableOpacity` whose only signal is a `Text` child somewhere below.
 * Without hoisting, refs would all be `@g1`, `@g2`, … with no human-readable
 * labels and the LLM couldn't disambiguate. With hoisting, those refs become
 * `@b1 btn "Sign in"`, `@b2 btn "Continue with Google"`, etc.
 */
export function hoistClickableLabels(
  tree: UnifiedUINode,
  externalLabels?: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  walkAndHoist(tree, out, externalLabels);
  return out;
}

function walkAndHoist(
  node: UnifiedUINode,
  out: Map<string, string>,
  externalLabels?: Map<string, string>,
): void {
  if (isInteractiveNode(node)) {
    const own = ownLabelOf(node);
    if (!own) {
      // External labels (from fiber-merger) take priority over BFS
      // descendant hoisting — they're higher-confidence because they
      // come from explicit React component data like `<ArrowLeft>` or
      // `accessibilityLabel` props the developer set.
      const external = externalLabels?.get(node.id);
      if (external) {
        out.set(node.id, external);
      } else {
        const inherited = findFirstLabelInSubtree(node);
        if (inherited) out.set(node.id, inherited);
      }
    }
  }
  for (const child of node.children) {
    walkAndHoist(child, out, externalLabels);
  }
}

/**
 * Maximum length for a content-desc to be treated as the node's own label.
 * Descriptions longer than this are almost always **aggregated a11y labels**
 * — the Android TalkBack-style concatenation of all descendant text nodes
 * (e.g. the chat app's outer clickable wrapper with a 120-char desc that's
 * just "long descriptive content-desc, …").
 * Such strings are not user-facing button names; emitting them on a ref
 * line wastes tokens and — because they become the "own label" — prevents
 * transparent-collapse and duplicate-suppression. Dropping them lets the
 * hoisting pass (or no-label + transparent-collapse) handle the wrapper
 * correctly.
 *
 * The threshold is applied only to `description` — `text`/`hintText`/
 * `tooltipText` are always user-controlled strings and are preserved in
 * full regardless of length.
 */
const MAX_DESCRIPTION_LENGTH = 80;

function ownLabelOf(node: UnifiedUINode): string {
  if (node.text) return node.text.trim();
  if (node.description) {
    const d = node.description.trim();
    if (d.length > MAX_DESCRIPTION_LENGTH) return '';
    return d;
  }
  if (node.hintText) return node.hintText.trim();
  if (node.tooltipText) return node.tooltipText.trim();
  return '';
}

function findFirstLabelInSubtree(node: UnifiedUINode): string {
  // BFS so we prefer closer descendants over deeper ones — closer = more
  // semantically related. Prune system UI / invisible as we go so we don't
  // pick up labels from off-screen content.
  //
  // CRITICAL: do NOT descend into interactive subtrees. Interactive
  // descendants deserve their own refs — stealing their labels would both
  // (a) hide them from the LLM (the duplicate-skip logic in walkCompact
  // would eat them), and (b) wrongly label the parent with content from
  // something the user would tap separately. For the chat "phone row"
  // pattern (outer TouchableOpacity > inner TouchableOpacity > +91 tap +
  // EditText) this is what prevents the wrapper hell where three nested
  // @b refs all inherit "enter number here" from the EditText.
  const queue: UnifiedUINode[] = [...node.children];
  while (queue.length > 0) {
    const n = queue.shift();
    if (!n) continue;
    if (shouldPruneNode(n)) continue;
    if (isInteractiveNode(n)) continue;
    const label = ownLabelOf(n);
    if (label) return label;
    queue.push(...n.children);
  }
  return '';
}

/**
 * A node is "interactive" if it can receive any AgenTest action: tap, type,
 * scroll, check, or long-press. This is the gate for whether the node gets
 * a ref token in the compact format.
 */
function isInteractiveNode(node: UnifiedUINode): boolean {
  return (
    node.clickable ||
    node.scrollable ||
    node.checkable ||
    node.longClickable ||
    node.actions.includes(UNIFIED_ACTIONS.TYPE) ||
    node.className === ANDROID_CLASSES.EDIT_TEXT
  );
}

type RefKind = 'b' | 'f' | 'c' | 'l' | 's' | 'g';

/**
 * Decide which ref prefix a node should get. Per concern #3 from the plan
 * review: the heuristic must catch the RN `TouchableOpacity > Text "Sign in"`
 * pattern as `@b#` (button), not `@g#` (generic). The rule is:
 *
 *   - scrollable                                                   → @s
 *   - EditText / TYPE action                                       → @f
 *   - checkable / class contains CheckBox/Switch/Radio/Toggle      → @c
 *   - class is/extends Button or ImageButton                       → @b
 *   - clickable text view                                          → @l
 *   - clickable + (label is short ≤30 chars OR hoisted)
 *     AND no scrollable/checkable/textfield descendants            → @b
 *   - everything else clickable                                    → @g
 */
function classifyRef(node: UnifiedUINode, effectiveLabel: string): RefKind {
  if (node.scrollable) return 's';

  const cls = node.className;

  // Text fields
  if (
    cls === ANDROID_CLASSES.EDIT_TEXT ||
    cls.includes('EditText') ||
    cls.includes('TextInput') ||
    node.actions.includes(UNIFIED_ACTIONS.TYPE)
  ) {
    return 'f';
  }

  // Checkables
  if (
    node.checkable ||
    cls.includes('CheckBox') ||
    cls.includes('Switch') ||
    cls.includes('RadioButton') ||
    cls.includes('ToggleButton')
  ) {
    return 'c';
  }

  // Native button classes
  if (
    cls === ANDROID_CLASSES.BUTTON ||
    cls === ANDROID_CLASSES.IMAGE_BUTTON ||
    cls.endsWith('.Button') ||
    cls.endsWith('.ImageButton') ||
    cls.endsWith('Button') // catches RN/Compose Button shims
  ) {
    return 'b';
  }

  // Clickable text view = link
  if (node.clickable && (cls === ANDROID_CLASSES.TEXT_VIEW || cls.endsWith('.TextView'))) {
    return 'l';
  }

  // Heuristic: clickable container with a short label and no complex
  // descendants is button-like (the RN TouchableOpacity > Text pattern).
  if (node.clickable) {
    const labelLen = effectiveLabel.length;
    if (labelLen > 0 && labelLen <= 30 && !hasComplexClickableDescendants(node)) {
      return 'b';
    }
    return 'g';
  }

  // Long-clickable but not clickable — generic
  return 'g';
}

function hasComplexClickableDescendants(node: UnifiedUINode): boolean {
  for (const child of node.children) {
    if (
      child.scrollable ||
      child.checkable ||
      child.className === ANDROID_CLASSES.EDIT_TEXT ||
      child.actions.includes(UNIFIED_ACTIONS.TYPE)
    ) {
      return true;
    }
    if (hasComplexClickableDescendants(child)) return true;
  }
  return false;
}

function refTypeWord(kind: RefKind, node: UnifiedUINode): string {
  switch (kind) {
    case 'b':
      return 'btn';
    case 'f':
      return 'input';
    case 'c': {
      const cls = node.className;
      if (cls.includes('Switch') || cls.includes('Toggle')) return 'switch';
      if (cls.includes('Radio')) return 'radio';
      return 'check';
    }
    case 'l':
      return 'link';
    case 's':
      return 'scroll';
    case 'g':
      return 'tap';
  }
}

function collectStateTokens(node: UnifiedUINode): string[] {
  const tokens: string[] = [];
  if (!node.enabled) tokens.push('disabled');
  if (node.password) tokens.push('password');
  if (node.checked) tokens.push('checked');
  if (node.focused) tokens.push('focused');
  if (node.selected) tokens.push('selected');
  if (node.stateDescription) tokens.push(`state="${node.stateDescription}"`);
  return tokens;
}

/**
 * "Effective" children for compact serialization: walks through pruned
 * (system UI / invisible) and empty-wrapper nodes, returning only the
 * descendants that will actually emit lines. Used for the wrapper-collapse
 * decision and for counting "+N more" in truncation summaries.
 */
function effectiveChildren(node: UnifiedUINode): UnifiedUINode[] {
  const out: UnifiedUINode[] = [];
  for (const child of node.children) {
    if (shouldPruneNode(child)) continue;
    if (isEmptyWrapper(child)) {
      out.push(...effectiveChildren(child));
    } else {
      out.push(child);
    }
  }
  return out;
}

function countInteractiveDescendants(node: UnifiedUINode): number {
  if (shouldPruneNode(node)) return 0;
  let count = isInteractiveNode(node) ? 1 : 0;
  for (const child of node.children) {
    count += countInteractiveDescendants(child);
  }
  return count;
}

/**
 * True if the subtree rooted at `node` contains any interactive element.
 * Used to decide whether an unlabeled clickable container should collapse
 * transparently (it does when it wraps other interactives — the LLM will
 * target those directly, so the outer wrapper adds no addressable value).
 */
function subtreeHasInteractive(node: UnifiedUINode): boolean {
  if (shouldPruneNode(node)) return false;
  if (isInteractiveNode(node)) return true;
  for (const child of node.children) {
    if (subtreeHasInteractive(child)) return true;
  }
  return false;
}

interface CompactCtx {
  lines: string[];
  refMap: Map<string, UnifiedUINode>;
  hoisted: Map<string, string>;
  counters: Record<RefKind, number>;
  maxLines: number;
  maxDepth: number;
  onlyInteractive: boolean;
  truncatedInteractive: number;
  truncated: boolean;
}

function isPlainTextNode(node: UnifiedUINode): boolean {
  return (
    !isInteractiveNode(node) &&
    node.className !== ANDROID_CLASSES.PROGRESS_BAR &&
    !!ownLabelOf(node)
  );
}

function escapeLabel(label: string): string {
  // Escape backslashes and quotes; collapse whitespace.
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim();
}

function indentStr(level: number): string {
  return '  '.repeat(level);
}

/**
 * The single visitor that turns a tree into compact text + ref map. Walks
 * once, makes all decisions inline, no second pass.
 *
 * `suppressLabel` is the label (if any) that the current subtree inherited
 * from a hoisted ancestor — e.g. when `@b1 btn "Sign in"` emitted a hoisted
 * label, every non-interactive descendant whose text is exactly `"Sign in"`
 * gets suppressed to avoid `@b1 btn "Sign in"` followed by `  "Sign in"`.
 * Scope resets at every new interactive element (each ref has its own
 * hoisting scope).
 */
function walkCompact(
  node: UnifiedUINode,
  indent: number,
  ctx: CompactCtx,
  suppressLabel?: string,
): void {
  if (ctx.truncated) return;
  if (shouldPruneNode(node)) return;

  // maxLines cap — accumulate "would have been" interactive count and stop
  if (ctx.lines.length >= ctx.maxLines) {
    ctx.truncatedInteractive += countInteractiveDescendants(node);
    ctx.truncated = true;
    return;
  }

  // maxDepth cap — summarize on parent line
  if (ctx.maxDepth > 0 && indent > ctx.maxDepth) {
    ctx.truncatedInteractive += countInteractiveDescendants(node);
    return;
  }

  // Empty wrapper: walk through transparently at the same indent (pass the
  // suppression down since the wrapper is "invisible" in the output).
  if (isEmptyWrapper(node) && node.children[0]) {
    walkCompact(node.children[0], indent, ctx, suppressLabel);
    return;
  }

  const interactive = isInteractiveNode(node);
  const own = ownLabelOf(node);
  const effectiveLabel = own || ctx.hoisted.get(node.id) || '';

  if (interactive) {
    // Transparent collapse for unlabeled clickable containers that wrap
    // other interactives — the chat "phone row" case: outer TouchableOpacity
    // > inner TouchableOpacity > (+91 tap + EditText). Without this
    // collapse, the LLM sees @g1 > @g2 > (@b1 + @f1) — three nested
    // wrappers that add no addressable value because the LLM targets the
    // +91 tap / EditText directly anyway.
    //
    // Scrollables and checkables are always emitted (scroll gestures have
    // their own semantics, checkables may be label-less CheckBoxes
    // paired with sibling text).
    if (
      !effectiveLabel &&
      !node.scrollable &&
      !node.checkable &&
      node.actions.indexOf(UNIFIED_ACTIONS.TYPE) === -1 &&
      node.className !== ANDROID_CLASSES.EDIT_TEXT
    ) {
      const kept = effectiveChildren(node);
      if (kept.some((c) => subtreeHasInteractive(c))) {
        for (const child of kept) {
          if (ctx.truncated) break;
          // Transparent — preserve the ancestor's suppression context.
          walkCompact(child, indent, ctx, suppressLabel);
        }
        return;
      }
    }

    const kind = classifyRef(node, effectiveLabel);
    ctx.counters[kind]++;
    const ref = `@${kind}${ctx.counters[kind]}`;
    const type = refTypeWord(kind, node);
    const states = collectStateTokens(node);

    let line = `${indentStr(indent)}${ref} ${type}`;
    if (effectiveLabel) line += ` "${escapeLabel(effectiveLabel)}"`;
    if (states.length > 0) line += ' ' + states.join(' ');
    ctx.lines.push(line);
    ctx.refMap.set(ref, node);

    // This interactive starts a fresh suppression scope: if it emitted
    // any label at all (own or hoisted), suppress any plain-text leaves
    // in this subtree whose text exactly matches. The live chat app has
    // buttons with BOTH `desc="sign up"` AND a child TextView with
    // `text="sign up"` — without this we'd emit:
    //     @b3 btn "sign up" disabled
    //       "sign up"
    // Nested interactives start their own scope, so a sibling button
    // with a different label inside the subtree still emits correctly.
    const childSuppressLabel = effectiveLabel || undefined;
    for (const child of effectiveChildren(node)) {
      if (ctx.truncated) break;
      walkCompact(child, indent + 1, ctx, childSuppressLabel);
    }
    return;
  }

  // Compose pane title — emit a labeled container line
  if (node.paneTitle) {
    ctx.lines.push(`${indentStr(indent)}pane "${escapeLabel(node.paneTitle)}"`);
    const childSuppressLabel = undefined;
    for (const child of effectiveChildren(node)) {
      if (ctx.truncated) break;
      walkCompact(child, indent + 1, ctx, childSuppressLabel);
    }
    return;
  }

  // Plain text leaf
  if (isPlainTextNode(node)) {
    // Skip the leaf if its text is the label we already emitted on an
    // ancestor ref line — avoids `@b1 btn "Sign in"` + `  "Sign in"`.
    if (suppressLabel && own === suppressLabel) return;
    if (!ctx.onlyInteractive) {
      ctx.lines.push(`${indentStr(indent)}"${escapeLabel(own)}"`);
    }
    return;
  }

  // Container with no own label and not interactive: transparent — recurse
  // children at the same indent, preserving the ancestor's suppression.
  // This is the aggressive wrapper collapse that beats today's serializer.
  for (const child of effectiveChildren(node)) {
    if (ctx.truncated) break;
    walkCompact(child, indent, ctx, suppressLabel);
  }
}

/**
 * Public entry point. Walks the tree once and produces the full compact
 * result: text + fingerprint + refMap + counters + truncation flag.
 */
export function serializeTreeCompact(
  tree: UnifiedUINode,
  opts?: CompactSerializeOptions,
): CompactSerializeResult {
  const maxLines = opts?.maxLines ?? 200;
  const maxDepth = opts?.maxDepth ?? 0;
  const onlyInteractive = opts?.onlyInteractive ?? false;

  const hoisted = hoistClickableLabels(tree, opts?.externalLabels);
  const fingerprint = computeScreenFingerprint(tree);

  // Header line: `screen WxH packageName #fingerprint`
  // Width/height come from the root node bounds; package from the root.
  const width = tree.bounds.right - tree.bounds.left;
  const height = tree.bounds.bottom - tree.bounds.top;
  const pkgPart = tree.packageName ? ` ${tree.packageName}` : '';
  const headerLine = `screen ${width}x${height}${pkgPart} #${fingerprint}`;

  const ctx: CompactCtx = {
    lines: [headerLine],
    refMap: new Map(),
    hoisted,
    counters: { b: 0, f: 0, c: 0, l: 0, s: 0, g: 0 },
    maxLines: maxLines + 1, // +1 because header counts but we still want N body lines
    maxDepth,
    onlyInteractive,
    truncatedInteractive: 0,
    truncated: false,
  };

  // The root itself is always treated as transparent — its children appear
  // at indent 1 directly under the header.
  for (const child of effectiveChildren(tree)) {
    if (ctx.truncated) break;
    walkCompact(child, 1, ctx);
  }

  // The root node may itself be a labeled interactive (rare); if it is and
  // nothing got emitted from its children, we still want it represented.
  // Falling out of the loop without lines past the header means the root
  // had no kept children — we DO emit the root as a line in that case to
  // avoid a header-only payload.
  if (ctx.lines.length === 1 && (isInteractiveNode(tree) || isPlainTextNode(tree))) {
    walkCompact(tree, 1, ctx);
  }

  if (ctx.truncated && ctx.truncatedInteractive > 0) {
    ctx.lines.push(
      `  ... +${ctx.truncatedInteractive} more interactive elements (use depth=N or onlyInteractive=true to filter)`,
    );
  }

  const refCount =
    ctx.counters.b +
    ctx.counters.f +
    ctx.counters.c +
    ctx.counters.l +
    ctx.counters.s +
    ctx.counters.g;

  return {
    text: ctx.lines.join('\n'),
    fingerprint,
    refMap: ctx.refMap,
    refCount,
    lineCount: ctx.lines.length,
    truncated: ctx.truncated,
  };
}
