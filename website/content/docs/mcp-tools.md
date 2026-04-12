# MCP Tools API Reference

AgenTest exposes 10 MCP tools over stdio transport. All tools accept JSON input validated with Zod schemas and return JSON responses.

**Core (4):** `agentest_connect`, `agentest_get_ui_tree`, `agentest_run_flow`, `agentest_reset_app`
**Diagnostics (3):** `agentest_get_logs`, `agentest_screenshot`, `agentest_device_info`
**App state (2):** `agentest_get_shared_prefs`, `agentest_query_db`
**Environment (1):** `agentest_set_network`

---

## Compact Tree Format

`agentest_connect`, `agentest_get_ui_tree`, and `agentest_reset_app` return the UI as **compact text** by default — a dense, indented format optimized for token efficiency in zero-a11y apps (Bolt / v0 / Lovable / Cursor codegen output).

Example for a login screen:

```
screen 1080x1920 com.example.myapp #a1b2c3
  "Login"
  @f1 input "Email" focused
  @f2 input password
  @c1 check "Remember me"
  @b1 btn "Sign in"
  @l1 link "Forgot Password?"
```

**Format rules:**

- **Header:** `screen <width>x<height> <packageName> #<6-char fingerprint>`
- **Indent:** 2 spaces per level of post-collapse hierarchy
- **Ref tokens** (per-prefix counters, reset per snapshot):
  - `@b#` — buttons & image-buttons
  - `@f#` — text fields (EditText / TextInput / nodes with TYPE action)
  - `@c#` — checkables (CheckBox / Switch / RadioButton / ToggleButton)
  - `@l#` — links (clickable text views)
  - `@s#` — scrollables
  - `@g#` — generic clickables (anything else)
- **State tokens** appended after the (optional) quoted label: `focused`, `password`, `checked`, `selected`, `disabled`
- **Plain text nodes** appear quoted: `"Login"`
- **Wrapper containers** (no own label, not interactive) are collapsed transparently
- **Hoisting**: clickable containers without their own label inherit one from the first labeled descendant — this is what makes the format usable for RN/Flutter codegen apps where almost every operable is an unlabeled `RCTView` / `GestureDetector` wrapping a `Text` child
- **Fiber labels** (Phase 3.6, React Native debug builds only): unlabeled icon buttons get labels from React component names extracted via Hermes CDP. An unlabeled `<Pressable><ArrowLeft/></Pressable>` renders as `@b1 btn "ArrowLeft"` instead of a bare `@b1`. Works for Lucide / Ionicons / react-native-vector-icons without any target-app changes. Silent fallback to hoisting in release builds or when Hermes is unavailable.

**Token budget**: typical screen is 100-300 tokens vs. 1,500-5,000 tokens for the legacy JSON tree (5-17× reduction measured against fixtures).

### Using @ref selectors

The whole point of refs: target an element in `agentest_run_flow` without spelling out the selector:

```json
{ "action": "tap", "target": { "ref": "@b1" } }
```

**Ref priority rule**: when `ref` is set in a selector, it short-circuits all other fields (id/text/className/etc are ignored). If the ref is stale (the screen changed since the snapshot that produced it), you get a clear error telling you to call `agentest_get_ui_tree` for fresh refs. **No auto-fallback** — the LLM should re-snapshot rather than guess.

Traditional selectors still work alongside refs: `id`, `text`, `textContains`, `className`, `description`, `index`. Use refs when you've just snapshotted and have them; use traditional selectors when you know an id/text and want to be explicit.

### Screen fingerprints and `screenChanged`

Every snapshot carries a 6-char `screenFingerprint`. `agentest_run_flow` reports `screenChanged` (final fingerprint vs. initial) and **omits the `finalUiTree` when the screen didn't change AND the flow succeeded**. That's the dominant token win on multi-step flows: 6 type-into-field steps that stay on the same screen now return ~50 tokens instead of 6 × 2,500.

**The fingerprint deliberately ignores EditText text content** — typing into a field is an in-place mutation, not a screen change. The LLM verifies type success via `assert_text_equals` (which takes its own fresh snapshot) or via the final tree on `!success`.

---

## agentest_connect

Connect to an Android emulator or device and launch the target app. Returns the initial UI accessibility tree after the app has settled.

