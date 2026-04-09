import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shell Execution (dependency injection boundary)
// ---------------------------------------------------------------------------

export interface ShellExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ShellExecutor {
  exec(command: string, options?: ShellExecOptions): Promise<string>;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Unified UI Tree
// ---------------------------------------------------------------------------

export const UNIFIED_ROLES = {
  BUTTON: 'button',
  TEXT_FIELD: 'text_field',
  TEXT_VIEW: 'text_view',
  CHECK_BOX: 'check_box',
  SWITCH: 'switch',
  RADIO_BUTTON: 'radio_button',
  SLIDER: 'slider',
  SCROLL_VIEW: 'scroll_view',
  IMAGE: 'image',
  IMAGE_BUTTON: 'image_button',
  CONTAINER: 'container',
  LIST: 'list',
  LIST_ITEM: 'list_item',
  TAB: 'tab',
  TOOLBAR: 'toolbar',
  PROGRESS_BAR: 'progress_bar',
  SPINNER: 'spinner',
  WEB_VIEW: 'web_view',
  UNKNOWN: 'unknown',
} as const;

export type UnifiedRole = (typeof UNIFIED_ROLES)[keyof typeof UNIFIED_ROLES];

export const UNIFIED_ACTIONS = {
  TAP: 'tap',
  LONG_PRESS: 'long_press',
  TYPE: 'type',
  SCROLL: 'scroll',
  CHECK: 'check',
  ADJUST: 'adjust',
} as const;

export type UnifiedAction = (typeof UNIFIED_ACTIONS)[keyof typeof UNIFIED_ACTIONS];

export interface UnifiedUINode {
  /** Generated path-based id (e.g. "0.1.3") */
  id: string;
  /** Android resource-id (e.g. "com.example:id/email") */
  resourceId: string;
  /** Raw Android class name */
  className: string;
  /** Mapped abstract role */
  role: UnifiedRole;
  /** Visible text content */
  text: string;
  /** Content description (accessibility label) */
  description: string;
  /** App package name */
  packageName: string;
  /** Element bounds in screen pixels */
  bounds: Bounds;
  /** Center point for tap targeting */
  center: Point;
  /** Sibling index */
  index: number;

  // State flags
  enabled: boolean;
  focused: boolean;
  selected: boolean;
  checked: boolean;
  checkable: boolean;
  clickable: boolean;
  scrollable: boolean;
  longClickable: boolean;
  password: boolean;

  /** Available interaction actions */
  actions: UnifiedAction[];
  /** Child nodes */
  children: UnifiedUINode[];
}

// ---------------------------------------------------------------------------
// Element Selectors (multi-strategy targeting)
// ---------------------------------------------------------------------------

export const ElementSelectorSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe('Resource-id substring match (e.g. "email" matches "com.app:id/email")'),
    text: z.string().optional().describe('Visible text content (exact match)'),
    textContains: z.string().optional().describe('Visible text content (partial match)'),
    className: z.string().optional().describe('Android widget class name'),
    description: z.string().optional().describe('Content description / accessibility label'),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Pick the Nth match (0-based) when multiple elements match'),
  })
  .describe(
    'Element targeting — at least one of id, text, textContains, className, or description required',
  );

export type ElementSelector = z.infer<typeof ElementSelectorSchema>;

// ---------------------------------------------------------------------------
// Action Steps (discriminated union for run_flow)
// ---------------------------------------------------------------------------

const TapStepSchema = z.object({
  action: z.literal('tap'),
  target: ElementSelectorSchema,
});

const TypeStepSchema = z.object({
  action: z.literal('type'),
  target: ElementSelectorSchema,
  value: z.string().describe('Text to type into the element'),
});

const SwipeStepSchema = z.object({
  action: z.literal('swipe'),
  direction: z.enum(['up', 'down', 'left', 'right']),
  target: ElementSelectorSchema.optional().describe(
    'Element to swipe within; omit for screen-center swipe',
  ),
  durationMs: z.number().int().positive().optional().describe('Swipe duration in milliseconds'),
});

const LongPressStepSchema = z.object({
  action: z.literal('long_press'),
  target: ElementSelectorSchema,
  durationMs: z.number().int().positive().optional().describe('Hold duration in milliseconds'),
});

const TapCoordinatesStepSchema = z.object({
  action: z.literal('tap_coordinates'),
  x: z.number().describe('X coordinate in screen pixels'),
  y: z.number().describe('Y coordinate in screen pixels'),
});

const LongPressCoordinatesStepSchema = z.object({
  action: z.literal('long_press_coordinates'),
  x: z.number().describe('X coordinate in screen pixels'),
  y: z.number().describe('Y coordinate in screen pixels'),
  durationMs: z.number().int().positive().optional().describe('Hold duration in milliseconds'),
});

const DoubleTapStepSchema = z.object({
  action: z.literal('double_tap'),
  target: ElementSelectorSchema,
});

