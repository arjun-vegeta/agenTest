import {
  UNIFIED_ROLES,
  UNIFIED_ACTIONS,
  type UnifiedRole,
  type UnifiedUINode,
  type Bounds,
  type UnifiedAction,
} from '../types.js';
import { TreeParseError } from '../errors.js';

export interface WdaJsonNode {
  type: string;
  name?: string;
  label?: string;
  value?: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  enabled?: boolean | number | string;
  visible?: boolean | number | string;
  children?: WdaJsonNode[];
}

export const XCUI_TO_ROLE: Record<string, UnifiedRole> = {
  XCUIElementTypeButton: UNIFIED_ROLES.BUTTON,
  XCUIElementTypeLink: UNIFIED_ROLES.BUTTON, // Links behave like buttons for AI
  XCUIElementTypeTextField: UNIFIED_ROLES.TEXT_FIELD,
  XCUIElementTypeSecureTextField: UNIFIED_ROLES.TEXT_FIELD,
  XCUIElementTypeTextView: UNIFIED_ROLES.TEXT_VIEW,
  XCUIElementTypeStaticText: UNIFIED_ROLES.TEXT_VIEW,
  XCUIElementTypeImage: UNIFIED_ROLES.IMAGE,
  XCUIElementTypeSwitch: UNIFIED_ROLES.SWITCH,
  XCUIElementTypeToggle: UNIFIED_ROLES.SWITCH,
  XCUIElementTypeCheckBox: UNIFIED_ROLES.CHECK_BOX,
  XCUIElementTypeRadioButton: UNIFIED_ROLES.RADIO_BUTTON,
  XCUIElementTypeSlider: UNIFIED_ROLES.SLIDER,
  XCUIElementTypePageIndicator: UNIFIED_ROLES.SPINNER,
  XCUIElementTypeProgressIndicator: UNIFIED_ROLES.PROGRESS_BAR,
  XCUIElementTypeActivityIndicator: UNIFIED_ROLES.SPINNER,
  XCUIElementTypeScrollView: UNIFIED_ROLES.SCROLL_VIEW,
  XCUIElementTypeTable: UNIFIED_ROLES.LIST,
  XCUIElementTypeCell: UNIFIED_ROLES.LIST_ITEM,
  XCUIElementTypeWebView: UNIFIED_ROLES.WEB_VIEW,
  XCUIElementTypeNavigationBar: UNIFIED_ROLES.TOOLBAR,
  XCUIElementTypeTabBar: UNIFIED_ROLES.TOOLBAR,
  XCUIElementTypeTab: UNIFIED_ROLES.TAB,
};

function parseBoolean(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') return val === 'true' || val === '1';
  return false;
}

export function parseWdaJsonTree(
  rawResponse: Record<string, unknown>,
  packageName = '',
): UnifiedUINode {
  // WDA source response can be nested inside a root object { value: ... } or just be the root node itself
  let root = rawResponse;
  if (rawResponse['value'] && typeof rawResponse['value'] === 'object') {
    root = rawResponse['value'] as Record<string, unknown>;
  }

  // WDA sometimes puts tree under tree property, or returns the node directly
  if (root['tree'] && typeof root['tree'] === 'object') {
    root = root['tree'] as Record<string, unknown>;
  }

  if (!root['type']) {
    throw new TreeParseError('WDA tree response is missing the root element type.');
  }

  return convertWdaNode(root as unknown as WdaJsonNode, '', 0, packageName);
}

function convertWdaNode(
  raw: WdaJsonNode,
  pathPrefix: string,
  index: number,
  packageName: string,
): UnifiedUINode {
  const id = pathPrefix ? `${pathPrefix}.${index}` : String(index);

  const rect = raw.rect || { x: 0, y: 0, width: 0, height: 0 };
  const bounds: Bounds = {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  };

  const className = raw.type;
  const role = XCUI_TO_ROLE[className] ?? UNIFIED_ROLES.CONTAINER;

  const enabled = raw.enabled !== undefined ? parseBoolean(raw.enabled) : true;

  // clickability heuristics for iOS
  const isClickableRole =
    role === UNIFIED_ROLES.BUTTON ||
    role === UNIFIED_ROLES.CHECK_BOX ||
    role === UNIFIED_ROLES.SWITCH ||
    role === UNIFIED_ROLES.RADIO_BUTTON ||
    role === UNIFIED_ROLES.TAB ||
    className === 'XCUIElementTypeCell' ||
    className === 'XCUIElementTypeLink';

  const clickable = isClickableRole && enabled;
  const scrollable = role === UNIFIED_ROLES.SCROLL_VIEW || role === UNIFIED_ROLES.LIST;
  const checkable = role === UNIFIED_ROLES.CHECK_BOX || role === UNIFIED_ROLES.SWITCH;

  // actions mapping
  const actions: UnifiedAction[] = [];
  if (clickable) actions.push(UNIFIED_ACTIONS.TAP);
  if (clickable) actions.push(UNIFIED_ACTIONS.LONG_PRESS); // WDA supports long press on all clickables
  if (scrollable) actions.push(UNIFIED_ACTIONS.SCROLL);
  if (checkable) actions.push(UNIFIED_ACTIONS.CHECK);
  if (role === UNIFIED_ROLES.TEXT_FIELD) actions.push(UNIFIED_ACTIONS.TYPE);
  if (role === UNIFIED_ROLES.SLIDER) actions.push(UNIFIED_ACTIONS.ADJUST);

  // In WDA, 'label' is typically the accessibility label, and 'value' can be the text content/input value.
  // StaticText has text in 'label' or 'name'.
  let text = '';
  if (role === UNIFIED_ROLES.TEXT_FIELD) {
    text = raw.value ?? raw.label ?? raw.name ?? '';
  } else {
    text = raw.value ?? raw.label ?? raw.name ?? '';
  }

  const description = raw.label ?? raw.name ?? '';

  const node: UnifiedUINode = {
    id,
    resourceId: raw.name ?? '', // Use 'name' (identifier) as resourceId for iOS
    className,
    role,
    text,
    description,
    packageName,
    bounds,
    center: {
      x: Math.round((bounds.left + bounds.right) / 2),
      y: Math.round((bounds.top + bounds.bottom) / 2),
    },
    index,
    enabled,
    focused: false, // WDA does not cleanly expose focus state
    selected: parseBoolean(raw.value) && role === UNIFIED_ROLES.TAB,
    checked: parseBoolean(raw.value) && checkable,
    checkable,
    clickable,
    scrollable,
    longClickable: clickable,
    password: className === 'XCUIElementTypeSecureTextField',
    hintText: '',
    stateDescription: '',
    paneTitle: '',
    tooltipText: '',
    actions,
    children: [],
  };

  if (raw.children && raw.children.length > 0) {
    node.children = raw.children.map((child, i) => convertWdaNode(child, id, i, packageName));
  }

  return node;
}
