import { XMLParser } from 'fast-xml-parser';
import { ANDROID_CLASSES, BOUNDS_REGEX } from '../constants.js';
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

  // For unlabeled elements, include short class name so the AI can identify them
  const hasLabel = node.resourceId || node.text || node.description;
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
