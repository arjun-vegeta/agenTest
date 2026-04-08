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
// LLM-friendly serialization (compact JSON)
// ---------------------------------------------------------------------------

export function serializeTreeForLlm(node: UnifiedUINode): LlmTreeNode {
  const result: LlmTreeNode = {
    role: node.role,
    bounds: `[${node.bounds.left},${node.bounds.top}][${node.bounds.right},${node.bounds.bottom}]`,
  };

  // Only include non-empty identifying fields
  if (node.resourceId) result.id = node.resourceId;
  if (node.text) result.text = node.text;
  if (node.description) result.desc = node.description;

  // Only include non-default state flags
  if (!node.enabled) result.enabled = false;
  if (node.checked) result.checked = true;
  if (node.focused) result.focused = true;
  if (node.selected) result.selected = true;
  if (node.password) result.password = true;

  // Include actions if any
  if (node.actions.length > 0) result.actions = node.actions;

  // Recurse children
  if (node.children.length > 0) {
    result.children = node.children.map(serializeTreeForLlm);
  }

  return result;
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
  if (selector.className !== undefined && node.className !== selector.className) {
    return false;
  }
  if (selector.description !== undefined && !node.description.includes(selector.description)) {
    return false;
  }

  return true;
}