### Input

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `packageName` | `string` | Yes | Android package name (e.g., `"com.example.myapp"`) |
| `deviceId` | `string` | No | Specific device/emulator ID from `adb devices`. Omit to use the first connected device. |
| `backend` | `string` | No | Input backend: `"auto"` (default) tries gRPC then falls back to ADB; `"adb"` forces ADB only; `"grpc"` requires gRPC (emulator only, fails if unavailable). |
| `verbose` | `boolean` | No | Include a step-by-step `diagnostics` trace of framework detection + sync attach in the response. Off by default to keep token cost low; turn on when Hermes CDP / Dart VM / idling bridge unexpectedly fails to attach and you need to see which step broke. |

### Behavior

1. Runs `adb devices` to verify a device is connected
2. If `deviceId` is specified, confirms that specific device exists
3. If `backend` is `"auto"` or `"grpc"` and device is an emulator: discovers JWT token from `pid_*.ini`, connects gRPC to `localhost:{consolePort + 3000}`
4. **Auto-installs the on-device helper APK** if missing/stale (Phase 3) — silently runs `adb install`, sets up `adb forward`, spawns `am instrument`, polls `/status` until ready. Zero user input. On any failure, falls back to ADB+gRPC silently.
5. Launches the app using `adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1`
6. Waits for the UI to stabilize (helper push-event idle if helper installed; polling idle otherwise)
7. Detects what UI framework the app uses (when helper available) — React Native / Flutter / Compose / native
8. Returns the accessibility tree as compact JSON with active backend info

### Response

The response is split into two MCP content blocks: a JSON metadata block followed by the compact tree text block.

**Metadata block:**

```json
{
  "deviceId": "emulator-5554",
  "packageName": "com.example.myapp",
  "backend": "grpc",
  "helperInstalled": true,
  "framework": "react_native",
  "frameworkSync": ["hermes"],
  "screenFingerprint": "a1b2c3"
}
```

