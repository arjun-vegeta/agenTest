# Type System Reference

All types are defined in `src/types.ts`. Zod schemas provide runtime validation; TypeScript types are derived from them with `z.infer<>`.

---

## Core Interfaces

### ShellExecutor

The dependency injection boundary for all external process execution.

```typescript
interface ShellExecutor {
  exec(command: string, options?: ShellExecOptions): Promise<string>;
}

interface ShellExecOptions {
  timeoutMs?: number;    // Default: 30,000ms (TIMEOUTS.SHELL_COMMAND_MS)
  signal?: AbortSignal;  // For cancellation
}
```

**Implementations:**
- `ProcessShellExecutor` (production) — calls `child_process.exec`
- Mock implementations (testing) — return pre-recorded responses

---

### HelperClient (Phase 3)

HTTP client for the on-device helper APK. Talks to `http://127.0.0.1:8765`
(forwarded to the device's `8765` via `adb forward`).

```typescript
class HelperClient {
  constructor(hostPort: number, defaultTimeoutMs?: number);

  status(timeoutMs?: number): Promise<HelperStatus | null>;
  waitForReady(timeoutMs?: number, expectedProtocolVersion?: number): Promise<HelperStatus>;
  getTree(opts?: { compact?: boolean; packageName?: string }): Promise<HelperJson>;
  detectFramework(packageName?: string): Promise<HelperFrameworkInfo>;
  waitForIdle(opts?: { timeoutMs?: number; packageName?: string }): Promise<HelperIdleResult>;
  screenshot(): Promise<string>; // base64 PNG
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  longPress(x: number, y: number, durationMs: number): Promise<void>;
  key(keycode: number): Promise<void>;
  typeText(text: string): Promise<void>;
  shutdown(): Promise<void>;
}

interface HelperStatus {
  ok: boolean;
  name: string;
  version: string;
  protocolVersion: number;
  sdkInt: number;
  device: string;
  manufacturer: string;
}

interface HelperFrameworkInfo {
  ok: boolean;
  packageName: string;
  primary: 'flutter' | 'react_native' | 'compose' | 'native';
  frameworks: string[];   // e.g. ['react_native', 'react_native_hermes']
  signals: string[];      // detection evidence: 'class:...', 'lib:...'
}

interface HelperIdleResult {
  ok: boolean;
  idle: boolean;
  reason: string;         // 'events_quiet' | 'timeout'
  events: string[];       // accessibility event names recorded
}
```

### FrameworkSync (Phase 3.5 / 3.6 / 3.7 / 3.9 / 3.10)

Orchestrator that composes framework-specific sync backends behind a
single interface wired into `DeviceClient.sync`. `waitForIdle` in
`idle.ts` calls `FrameworkSync.waitForSync()` as a tail probe after the
helper's accessibility-event idle, so the helper's idle signal is
augmented by JS-side (Hermes), Dart-side (VM Service), and app-side
(Espresso idling bridge) checks whenever available. Also exposes
`snapshotFiberLabels()` — a one-shot React Fiber walker that extracts
component names (ArrowLeft, Settings, Camera, etc.) for unlabeled icon
buttons in RN codegen apps (Phase 3.6).

```typescript
interface FrameworkSyncInit {
  framework: 'flutter' | 'react_native' | 'compose' | 'native';
  packageName: string;
  adb: AdbClient;
}

class FrameworkSync {
  constructor(init: FrameworkSyncInit);

  /** The framework kind passed at construction. */
  get kind(): FrameworkKind;

  /** True iff any sync channel attached successfully. */
  get hasBackend(): boolean;
  /** True iff the Hermes CDP channel connected (RN debug + Metro running). */
  get hasHermes(): boolean;
  /** True iff the Dart VM Service channel connected (Flutter debug/profile). */
  get hasDartVm(): boolean;
  /** True iff the user's app declared the agentest-idling-bridge provider. */
  get hasIdlingBridge(): boolean;

  /**
   * In-band diagnostic trace surfaced through tool responses — one
   * human-readable line per channel event. Appended by each backend
   * during `attach()` + `waitForSync()` + `snapshotFiberLabels()`.
   * Tools slice out new lines after each call to return to the LLM.
   */
  get diagnostics(): string[];

  /** Open all applicable channels. Non-fatal per-channel; safe to call once. */
  attach(): Promise<void>;

  /** Tail probe after helper /wait-idle. Returns false only on channel timeout. */
  waitForSync(timeoutMs?: number): Promise<boolean>;

  /** Force Flutter semantics to build. Dart VM channel only. */
  refreshSemantics(): Promise<boolean>;

  /**
   * Extract React component names from the running Hermes JS runtime and
   * correlate them with `tree`'s accessibility nodes by bounds containment.
   * Returns a map of `nodeId → label` suitable for passing to
   * `serializeTreeCompact` as `externalLabels`. Cached by screen
   * fingerprint so multi-step flows don't re-extract on every snapshot.
   *
   * Silent no-op when framework !== 'react_native', Hermes is unattached,
   * or `AGENTEST_DISABLE_FIBER_INFERENCE=1`. Returns an empty map on
   * failure — callers fall through to Phase 3.5 hoisting.
   */
  snapshotFiberLabels(tree: UnifiedUINode): Promise<Map<string, string>>;

  /** Release all WebSockets. Safe to call multiple times. */
  close(): void;
}
```

Environment overrides:
- `AGENTEST_DISABLE_FRAMEWORK_SYNC=1` — short-circuits `attach()` so no
  sync backend is opened. Used by the unit tests to keep MockShellExecutor
  happy.
- `AGENTEST_DISABLE_FIBER_INFERENCE=1` — disables `snapshotFiberLabels()`
  even when Hermes is attached. Used by the unit tests to avoid any CDP
  traffic during `handleConnect` / `handleRunFlow` execution. Tools still
  return compact trees, just without fiber-derived labels.

### HelperHandle

Returned from `ensureHelper()` (auto-install entry point). Lifecycle owner
for the on-device helper process and its forwarded port.

```typescript
interface HelperHandle {
  client: HelperClient;
  status: HelperStatus;
  shutdown(uninstall?: boolean): Promise<void>;
}

function ensureHelper(
  shell: ShellExecutor,
  deviceId?: string,
  options?: { startupTimeoutMs?: number },
): Promise<HelperHandle | null>;
```

`ensureHelper` returns `null` (never throws) if any of these go wrong:
- `AGENTEST_DISABLE_HELPER=1` is set
- Prebuilt APKs not found in `android-helper/prebuilt/`
- `adb install` fails
- `adb forward` fails
- `am instrument` spawn fails
- Helper `/status` doesn't return ready within `startupTimeoutMs` (default 30s)

In all failure cases, the rest of the connect flow degrades to the ADB+gRPC
path with a single stderr log. The user never sees a hard error from helper
issues.

---

### Geometry Types

```typescript
interface Bounds {
  left: number;    // Pixels, screen-absolute
  top: number;
  right: number;
  bottom: number;
}

interface Point {
  x: number;  // Pixels, screen-absolute
  y: number;
}
```

Bounds are in **absolute screen pixels** as reported by Android's `AccessibilityNodeInfo.getBoundsInScreen()`. These are the raw values from the `bounds` attribute in `uiautomator dump` XML (format: `[left,top][right,bottom]`).

---

### UnifiedUINode

The core data structure representing a single UI element in the accessibility tree. Every node in the parsed tree is a `UnifiedUINode`.

```typescript
interface UnifiedUINode {
  // Identity
  id: string;              // Generated path-based ID (e.g., "0.1.3")
  resourceId: string;      // Android resource-id (e.g., "com.example:id/email")
  className: string;       // Raw Android class name
  role: UnifiedRole;       // Abstract mapped role
  text: string;            // Visible text content
  description: string;     // Content description (accessibility label)
  packageName: string;     // App package name
  
  // Geometry
  bounds: Bounds;          // Screen-absolute pixel bounds
  center: Point;           // Center point (computed from bounds)
  index: number;           // Sibling index (0-based)
  
  // State flags (from Android AccessibilityNodeInfo)
  enabled: boolean;
  focused: boolean;
  selected: boolean;
  checked: boolean;
  checkable: boolean;
  clickable: boolean;
  scrollable: boolean;
  longClickable: boolean;
  password: boolean;

  // Phase 3.8 Compose extras — empty string when absent
  hintText: string;         // AccessibilityNodeInfo.hintText (API 26+)
  stateDescription: string; // AccessibilityNodeInfo.stateDescription (API 28+)
  paneTitle: string;        // AccessibilityNodeInfo.paneTitle (API 28+)
  tooltipText: string;      // AccessibilityNodeInfo.tooltipText (API 28+)
  
  // Derived
  actions: UnifiedAction[];    // Available interactions
  children: UnifiedUINode[];   // Child nodes
}
```

**Phase 3.8 Compose extras** are populated by the on-device helper's
`TreeDumper.kt` when the running app is Jetpack Compose. They surface as
`hint`/`state`/`pane`/`tooltip` in the LLM tree (see `LlmTreeNode` below)
and are the primary way to read Compose semantics from out-of-process —
the unmerged tree is not reachable without in-app reflection. The `XML`
parsing path (`parseUiAutomatorXml`) always defaults them to empty strings
since `uiautomator dump` doesn't emit these fields.

**Field sources:**

| UnifiedUINode field | Android XML attribute | Notes |
|---|---|---|
| `id` | — | Generated: dot-separated index path (e.g., `"0.1.3"`) |
| `resourceId` | `resource-id` | Full ID: `"com.example.myapp:id/email"` |
| `className` | `class` | Full class: `"android.widget.EditText"` |
| `role` | `class` (mapped) | See [Role Mapping](#role-mapping) |
| `text` | `text` | Visible text content |
| `description` | `content-desc` | Accessibility label |
| `packageName` | `package` | App package |
| `bounds` | `bounds` | Parsed from `"[left,top][right,bottom]"` |
| `center` | `bounds` (computed) | `{ x: (left+right)/2, y: (top+bottom)/2 }` |
| `index` | `index` | Sibling position |
| `enabled` | `enabled` | `"true"` → `true` |
| `focused` | `focused` | `"true"` → `true` |
| `selected` | `selected` | `"true"` → `true` |
| `checked` | `checked` | `"true"` → `true` |
| `checkable` | `checkable` | `"true"` → `true` |
| `clickable` | `clickable` | `"true"` → `true` |
| `scrollable` | `scrollable` | `"true"` → `true` |
| `longClickable` | `long-clickable` | `"true"` → `true` |
| `password` | `password` | `"true"` → `true` |

---

### UnifiedRole

Abstract role mapped from Android class names. Defined as a const object with string literal values.

```typescript
const UNIFIED_ROLES = {
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

type UnifiedRole = (typeof UNIFIED_ROLES)[keyof typeof UNIFIED_ROLES];
```

### Role Mapping

| Android Class | Mapped Role |
|---|---|
| `android.widget.Button` | `button` |
| `android.widget.ImageButton` | `image_button` |
| `android.widget.EditText` | `text_field` |
| `android.widget.CheckBox` | `check_box` |
| `android.widget.Switch` | `switch` |
| `android.widget.ToggleButton` | `switch` |
| `android.widget.RadioButton` | `radio_button` |
| `android.widget.SeekBar` | `slider` |
| `android.widget.Spinner` | `spinner` |
| `android.widget.TextView` | `text_view` |
| `android.widget.ImageView` | `image` |
| `android.widget.ProgressBar` | `progress_bar` |
| `android.widget.ScrollView` | `scroll_view` |
| `android.widget.HorizontalScrollView` | `scroll_view` |
| `android.widget.ListView` | `list` |
| `androidx.recyclerview.widget.RecyclerView` | `list` |
| `android.webkit.WebView` | `web_view` |
| `android.widget.TabWidget` | `tab` |
| `android.widget.Toolbar` | `toolbar` |
| `androidx.appcompat.widget.Toolbar` | `toolbar` |
| Any class containing `Layout`, `ViewGroup`, `CardView`, `ComposeView`, `ReactViewGroup` | `container` |
| Anything else | `unknown` |

---

### UnifiedAction

Available interaction types, derived from the node's state flags.

```typescript
const UNIFIED_ACTIONS = {
  TAP: 'tap',
  LONG_PRESS: 'long_press',
  TYPE: 'type',
  SCROLL: 'scroll',
  CHECK: 'check',
  ADJUST: 'adjust',
} as const;
```

**Derivation rules:**

| Condition | Action |
|---|---|
| `clickable === "true"` | `tap` |
| `long-clickable === "true"` | `long_press` |
| `scrollable === "true"` | `scroll` |
| `checkable === "true"` | `check` |
| `class === "android.widget.EditText"` | `type` |
| `class === "android.widget.SeekBar"` | `adjust` |

---

## Zod Schemas

### ElementSelectorSchema

```typescript
const ElementSelectorSchema = z.object({
  /**
   * Short ref token from the last tree snapshot (e.g. "@b1", "@f2").
   * When set, ref takes priority over all other fields — they are ignored.
   * If the ref is stale, throws ElementNotFoundError with an actionable
   * message telling the LLM to call agentest_get_ui_tree for fresh refs.
   * No automatic fallback to other selector fields.
   */
  ref: z.string().optional(),
  id: z.string().optional(),
  text: z.string().optional(),
  textContains: z.string().optional(),
  className: z.string().optional(),
  description: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
});

type ElementSelector = z.infer<typeof ElementSelectorSchema>;
```

### ActionStepSchema

A discriminated union on the `action` field with 20 variants:

| Action | Required Fields | Optional Fields | Idle |
|---|---|---|---|
| `tap` | `target` | — | Full |
| `tap_coordinates` | `x`, `y` | — | Lightweight |
| `type` | `target`, `value` | — | Lightweight |
| `clear_text` | `target` | — | Lightweight |
| `swipe` | `direction` | `target`, `durationMs` | Full |
| `swipe_coordinates` | `x1`, `y1`, `x2`, `y2` | `durationMs` | Lightweight |
| `long_press` | `target` | `durationMs` | Full |
| `long_press_coordinates` | `x`, `y` | `durationMs` | Lightweight |
| `double_tap` | `target` | — | Full |
| `double_tap_coordinates` | `x`, `y` | — | Lightweight |
| `press_key` | `keycode` | — | Lightweight |
| `pinch` | `cx`, `cy`, `startRadius`, `endRadius` | `durationMs` | Full (gRPC only) |
| `rotate` | `cx`, `cy`, `radius`, `startAngleDeg`, `endAngleDeg` | `durationMs` | Full (gRPC only) |
| `scroll_to` | `target` | `scrollTarget`, `direction`, `maxScrolls` | Internal |
| `wait` | `timeoutMs` | — | Snapshot |
| `wait_for_stable` | — | `timeoutMs` | Full+Loading |
| `assert_visible` | `target` | — | Snapshot |
| `assert_not_visible` | `target` | — | Snapshot |
| `assert_text_equals` | `target`, `value` | — | Snapshot |
| `assert_text_contains` | `target`, `value` | — | Snapshot |

**Idle column**: Full = full idle detection with loading indicator awareness. Lightweight = single snapshot only (faster). Internal = handles its own polling. Snapshot = reads tree once.

---

## Result Types

### StepResult

```typescript
interface StepResult {
  stepIndex: number;       // 0-based position in the steps array
  action: ActionStep;      // The step that was executed
  success: boolean;        // Whether the step passed
  durationMs: number;      // Wall-clock time for this step
  error?: string;          // Human-readable error (only on failure)
  loadingDetected?: string; // Description of loading indicators waited out (if any)
}
```

### FlowTrace

```typescript
interface FlowTrace {
  success: boolean;            // true if ALL steps passed
  stepsCompleted: number;      // Number of steps executed (may be < totalSteps on failure)
  totalSteps: number;          // Total steps in the flow
  results: StepResult[];       // Per-step results
  /** 6-char screen fingerprint (always present). */
  screenFingerprint: string;
  /**
   * True when the screen meaningfully changed during the flow. False when
   * the UI is exactly where you started — typing into a field does NOT
   * flip this flag (in-place mutation, not a screen change).
   */
  screenChanged: boolean;
  /**
   * Compact text snapshot at the end (or at point of failure). **Omitted
   * entirely** when screenChanged is false AND success is true — when
   * nothing changed and everything passed, there's nothing new to report
   * and the tree would just burn tokens.
   */
  finalUiTree?: string;
  error?: string;              // Top-level error message (only on failure)
  systemDialogs?: SystemDialog[]; // Permission prompts, crash dialogs detected during flow
  appCrashDetected?: boolean;  // True if the app process died (root package changed to system)
}
```

### RefRegistry (compact text format)

Session-scoped map from short ref tokens (`@b1`, `@f2`, …) to UnifiedUINode instances. Rebuilt on every tree snapshot so refs always point at the live tree. Lives in `src/android/ref-registry.ts`.

```typescript
class RefRegistry {
  /**
   * Walk a fresh tree, assign refs, compute fingerprint, and cache the
   * compact text result. Call this every time the tree changes.
   */
  rebuild(tree: UnifiedUINode, opts?: CompactSerializeOptions): CompactSerializeResult;

  /**
   * O(1) lookup. Throws ElementNotFoundError with stale-ref message if the
   * ref doesn't exist — tells the LLM to call agentest_get_ui_tree.
   * No automatic fallback to other selector fields.
   */
  resolve(ref: string): UnifiedUINode;

  get fingerprint(): string;  // 6-char hash from last rebuild
  get text(): string;         // compact text from last rebuild
  get size(): number;         // total refs in current map
  clear(): void;              // drop all state (called on connect)
}

interface CompactSerializeOptions {
  /** Hard cap on emitted lines. Defaults to 200. */
  maxLines?: number;
  /** Max indent depth. 0 = unlimited (default). */
  maxDepth?: number;
  /** Drop plain text lines. Defaults to false. */
  onlyInteractive?: boolean;
  /**
   * External labels keyed by node id — fiber-derived component names
   * from `FrameworkSync.snapshotFiberLabels()` (Phase 3.6). When a node
   * has an external label, the serializer prefers it over hoisted labels
   * over own labels. Makes unlabeled icon buttons in RN codegen apps
   * resolvable by the LLM without any target-app code changes.
   */
  externalLabels?: Map<string, string>;
}

interface CompactSerializeResult {
  text: string;                            // indented text representation
  fingerprint: string;                     // 6-char screen fingerprint
  refMap: Map<string, UnifiedUINode>;      // @ref → node
  refCount: number;                        // total refs assigned
  lineCount: number;                       // lines emitted
  truncated: boolean;                      // true if maxLines kicked in
}
```

The compact text format is documented in [docs/mcp-tools.md#compact-tree-format](mcp-tools.md#compact-tree-format).

### Tree Fingerprints

Two fingerprint functions, exposed from `src/android/tree-parser.ts`:

```typescript
/**
 * Idle fingerprint: stable across cursor blink + bounds jitter + live
 * timestamps. Used by idle.ts. Includes EditText text content because
 * typing IS a UI change for idle detection purposes.
 */
function computeIdleFingerprint(node: UnifiedUINode): string;

/**
 * Screen fingerprint: 6-char hash. Used by run_flow's screenChanged gate.
 * Critical: EXCLUDES EditText text content — typing should not flip the
 * fingerprint (concern #1 from the design review). The LLM verifies type
 * success via assertions or the final tree on !success.
 */
function computeScreenFingerprint(node: UnifiedUINode): string;
```

### LlmTreeNode

Compact serialization of `UnifiedUINode` for LLM consumption. Omits default values to minimize token usage.

```typescript
interface LlmTreeNode {
  id?: string;          // Only when resource-id is non-empty
  role: string;         // Always present
  text?: string;        // Only when non-empty
  desc?: string;        // Only when content description is non-empty
  cls?: string;         // Short class name for unlabeled elements (e.g. "ReactViewGroup")
  hint?: string;        // Phase 3.8 — hintText (API 26+). Compose TextField placeholder etc.
  state?: string;       // Phase 3.8 — stateDescription (API 28+). Compose Switch state etc.
  pane?: string;        // Phase 3.8 — paneTitle (API 28+). Compose Scaffold / navigation panes.
  tooltip?: string;     // Phase 3.8 — tooltipText (API 28+).
  bounds: string;       // Always present, format: "[left,top][right,bottom]"
  clickable?: true;     // Only for unlabeled tappable elements
  enabled?: false;      // Only when disabled (enabled is the default)
  checked?: true;       // Only when checked
  focused?: true;       // Only when focused
  selected?: true;      // Only when selected
  password?: true;      // Only for password fields
  scrollable?: true;    // Only for scrollable containers
  actions?: string[];   // Only when actions are available
  children?: LlmTreeNode[];  // Only when children exist
}
```

**Tree pruning:** The serialized tree is pruned for LLM consumption:
- Single-child wrapper containers (no label, not clickable/scrollable) are collapsed — their child replaces them
- Zero-size and off-screen elements are removed
- System UI (`com.android.systemui`) nodes are removed
- The full tree is preserved internally for `findElements()` — pruning only affects the LLM output

---

## Constants (`constants.ts`)

All magic values are centralized in named constant objects:

| Constant | Purpose |
|---|---|
| `TOOL_NAMES`, `TOOL_NAMES_EXT` | MCP tool name strings (10 tools) |
| `SERVER_NAME`, `SERVER_VERSION` | MCP server identity |
| `ADB`, `ADB_COMMANDS`, `ADB_COMMANDS_EXT`, `MONKEY_FLAGS` | ADB command fragments incl. run-as, sqlite3, svc wifi/data, emu network |
| `ANDROID_CLASSES` | Android widget fully-qualified class names |
| `ANDROID_PROPS` | Device property keys (SDK version, model, etc.) |
| `TIMEOUTS` | All timeout/interval values incl. `KEYBOARD_SETTLE_MS`, `PINCH_DURATION_MS`, `ROTATE_DURATION_MS` |
| `BOUNDS_REGEX` | Regex for parsing `[left,top][right,bottom]` |
| `DIFF_THRESHOLDS` | Noise filtering thresholds |
| `KEYCODES`, `KEYCODE_TO_W3C` | Android keycodes + W3C key string mapping for gRPC sendKey |
| `SWIPE_OFFSETS` | Swipe distance calculation constants |
| `DOUBLE_TAP` | Double tap interval (100ms) |
| `CLEAR_TEXT` | Clear text key sequence constants |
| `RETRY` | ADB retry config (3 attempts, exponential backoff) |
| `SCROLL_TO` | Scroll-to-find defaults (10 max scrolls, 300ms settle) |
| `LOADING_INDICATORS` | Class names, text/desc patterns for spinner/shimmer detection |
| `IDLE_LOADING` | Loading wait config (8s max, 500ms poll) |
| `LIGHTWEIGHT_ACTIONS` | Actions that skip full idle polling |
| `SYSTEM_PACKAGES` | System package names for dialog/crash detection |
| `LOGCAT` | Max logcat lines (200) |
| `GRPC` | gRPC config (port offset 3000, timeouts, swipe FPS, finger pressure) |
| `NETWORK_SPEED_PRESETS`, `NETWORK_DELAY_PRESETS` | Valid presets for `agentest_set_network` |

---

## Error Classes (`errors.ts`)

All errors extend `AgenTestError`, which extends `Error` and adds a `code: string` property.

| Class | Code | Extra Properties |
|---|---|---|
| `AgenTestError` | (base) | `code: string` |
| `AdbConnectionError` | `ADB_CONNECTION_ERROR` | — |
| `AdbCommandError` | `ADB_COMMAND_ERROR` | `command: string` |
| `ElementNotFoundError` | `ELEMENT_NOT_FOUND` | `selector: Record<string, unknown>` |
| `IdleTimeoutError` | `IDLE_TIMEOUT` | — |
| `AssertionFailedError` | `ASSERTION_FAILED` | `expected: string`, `actual: string` |
| `AppNotInstalledError` | `APP_NOT_INSTALLED` | — |
| `TreeParseError` | `TREE_PARSE_ERROR` | — |
| `GrpcConnectionError` | `GRPC_CONNECTION_ERROR` | — |
| `GrpcRpcError` | `GRPC_RPC_ERROR` | `rpcMethod: string` |