const DoubleTapCoordinatesStepSchema = z.object({
  action: z.literal('double_tap_coordinates'),
  x: z.number().describe('X coordinate in screen pixels'),
  y: z.number().describe('Y coordinate in screen pixels'),
});

const ClearTextStepSchema = z.object({
  action: z.literal('clear_text'),
  target: ElementSelectorSchema.describe('Text field to clear'),
});

const SwipeCoordinatesStepSchema = z.object({
  action: z.literal('swipe_coordinates'),
  x1: z.number().describe('Start X'),
  y1: z.number().describe('Start Y'),
  x2: z.number().describe('End X'),
  y2: z.number().describe('End Y'),
  durationMs: z.number().int().positive().optional().describe('Swipe duration in milliseconds'),
});

const PressKeyStepSchema = z.object({
  action: z.literal('press_key'),
  keycode: z
    .string()
    .describe('Android keycode name (e.g. "KEYCODE_BACK", "KEYCODE_HOME", "KEYCODE_ENTER")'),
});

const WaitStepSchema = z.object({
  action: z.literal('wait'),
  timeoutMs: z.number().int().positive().describe('Time to wait in milliseconds'),
});

const WaitForStableStepSchema = z.object({
  action: z.literal('wait_for_stable'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Max time to wait for UI to settle and loading indicators to disappear (default: 30s)',
    ),
});

const AssertVisibleSchema = z.object({
  action: z.literal('assert_visible'),
  target: ElementSelectorSchema,
});

const AssertNotVisibleSchema = z.object({
  action: z.literal('assert_not_visible'),
  target: ElementSelectorSchema,
});

const AssertTextEqualsSchema = z.object({
  action: z.literal('assert_text_equals'),
  target: ElementSelectorSchema,
  value: z.string().describe('Expected exact text'),
});

const AssertTextContainsSchema = z.object({
  action: z.literal('assert_text_contains'),
  target: ElementSelectorSchema,
  value: z.string().describe('Expected substring'),
});

const ScrollToSchema = z.object({
  action: z.literal('scroll_to'),
  target: ElementSelectorSchema.describe('Element to scroll until visible'),
  scrollTarget: ElementSelectorSchema.optional().describe(
    'Scrollable container to scroll within; omit to scroll the first scrollable ancestor or screen',
  ),
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe('Scroll direction (default: "down")'),
  maxScrolls: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max scroll attempts before failing (default: 10)'),
});

export const ActionStepSchema = z.discriminatedUnion('action', [
  TapStepSchema,
  TapCoordinatesStepSchema,
  TypeStepSchema,
  SwipeStepSchema,
  SwipeCoordinatesStepSchema,
  LongPressStepSchema,
  LongPressCoordinatesStepSchema,
  DoubleTapStepSchema,
  DoubleTapCoordinatesStepSchema,
  ClearTextStepSchema,
  PressKeyStepSchema,
  WaitStepSchema,
  WaitForStableStepSchema,
  AssertVisibleSchema,
  AssertNotVisibleSchema,
  AssertTextEqualsSchema,
  AssertTextContainsSchema,
  ScrollToSchema,
]);

export type ActionStep = z.infer<typeof ActionStepSchema>;

// ---------------------------------------------------------------------------
// Flow Execution Results
// ---------------------------------------------------------------------------

export interface StepResult {
  stepIndex: number;
  action: ActionStep;
  success: boolean;
  durationMs: number;
  error?: string;
  /** If loading indicators were detected, describes what was waited out (loading already finished) */
  loadingCompleted?: string;
}

export interface FlowTrace {
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
  results: StepResult[];
  /** UI tree snapshot at the end (or at point of failure) */
  finalUiTree: LlmTreeNode;
  error?: string;
  /** System dialogs detected during the flow (permission prompts, crash dialogs) */
  systemDialogs?: SystemDialog[];
  /** True if the app crashed during the flow (root package changed to system package) */
  appCrashDetected?: boolean;
}

// ---------------------------------------------------------------------------
// Device Info
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  screenWidth: number;
  screenHeight: number;
  density: number;
  sdkVersion: number;
  androidVersion: string;
  model: string;
  manufacturer: string;
}

// ---------------------------------------------------------------------------
// System Dialog Detection
// ---------------------------------------------------------------------------

export interface SystemDialog {
  packageName: string;
  title: string;
  buttons: string[];
}

// ---------------------------------------------------------------------------
// LLM-friendly tree serialization (compact, omits defaults)
// ---------------------------------------------------------------------------

export interface LlmTreeNode {
  id?: string;
  role: string;
  text?: string;
  desc?: string;
  /** Short class name (e.g. "ReactViewGroup") — included for unlabeled elements */
  cls?: string;
  bounds: string;
  /** Only included when element is tappable but has no id/text/desc */
  clickable?: true;
  enabled?: false;
  checked?: true;
  focused?: true;
  selected?: true;
  password?: true;
  /** Included when element is scrollable */
  scrollable?: true;
  actions?: string[];
  children?: LlmTreeNode[];
}