**Tree block** (compact format — see [Compact Tree Format](#compact-tree-format)):

```
screen 1080x1920 com.example.myapp #a1b2c3
  "Welcome"
  @f1 input "Email" focused
  @f2 input password
  @b1 btn "Sign in"
  @l1 link "Forgot Password?"
```

The new fields (`helperInstalled`, `framework`, `frameworkSync`, `screenFingerprint`) are present whenever the helper APK is reachable.

`framework` is one of `"react_native"`, `"flutter"`, `"compose"`, or
`"native"`. Use it to inform selector strategy — RN apps often have empty
resource-ids and need text/className selectors; Compose apps need
`Modifier.semantics { testTagsAsResourceId = true }` for stable ids;
Flutter apps auto-get semantics enabled by AgenTest now (see
`frameworkSync` below).

`frameworkSync` is an array of attached framework sync channels (Phase
3.5-3.10). Each entry tells you AgenTest is doing extra post-idle checks
against that channel:

- `"hermes"` — React Native debug build + Metro running. AgenTest talks
  to the Hermes CDP inspector via Metro's `/json/list` and waits for the
  JS event loop to drain after each action.
- `"dart_vm"` — Flutter debug/profile build. AgenTest scrapes the
  `The Dart VM service is listening on ...` URL out of logcat, connects
  to the Dart VM Service over WebSocket, forces semantics on via
  `ext.flutter.debugDumpSemanticsTreeInTraversalOrder` (so even apps
  without `ensureSemantics()` are visible), and probes
  `SchedulerBinding.transientCallbacks.isEmpty` for frame idle.
- `"idling_bridge"` — opt-in. If the user's app added the optional
  `agentest-idling-bridge` AAR to `debugImplementation`, AgenTest drains
  pending Espresso `IdlingResource`s + any custom `IdleSource`s via the
  provider at `content://<app>.agentest.idling/state` between actions.
  Framework-agnostic — works for RN, Flutter, Compose, and native.

An empty / absent `frameworkSync` is completely normal. It just means
AgenTest falls back to helper-only idle detection (still ~150-300ms via
accessibility events). No tests break, nothing is slower than baseline.

### When `diagnostics` appears in the response

By default the response does **not** include the `diagnostics` array —
it would be ~300-500 tokens of trace output on every successful connect,
re-stating information that `framework` and `frameworkSync` already tell
you. It's only included when:

1. **`verbose: true`** was passed on the connect call — for debugging.
2. **Framework couldn't be detected at all** (`framework === undefined`)
   — always worth explaining.
3. **Any `warnings` fired** (e.g., stale idling bridge AAR) — always
   worth explaining alongside the warning.

A typical `diagnostics` array, when present, looks like this:

```json
"diagnostics": [
  "[framework] helper detected primary=undefined signals=none",
  "[metro] /json/list returned 2 target(s): 8c0b...-1(appId=com.example.app), 8c0b...-2(appId=com.example.app)",
  "[metro] override → framework=react_native (appId/description/title matched packageName \"com.example.app\")",
  "[framework-sync] attach starting for package=com.example.app framework=react_native",
  "[idling-bridge] not present (no AAR added to debugImplementation)",
  "[hermes] metro discovery returned 2 target(s): ...",
  "[hermes] picked target 8c0b...-1 (com.example.app (sdk_gphone64_arm64))",
  "[hermes] connected and Runtime.enable acked"
]
```

Each line is prefixed with a channel tag: `[framework]`, `[metro]`,
`[hermes]`, `[dart-vm]`, `[idling-bridge]`, `[framework-sync]`,
`[fiber]`. The LLM can grep for these tags to understand where a sync
channel failed.

The `[fiber]` tag (Phase 3.6) reports React Fiber correlation stats on
every tree snapshot when the target is an RN debug build with Hermes
attached. A typical fiber line looks like:

```
[fiber] snapshot fingerprint=a1b2c3 density=2 offsetY=156 fibers=187→42 stageA=3 stageB=12 → 15 labels
```

Where `fibers=187→42` means 187 HostComponent fibers walked, 42 survived
after filtering out generic hosts and missing bounds. `stageA=3` means 3
nodes matched via exact `testID`/`accessibilityLabel` prop matching, and
`stageB=12` means 12 additional unlabeled clickables got labels from
bounds-containment matching against the fiber tree. Missing labels fall
through to Phase 3.5 hoisting.

### Errors

| Code | Condition |
|------|-----------|
| `ADB_CONNECTION_ERROR` | No devices connected, or specified device not found |
| `ADB_COMMAND_ERROR` | App has no launcher activity, or launch failed |
| `IDLE_TIMEOUT` | UI didn't stabilize within 10s (tree is still returned) |

---

## agentest_get_ui_tree

Get a fresh snapshot of the current UI. Does not wait for idle — returns the tree immediately. Returns compact text by default; pass `format: "full"` to get the legacy JSON tree (with bounds, classNames, etc.) for layout-dependent debugging.

### Input

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format` | `string` | No | `"compact"` (default — indented text with @ref tokens) or `"full"` (legacy JSON tree) |
| `depth` | `number` | No | Max tree depth. Subtrees deeper than this are summarized as `"... +N more interactive elements"` on the parent. |
| `onlyInteractive` | `boolean` | No | Drop plain text lines. Hoisted labels still appear on interactives, so the LLM can usually still drive the screen — useful on dense list screens. |

### Behavior

1. Runs `uiautomator dump` (or helper `/tree` when available) to capture the accessibility tree
2. Parses into a `UnifiedUINode` tree
3. Serializes to compact text (default) or legacy `LlmTreeNode` JSON (`format: "full"`)
4. Rebuilds the session ref registry — refs from the previous snapshot become stale

### Response (compact format)

A single text block containing the compact tree (see [Compact Tree Format](#compact-tree-format)). The LLM can read it directly and reference elements via `@ref` tokens.

### Response (`format: "full"`)

A JSON object matching the legacy `LlmTreeNode` shape, with `id`, `role`, `text`, `bounds`, `cls`, and `children`. Use this when you need raw bounds for spatial reasoning, or when the compact format prunes information you need (e.g., overlapping nodes, custom-drawn content layers).

### Errors

| Code | Condition |
|------|-----------|
| `ADB_COMMAND_ERROR` | uiautomator dump failed or returned invalid XML |
| `TREE_PARSE_ERROR` | XML structure is malformed |

---

## agentest_run_flow

Execute a batch of UI actions and assertions sequentially. This is the primary testing tool. Stops on first failure and returns a full execution trace.

### Input

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `steps` | `ActionStep[]` | Yes | Ordered list of actions and assertions (min 1) |

### Action Step Types

Each step is a discriminated union on the `action` field:

#### `tap` - Tap an element

```json
{ "action": "tap", "target": { "id": "login_button" } }
```

Resolves the target element, computes its center coordinates, sends `adb shell input tap x y`.

#### `type` - Type text into a field

```json
{ "action": "type", "target": { "id": "email_input" }, "value": "user@test.com" }
```

Taps the target field first (to focus it), then sends `adb shell input text`. Special characters and spaces are escaped automatically.

#### `swipe` - Swipe in a direction

```json
{
  "action": "swipe",
  "direction": "up",
  "target": { "id": "scroll_view" },
  "durationMs": 300
}
```

Computes swipe start/end coordinates within the target element's bounds (or screen center if no target). Direction is one of: `"up"`, `"down"`, `"left"`, `"right"`. Default duration: 300ms.

The swipe covers 60% of the element's dimension in the swipe direction.

#### `long_press` - Long press an element

```json
{ "action": "long_press", "target": { "id": "item" }, "durationMs": 1000 }
```

Implemented as a zero-distance swipe with duration. Default duration: 1000ms.

#### `press_key` - Send a keycode

```json
{ "action": "press_key", "keycode": "KEYCODE_BACK" }
```

Sends `adb shell input keyevent <keycode>`. Common keycodes:
- `KEYCODE_BACK` - Back button
- `KEYCODE_HOME` - Home button
- `KEYCODE_ENTER` - Enter/Return
- `KEYCODE_DEL` - Backspace
- `KEYCODE_TAB` - Tab
- `KEYCODE_ESCAPE` - Escape
- `KEYCODE_SPACE` - Space

#### `tap_coordinates` - Tap at exact pixel position

```json
{ "action": "tap_coordinates", "x": 1184, "y": 228 }
```

Taps at the given screen coordinates. Use for unlabeled icons (settings gear, close X) that have no `id`, `text`, or `description`. Get coordinates from element `bounds` in the UI tree.

#### `long_press_coordinates` - Long press at exact pixel position

```json
{ "action": "long_press_coordinates", "x": 540, "y": 960, "durationMs": 1000 }
```

#### `double_tap` - Double tap an element

```json
{ "action": "double_tap", "target": { "id": "image_view" } }
```

Two taps with 100ms interval. Used for zoom or text selection.

#### `double_tap_coordinates` - Double tap at exact pixel position

```json
{ "action": "double_tap_coordinates", "x": 540, "y": 960 }
```

#### `swipe_coordinates` - Swipe between exact points

```json
{ "action": "swipe_coordinates", "x1": 100, "y1": 800, "x2": 100, "y2": 200, "durationMs": 400 }
```

Swipe from (x1,y1) to (x2,y2). Use when elements aren't targetable by selector.

#### `clear_text` - Clear a text field

```json
{ "action": "clear_text", "target": { "id": "email_input" } }
```

Taps the field to focus, then sends delete key events to clear all content. Use before `type` when the field already has text.

#### `scroll_to` - Scroll until element appears

```json
{ "action": "scroll_to", "target": { "id": "item_50" }, "direction": "down", "maxScrolls": 10 }
```

Repeatedly scrolls in the given direction and checks if the target element becomes visible. Stops immediately when found. Fails after `maxScrolls` attempts. Default direction: `"down"`, default maxScrolls: 10.

#### `wait` - Pause execution (rarely needed)

```json
{ "action": "wait", "timeoutMs": 2000 }
```

Sleeps for the specified duration. **Rarely needed** — every action automatically waits for the UI to settle and loading indicators to disappear. Only use for async operations with no visible loading indicator.

#### `wait_for_stable` - Smart wait for UI stability

```json
{ "action": "wait_for_stable", "timeoutMs": 15000 }
```

Polls the UI tree until it stabilizes AND all loading indicators (spinners, progress bars, shimmer) disappear. **Rarely needed** — this behavior is built into every action.

#### `assert_visible` - Assert element exists

```json
{ "action": "assert_visible", "target": { "id": "home_screen" } }
```

Takes a fresh tree snapshot, searches for the element. Passes if found, fails if not.

#### `assert_not_visible` - Assert element is gone

```json
{ "action": "assert_not_visible", "target": { "text": "Error" } }
```

Passes if no element matches the selector.

#### `assert_text_equals` - Assert exact text

```json
{
  "action": "assert_text_equals",
  "target": { "id": "welcome_text" },
  "value": "Welcome, user@test.com"
}
```

Finds the element, compares its `text` property against `value`. Exact match required.

#### `assert_text_contains` - Assert text substring

```json
{
  "action": "assert_text_contains",
  "target": { "id": "welcome_text" },
  "value": "Welcome"
}
```

Finds the element, checks if its `text` property contains `value` as a substring.

### Element Selectors

Every action that targets an element uses an `ElementSelector` object. Use `ref` when you have a fresh snapshot — it's an O(1) lookup with no walking. Otherwise multiple fields can be combined (AND logic — all specified criteria must match):

| Field | Type | Match Logic | Example |
|-------|------|------------|---------|
| `ref` | `string` | **Direct lookup from the last snapshot's ref registry.** Takes priority over all other fields. | `"@b1"`, `"@f2"` |
| `id` | `string` | Substring match against `resource-id` | `"email"` matches `"com.app:id/email"` |
| `text` | `string` | Exact match against visible text | `"Sign in"` |
| `textContains` | `string` | Substring match against visible text | `"Sign"` |
| `className` | `string` | Exact match against Android class | `"android.widget.EditText"` |
| `description` | `string` | Substring match against content description | `"Login"` |
| `index` | `number` | Pick the Nth match (0-based) when multiple match | `0` |

**Priority recommendation:** Use `ref` when you've just snapshotted (`agentest_connect`, `agentest_get_ui_tree`, or a previous `agentest_run_flow`). Use `id` when you know a stable resource-id. Fall back to `text` or `textContains` when IDs aren't set. Use `className` + `index` as a last resort.

**Ref priority rule** (concern #5): when `ref` is set, all other fields are **ignored**. If the ref is stale (the screen changed since the snapshot), the call fails with an actionable error telling you to call `agentest_get_ui_tree` for fresh refs. There is **no automatic fallback** to other selector fields — re-snapshot to recover.

### Response: FlowTrace

```json
{
  "success": false,
  "stepsCompleted": 4,
  "totalSteps": 6,
  "results": [
    {
      "stepIndex": 0,
      "action": { "action": "tap", "target": { "ref": "@f1" } },
      "success": true,
      "durationMs": 2150
    },
    {
      "stepIndex": 1,
      "action": { "action": "type", "target": { "ref": "@f1" }, "value": "bad" },
      "success": true,
      "durationMs": 1830
    },
    {
      "stepIndex": 2,
      "action": { "action": "tap", "target": { "ref": "@f2" } },
      "success": true,
      "durationMs": 2040
    },
    {
      "stepIndex": 3,
      "action": { "action": "type", "target": { "ref": "@f2" }, "value": "x" },
      "success": true,
      "durationMs": 1920
    },
    {
      "stepIndex": 4,
      "action": { "action": "assert_visible", "target": { "id": "error_message" } },
      "success": false,
      "durationMs": 650,
      "error": "Element not found matching: {\"id\":\"error_message\"}"
    }
  ],
  "screenFingerprint": "a1b2c3",
  "screenChanged": false,
  "finalUiTree": "screen 1080x1920 com.example.myapp #a1b2c3\n  ...",
  "error": "Element not found matching: {\"id\":\"error_message\"}"
}
```

**Token-saving response when nothing changed**: if `success: true` AND `screenChanged: false`, the `finalUiTree` field is **omitted entirely**. The response becomes a handful of bytes — the LLM knows the UI is exactly where it left it, and reuses its prior refs without re-snapshotting:

```json
{
  "success": true,
  "stepsCompleted": 3,
  "totalSteps": 3,
  "results": [...],
  "screenFingerprint": "a1b2c3",
  "screenChanged": false
}
```

**Key behaviors:**
- Actions are executed sequentially
- **Heavy actions** (tap, swipe, long_press, double_tap) automatically wait for UI stability AND loading indicators (ProgressBar, shimmer, skeleton, "loading" text) to disappear before returning
- **Lightweight actions** (type, press_key, clear_text, *_coordinates) take a single tree snapshot — faster, no idle polling
- Assertions take a fresh tree snapshot before checking
- On first assertion failure: execution stops, remaining steps are skipped
- On action error (element not found, ADB failure): execution stops
- **App crash detection**: if the root package changes to a system package (crash dialog, launcher) after an action, the flow stops immediately with `appCrashDetected: true`
- **System dialog detection**: permission prompts and crash dialogs are detected and reported in `systemDialogs`
- The `finalUiTree` is always included — it represents the UI state at the point of failure (or at the end if all passed)
- `loadingDetected` in step results indicates if the server waited for a spinner to disappear
- Unicode and emoji text input is handled automatically via clipboard fallback

### Errors

| Code | Condition |
|------|-----------|
| `ELEMENT_NOT_FOUND` | Target element selector matched nothing |
| `ADB_COMMAND_ERROR` | ADB command failed during execution |
| `IDLE_TIMEOUT` | UI didn't stabilize after an action (tree is still captured) |
| `APP_CRASH` | App process died — root package changed to system package |

---

## agentest_reset_app

Force-stop and relaunch the app. Returns the fresh UI tree after relaunch. Use between test cases to get a clean state.

### Input

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `packageName` | `string` | No | Package name to reset. Defaults to the last connected app. |

### Behavior

1. Runs `adb shell am force-stop <package>`
2. Relaunches with `adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1`
3. Waits for UI to stabilize
4. Returns fresh accessibility tree

### Response

```json
{
  "packageName": "com.example.myapp",
  "uiTree": { "role": "container", "children": [ "..." ] }
}
```

### Errors

| Code | Condition |
|------|-----------|
| `ADB_COMMAND_ERROR` | Force-stop or relaunch failed |
| `IDLE_TIMEOUT` | UI didn't stabilize after relaunch |

---

## Tree Serialization Format

The UI tree returned by all tools uses a compact format optimized for LLM consumption. Only non-default fields are included:

| Field | Type | Included When |
|-------|------|--------------|
| `role` | `string` | Always |
| `bounds` | `string` | Always (format: `"[left,top][right,bottom]"`) |
| `id` | `string` | When `resource-id` is non-empty |
| `text` | `string` | When visible text is non-empty |
| `desc` | `string` | When content description is non-empty |
| `cls` | `string` | Short class name for unlabeled elements (e.g. `"ReactViewGroup"`) — usable directly in `className` selector |
| `hint` | `string` | **Phase 3.8.** `AccessibilityNodeInfo.hintText` (API 26+). Compose `TextField` placeholders etc. |
| `state` | `string` | **Phase 3.8.** `AccessibilityNodeInfo.stateDescription` (API 28+). Compose `Switch`/`Checkbox` state text like `"on"`, `"unchecked"`. |
| `pane` | `string` | **Phase 3.8.** `AccessibilityNodeInfo.paneTitle` (API 28+). Compose `Scaffold` / navigation pane titles. |
| `tooltip` | `string` | **Phase 3.8.** `AccessibilityNodeInfo.tooltipText` (API 28+). |
| `clickable` | `true` | Only for unlabeled tappable elements |
| `enabled` | `false` | Only when element is disabled (enabled=true is the default, omitted) |
| `checked` | `true` | Only when checked |
| `focused` | `true` | Only when focused |
| `selected` | `true` | Only when selected |
| `password` | `true` | Only for password fields |
| `scrollable` | `true` | Only for scrollable containers |
| `actions` | `string[]` | When element has available actions (`["tap", "type"]`) |
| `children` | `object[]` | When element has child nodes |

**Tree pruning:** The serialized tree is pruned for LLM consumption: single-child wrapper containers (no label, not clickable/scrollable) are collapsed; zero-size and off-screen elements are removed; system UI (`com.android.systemui`) is removed. The full tree is preserved internally for `findElements()` — pruning only affects the LLM output.

### Available Roles

`button`, `text_field`, `text_view`, `check_box`, `switch`, `radio_button`, `slider`, `scroll_view`, `image`, `image_button`, `container`, `list`, `list_item`, `tab`, `toolbar`, `progress_bar`, `spinner`, `web_view`, `unknown`

### Available Actions

`tap`, `long_press`, `type`, `scroll`, `check`, `adjust`

---

## agentest_get_shared_prefs

Read a SharedPreferences XML file from the app. Use to verify stored state (auth tokens, user info, settings) after test actions.

**Requires a debuggable build** — `run-as` fails on release builds.

### Input

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | `string` | Yes | SharedPreferences filename (with or without `.xml`) |
| `packageName` | `string` | No | Defaults to last connected app |

### Behavior

Runs `adb shell run-as <package> cat shared_prefs/<file>.xml` and returns the XML content as a string.

### Response

```json
{
  "packageName": "com.example.myapp",
  "file": "user_prefs.xml",
  "content": "<?xml version='1.0'...<map><string name='token'>abc123</string>...</map>"
}
```

### Errors

| Code | Condition |
|------|-----------|
| `ADB_COMMAND_ERROR` | App not debuggable, file not found, or `run-as` failed |

---

## agentest_query_db

Run a SQL query against an app's SQLite database (including Room). Use to verify DB state, debug data flow issues, or set up test fixtures.

**Requires a debuggable build.**

### Input

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `database` | `string` | Yes | Database filename (e.g. `"app.db"`) |
| `query` | `string` | Yes | SQL query (any valid SQL, but SELECT is recommended for read-only inspection) |
| `packageName` | `string` | No | Defaults to last connected app |

### Behavior

Runs `adb shell run-as <package> sqlite3 databases/<database> '<query>'` and returns the raw output. SQLite uses `|` as the column delimiter by default.

### Response

```json
{
  "packageName": "com.example.myapp",
  "database": "app.db",
  "query": "SELECT id, email FROM users LIMIT 5",
  "rows": "1|alice@test.com\n2|bob@test.com\n"
}
```

### Errors

| Code | Condition |
|------|-----------|
| `ADB_COMMAND_ERROR` | App not debuggable, database not found, or SQL syntax error |

---

## agentest_set_network

Simulate network conditions on the emulator for testing offline mode, slow connections, retry logic, and graceful degradation.

### Input

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `preset` | `string` | No | Speed preset: `"gsm"`, `"gprs"`, `"edge"`, `"umts"`, `"3g"`, `"hsdpa"`, `"lte"`, `"full"`, or `"offline"` (disables wifi + data) |
| `speed` | `string` | No | Custom speed as `"up:down"` kbps (e.g. `"500:2000"`) |
| `delay` | `string` | No | Latency: preset (`"none"`, `"gprs"`, `"edge"`, `"umts"`) or custom `"min:max"` ms |
| `wifi` | `boolean` | No | Enable/disable WiFi explicitly |
| `airplaneMode` | `boolean` | No | Enable/disable airplane mode |

Multiple parameters can be combined in a single call.

### Speed Preset Reference

| Preset | Up/Down |
|--------|---------|
| `gsm` | 14.4 / 14.4 kbps |
| `gprs` | 28.8 / 57.6 kbps |
| `edge` | 236.8 / 473.6 kbps |
| `umts` / `3g` | 384 / 384 kbps |
| `hsdpa` | 5.76 / 14.4 Mbps |
| `lte` | 58 / 173 Mbps |
| `full` | unlimited |

### Behavior

- Speed presets and custom speeds → `adb emu network speed <value>`
- Latency → `adb emu network delay <value>`
- WiFi toggle → `adb shell svc wifi enable/disable`
- Airplane mode → `adb shell cmd connectivity airplane-mode enable/disable`
- `preset: "offline"` → disables both WiFi and mobile data

### Response

```json
{
  "applied": { "preset": "3g", "delay": "umts" },
  "message": "Network speed preset: 3g; Latency: umts"
}
```

### Limitations

Cannot simulate specific HTTP errors (404, 500) or DNS failures — only bandwidth and latency. For HTTP-level simulation, use a proxy like mitmproxy or a mock server.

---

## Action Step Reference (run_flow)

In addition to the documented actions, two multi-touch gestures are available (gRPC backend only — emulator):

### `pinch` — Two-finger pinch (zoom)

```json
{
  "action": "pinch",
  "cx": 540,
  "cy": 960,
  "startRadius": 100,
  "endRadius": 300,
  "durationMs": 300
}
```

Two fingers move symmetrically along a horizontal line through `(cx, cy)`. `startRadius > endRadius` = pinch-in (zoom out); `startRadius < endRadius` = pinch-out (zoom in). Useful for maps, image viewers.

### `rotate` — Two-finger rotation

```json
{
  "action": "rotate",
  "cx": 540,
  "cy": 960,
  "radius": 200,
  "startAngleDeg": 0,
  "endAngleDeg": 90,
  "durationMs": 400
}
```

Two fingers rotate around `(cx, cy)` at a fixed radius. Angles in degrees (0 = right, 90 = down). Useful for image rotation, map orientation.

**Note:** Both gestures require the gRPC backend (emulator). They throw an error on physical devices since ADB cannot do multi-touch.
