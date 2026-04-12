# Usage Examples

Real-world examples of AgenTest MCP tool calls and responses.

The `agentest_connect` response includes several helper-driven fields when the on-device helper is reachable:

- **`helperInstalled: true`** — the helper APK is installed and serving. Tree dumps, idle waits, and (on physical devices) input injection all go through the in-process fast path.
- **`framework: "react_native" | "flutter" | "compose" | "native"`** — what UI toolkit the app is built with. Detected on first connect via a three-tier cascade: (1) helper's accessibility-tree class-name walk, (2) helper's `PackageManager.getApplicationInfo().nativeLibraryDir` scan for `libhermes`/`libreactnative`/`libflutter`, (3) Metro `/json/list` inspector-proxy probe as a backstop for RN apps where the first two signals fail. Use this to pick a selector strategy:
  - `react_native`: prefer `text` / `description` / `className` selectors. Resource IDs are usually empty unless the app sets `testID` on every view (rare). AgenTest automatically attaches Hermes CDP when Metro is running.
  - `flutter`: AgenTest auto-forces semantics via the Dart VM Service when the app is a debug/profile build — the a11y tree will be populated after connect. Prefer `text` selectors; Flutter apps post-3.19 surface `SemanticsProperties.identifier` as `resource-id`.
  - `compose`: prefer `text` selectors plus the new Compose extras (`hint`, `state`, `pane`, `tooltip`). For stable IDs the app needs `Modifier.semantics { testTagsAsResourceId = true }`.
  - `native`: classic XML view system — `id` selectors work as expected.
- **`frameworkSync: ("hermes" | "dart_vm" | "idling_bridge")[]`** (Phase 3.5-3.10) — which framework-aware sync channels are actively augmenting idle detection. Multiple can be attached at once. Empty/absent means the helper's accessibility-event idle (~150-300ms) is the only signal, which is fine for most apps.
- **`diagnostics?: string[]`** (optional) — only present when (a) framework detection was ambiguous, (b) a warning fired, or (c) you passed `verbose: true`. Each line is a single step of the attach pipeline with a `[framework]` / `[metro]` / `[hermes]` / `[dart-vm]` / `[idling-bridge]` / `[framework-sync]` channel tag, useful for debugging silent failures.
- **`warnings?: string[]`** (optional) — actionable messages the LLM should relay verbatim. Currently used to flag a stale idling-bridge AAR baked into the user's app after a `npm update agentest`, with a ready-to-paste `./gradlew :app:assembleDebug` rebuild command.

---

## Example 1: Testing a Login Flow

### Step 1: Connect

The AI calls `agentest_connect`:

```json
{
  "packageName": "com.example.myapp"
}
```

Response:

```json
{
  "deviceId": "emulator-5554",
  "packageName": "com.example.myapp",
  "backend": "grpc",
  "helperInstalled": true,
  "framework": "react_native",
  "frameworkSync": ["hermes"],
  "uiTree": {
    "role": "container",
    "bounds": "[0,0][1080,1920]",
    "children": [
      {
        "role": "toolbar",
        "bounds": "[0,48][1080,192]",
        "children": [
          { "role": "text_view", "text": "Login", "bounds": "[48,72][240,168]" }
        ]
      },
      {
        "role": "container",
        "bounds": "[0,192][1080,1920]",
        "children": [
          {
            "id": "com.example.myapp:id/email",
            "role": "text_field",
            "text": "Email",
            "bounds": "[48,240][1032,384]",
            "actions": ["tap", "type"]
          },
          {
            "id": "com.example.myapp:id/password",
            "role": "text_field",
            "bounds": "[48,408][1032,552]",
            "password": true,
            "actions": ["tap", "type"]
          },
          {
            "id": "com.example.myapp:id/login_button",
            "role": "button",
            "text": "Sign in",
            "bounds": "[48,576][1032,720]",
            "actions": ["tap"]
          }
        ]
      }
    ]
  }
}
```

### Step 2: Run Test — Valid Login

The AI sees the tree, identifies the fields, and generates a test flow:

```json
{
  "steps": [
    { "action": "tap", "target": { "id": "email" } },
    { "action": "type", "target": { "id": "email" }, "value": "user@test.com" },
    { "action": "tap", "target": { "id": "password" } },
    { "action": "type", "target": { "id": "password" }, "value": "SecurePass123!" },
    { "action": "tap", "target": { "id": "login_button" } },
    { "action": "wait", "timeoutMs": 3000 },
    { "action": "assert_not_visible", "target": { "text": "Sign in" } },
    { "action": "assert_visible", "target": { "textContains": "Welcome" } }
  ]
}
```

Response (success):

```json
{
  "success": true,
  "stepsCompleted": 8,
  "totalSteps": 8,
  "results": [
    { "stepIndex": 0, "action": { "action": "tap", "target": { "id": "email" } }, "success": true, "durationMs": 2100 },
    { "stepIndex": 1, "action": { "action": "type", "target": { "id": "email" }, "value": "user@test.com" }, "success": true, "durationMs": 1850 },
    { "stepIndex": 2, "action": { "action": "tap", "target": { "id": "password" } }, "success": true, "durationMs": 2050 },
    { "stepIndex": 3, "action": { "action": "type", "target": { "id": "password" }, "value": "SecurePass123!" }, "success": true, "durationMs": 1900 },
    { "stepIndex": 4, "action": { "action": "tap", "target": { "id": "login_button" } }, "success": true, "durationMs": 2200 },
    { "stepIndex": 5, "action": { "action": "wait", "timeoutMs": 3000 }, "success": true, "durationMs": 3005 },
    { "stepIndex": 6, "action": { "action": "assert_not_visible", "target": { "text": "Sign in" } }, "success": true, "durationMs": 680 },
    { "stepIndex": 7, "action": { "action": "assert_visible", "target": { "textContains": "Welcome" } }, "success": true, "durationMs": 650 }
  ],
  "finalUiTree": {
    "role": "container",
    "bounds": "[0,0][1080,1920]",
    "children": [
      {
        "role": "toolbar",
        "children": [
          { "role": "text_view", "text": "Home", "bounds": "[48,72][240,168]" }
        ]
      },
      {
        "id": "com.example.myapp:id/welcome_text",
        "role": "text_view",
        "text": "Welcome, user@test.com",
        "bounds": "[48,240][1032,300]"
      }
    ]
  }
}
```

### Step 3: Reset and Test — Invalid Login

```json
{
  "packageName": "com.example.myapp"
}
```

Then run flow with bad credentials:

```json
{
  "steps": [
    { "action": "type", "target": { "id": "email" }, "value": "wrong@test.com" },
    { "action": "type", "target": { "id": "password" }, "value": "bad" },
    { "action": "tap", "target": { "id": "login_button" } },
    { "action": "wait", "timeoutMs": 2000 },
    { "action": "assert_visible", "target": { "id": "error_message" } },
    { "action": "assert_text_contains", "target": { "id": "error_message" }, "value": "invalid" }
  ]
}
```

---

## Example 2: Testing Form Validation

The AI reads the source code and knows the validation rules. It generates targeted tests:

### Empty Email

```json
{
  "steps": [
    { "action": "tap", "target": { "id": "email" } },
    { "action": "tap", "target": { "id": "signup_button" } },
    { "action": "wait", "timeoutMs": 1000 },
    { "action": "assert_visible", "target": { "textContains": "required" } }
  ]
}
```

### Invalid Email Format

```json
{
  "steps": [
    { "action": "type", "target": { "id": "email" }, "value": "not-an-email" },
    { "action": "tap", "target": { "id": "signup_button" } },
    { "action": "wait", "timeoutMs": 1000 },
    { "action": "assert_visible", "target": { "textContains": "valid email" } }
  ]
}
```

### Password Too Short

```json
{
  "steps": [
    { "action": "type", "target": { "id": "email" }, "value": "user@test.com" },
    { "action": "type", "target": { "id": "password" }, "value": "ab" },
    { "action": "tap", "target": { "id": "signup_button" } },
    { "action": "wait", "timeoutMs": 1000 },
    { "action": "assert_visible", "target": { "textContains": "at least" } }
  ]
}
```

---

## Example 3: Testing Navigation

### Navigate Through Tabs

```json
{
  "steps": [
    { "action": "tap", "target": { "text": "Profile" } },
    { "action": "assert_visible", "target": { "id": "profile_screen" } },
    { "action": "tap", "target": { "text": "Settings" } },
    { "action": "assert_visible", "target": { "id": "settings_screen" } },
    { "action": "press_key", "keycode": "KEYCODE_BACK" },
    { "action": "assert_visible", "target": { "id": "profile_screen" } }
  ]
}
```

### Scroll to Find an Item

Currently, you need to combine swipe + assert in a manual loop. The AI handles this by generating multiple attempts:

```json
{
  "steps": [
    { "action": "swipe", "direction": "up", "target": { "id": "item_list" } },
    { "action": "swipe", "direction": "up", "target": { "id": "item_list" } },
    { "action": "swipe", "direction": "up", "target": { "id": "item_list" } },
    { "action": "assert_visible", "target": { "text": "Item #50" } }
  ]
}
```

If the assertion fails, the AI can call `agentest_get_ui_tree` to check the current state, then decide whether to swipe more or report the item as not found.

---

## Example 4: React Native / Flutter app with no test IDs (compact tree + @ref)

This is the common case for apps built with code-generation tools (Cursor, Bolt, v0, Lovable, etc.) — the developer never set `testID` on anything because they didn't write the components by hand. The connect response will show `framework: "react_native"` or `"flutter"`, and most elements in the tree have empty `id` fields.

**The preferred flow since Phase 3.5:** let the compact tree format + `@ref` tokens do the work. `agentest_connect` returns the UI as indented text with per-element ref tokens. `hoistClickableLabels` pulls inner text onto clickable wrappers, and (for RN debug builds) Phase 3.6's fiber correlation labels the icon buttons with their React component names.

### Step 1: Connect and read the compact tree

```json
// Response excerpt
{
  "uiTree": "screen 1440x2960 com.example.app #a1b2c3\n  \"Welcome\"\n  @f1 input \"you@example.com\"\n  @f2 input password\n  @b1 btn \"Sign in\"\n  \"or\"\n  @b2 btn \"Sign up\"",
  "screenFingerprint": "a1b2c3",
  "framework": "react_native",
  "frameworkSync": ["hermes"]
}
```

The header has screen size, package, and fingerprint. Every operable gets a `@ref` token. `@b` = button, `@f` = field, `@c` = check, `@l` = link, `@s` = scrollable, `@g` = generic. Each ref is unique within the snapshot.

### Step 2: Drive the flow with ref tokens

```json
{
  "steps": [
    { "action": "type", "target": { "ref": "@f1" }, "value": "user@test.com" },
    { "action": "type", "target": { "ref": "@f2" }, "value": "MyPassword123" },
    { "action": "tap", "target": { "ref": "@b1" } }
  ]
}
```

**Ref priority rule**: when `ref` is set in a selector, it short-circuits all other fields (id / text / className / etc. are ignored). If the ref is stale because the screen changed, you get a clear `ElementNotFoundError` telling you to call `agentest_get_ui_tree` for fresh refs — no automatic fallback.

### Icon buttons get labels too (Phase 3.6)

On a chat screen with no testIDs and only icon buttons:

```
screen 1440x2960 com.example.chatapp #f9e8d7
  @b1 btn "ArrowLeft"       ← Lucide component
  "Chat"
  @b2 btn "Phone"
  @b3 btn "DotsVertical"
  @g1 @ref scroll
    "Hey there!"
    "How are you?"
  @f1 input "Message..."
  @b4 btn "Plus"
  @b5 btn "Microphone"
```

Every icon button is labeled with its React component name (`ArrowLeft`, `Phone`, `DotsVertical`, `Plus`, `Microphone`) — extracted from Hermes via the fiber walker in Phase 3.6 and correlated with the a11y tree by bounds containment. Works for Lucide, Ionicons, react-native-vector-icons, and Expo Image without any target-app changes. Silent fallback to `@b1` / `@b2` / `@b3` unlabeled refs when Hermes is unavailable (release builds, no Metro running, etc.).

### Fallback selectors still work

Traditional selectors still work alongside refs — use them when you know an id/text and want to be explicit, or when refs would be stale:

```json
{
  "steps": [
    { "action": "tap", "target": { "text": "Sign Up" } },
    { "action": "tap", "target": { "description": "Menu" } },
    { "action": "tap", "target": { "className": "android.widget.Button", "textContains": "Submit" } }
  ]
}
```

All specified criteria must match (AND logic). This narrows down to a specific element when text alone is ambiguous.

---

## Example 5: React Native + Hermes CDP sync (Phase 3.5)

When you have a React Native app running in a dev build with Metro on port 8081, AgenTest automatically opens a CDP connection to Hermes via Metro's inspector proxy. The connect response then includes `"frameworkSync": ["hermes"]` and every `agentest_run_flow` step gets a JS-liveness tail probe after the helper's accessibility-event idle fires.

### Step 1: Connect with Metro running

```json
{
  "packageName": "com.example.chatapp"
}
```

Response (lean, no diagnostics — success path):

```json
{
  "deviceId": "emulator-5554",
  "packageName": "com.example.chatapp",
  "backend": "grpc",
  "helperInstalled": true,
  "framework": "react_native",
  "frameworkSync": ["hermes"],
  "uiTree": {
    "role": "container",
    "bounds": "[0,0][1280,2784]",
    "id": "com.example.chatapp:id/action_bar_root",
    "children": [/* ... */]
  }
}
```

`frameworkSync: ["hermes"]` confirms that:
1. Helper detection first returned `native` (RN Fabric flattens views, so no `ReactRootView` classes in the a11y tree, and on API 34+ `/proc/<pid>/maps` is SELinux-blocked from shell UID).
2. The Metro `/json/list` backstop fetched the debug target list, found two Hermes pages with `appId === "com.example.chatapp"`, and overrode the framework to `react_native`.
3. `FrameworkSync.attach()` then opened the CDP WebSocket to the first page, ran `Runtime.enable`, and is now alive in the session.

### Step 2: Run a flow and watch the per-step durations

```json
{
  "steps": [
    { "action": "tap", "target": { "textContains": "enter number here" } },
    { "action": "type", "target": { "textContains": "enter number here" }, "value": "9876543210" },
    { "action": "assert_visible", "target": { "text": "sign up" } }
  ]
}
```

Each heavy action (tap, swipe, double_tap, long_press) now composes **three** signals before returning:
- Helper's push-based `OnAccessibilityEventListener` quiet window (~150ms)
- Hermes CDP `Runtime.evaluate("Promise.resolve(1)")` round-trip (~20-80ms; proves the JS event loop is responsive)
- Loading-indicator visibility check

On the `com.example.chatapp` build this typically resolves in ~1.3-1.5s per heavy action on an API 36 emulator — 2-3× faster than the pre-Phase-3.5 polling path.

### What happens in release builds

Release RN builds disable the Hermes inspector, so Metro has no target for the app. The Metro probe returns `0 targets`, no override fires, and `frameworkSync` stays empty/absent in the response. **The helper's accessibility-event idle remains the authoritative signal** — tests still work, they just don't get the extra JS-loop assurance.

---

## Example 6: Debugging a silent attach failure with `verbose: true`

By default, the connect response omits the `diagnostics` array (saves ~300-500 tokens per call restating what `framework` + `frameworkSync` already encode). When something's wrong — Hermes can't attach, Metro isn't reachable, helper returned the wrong framework — pass `verbose: true` to get the full attach trace.

### Request

```json
{
  "packageName": "com.example.rnapp",
  "verbose": true
}
```

### Response (failure case: Metro was killed between app launch and connect)

```json
{
  "deviceId": "emulator-5554",
  "packageName": "com.example.rnapp",
  "backend": "grpc",
  "helperInstalled": true,
  "framework": "native",
  "diagnostics": [
    "[framework] helper detected primary=native signals=",
    "[metro] /json/list returned 0 target(s)",
    "[framework-sync] attach starting for package=com.example.rnapp framework=native",
    "[idling-bridge] not present (no AAR added to debugImplementation)",
    "[framework-sync] no framework-specific sync backend for framework=native"
  ],
  "uiTree": { /* ... */ }
}
```

The `[metro] /json/list returned 0 target(s)` line is the smoking gun — Metro isn't running, so the RN override didn't fire, so `framework` stayed `native`, so no sync backend was attached. Fix: start Metro with `npx react-native start` and reconnect.

### Response (failure case: Metro is up but Hermes WebSocket handshake fails)

```json
{
  "framework": "react_native",
  "diagnostics": [
    "[framework] helper detected primary=native signals=",
    "[metro] /json/list returned 1 target(s): page-1(appId=com.example.rnapp)",
    "[metro] override → framework=react_native (appId/description/title matched packageName \"com.example.rnapp\")",
    "[framework-sync] attach starting for package=com.example.rnapp framework=react_native",
    "[idling-bridge] not present (no AAR added to debugImplementation)",
    "[hermes] metro discovery returned 1 target(s): page-1(appId=com.example.rnapp)",
    "[hermes] picked target page-1 (Hermes React Native)",
    "[hermes] connect failed: WebSocket is not defined",
    "[hermes] attach returned undefined (see prior lines for cause)"
  ]
}
```

The `connect failed: WebSocket is not defined` line immediately points at the Node.js version — global `WebSocket` was added in Node 21, so Node 18-20 needs the `ws` package (which AgenTest bundles as of v0.1.x).

### Auto-surfacing anomalies

Even without `verbose: true`, diagnostics are automatically included when:
- `framework === undefined` (the cascade failed at every tier — helper detection, nativeLibraryDir scan, and Metro probe)
- A warning is present (stale idling bridge AAR, wire version mismatch, etc.)

So you only need `verbose: true` for the case where everything "succeeded" but something downstream still didn't work the way you expected.

---

## Example 7: Compose a11y extras — reading a Switch/TextField/Scaffold

Jetpack Compose encodes its semantic modifiers (`stateDescription`, `hintText`, `paneTitle`, `tooltipText`) into `AccessibilityNodeInfo` fields that traditional XML views rarely use. The on-device helper extracts them and the tree serializer surfaces them as `state`, `hint`, `pane`, `tooltip` in the LLM tree.

### Example tree fragment from a Compose settings screen

```json
{
  "role": "container",
  "bounds": "[0,0][1080,2400]",
  "pane": "Settings",
  "children": [
    {
      "role": "container",
      "text": "Dark mode",
      "bounds": "[48,240][1032,360]",
      "clickable": true,
      "state": "on",
      "tooltip": "Toggle dark theme",
      "actions": ["tap"]
    },
    {
      "role": "text_field",
      "bounds": "[48,480][1032,600]",
      "hint": "Email address",
      "actions": ["tap", "type"]
    },
    {
      "role": "container",
      "text": "Notifications",
      "bounds": "[48,720][1032,840]",
      "state": "unchecked",
      "clickable": true,
      "actions": ["tap"]
    }
  ]
}
```

### Why these fields matter

Before Phase 3.8, a Compose `Switch` with no `accessibilityLabel` would surface as an anonymous container with just `clickable: true` — the LLM couldn't tell "on" from "off" without a screenshot. Now the `state` field makes the current value explicit, and `text` gives the label.

### Selecting by Compose extras

Tests can't select on `state`/`hint`/`pane`/`tooltip` directly (the selector schema hasn't been extended to them), but the AI can still target these elements via:

```json
{
  "steps": [
    { "action": "tap", "target": { "text": "Dark mode" } },
    { "action": "assert_visible", "target": { "text": "Notifications" } }
  ]
}
```

The LLM reads the tree, identifies "the switch with state: on and text: Dark mode", and generates the tap against the `text` selector which does match. The `state` field is for comprehension, not targeting.

If you need stable, state-aware selectors in Compose, add `Modifier.semantics { testTagsAsResourceId = true }` high in your composable tree and use `Modifier.testTag("dark_mode_switch")`. Those tags will surface as `resource-id` in the a11y tree and work with the `id` selector.

---

## Example 8: Flutter app with automatic semantics enablement

Flutter apps render to an opaque GPU surface — without semantics enabled, the accessibility tree contains only `FlutterView` and nothing inside. Phase 3.7 fixes this automatically for debug/profile builds.

### Connect response

```json
{
  "deviceId": "emulator-5554",
  "packageName": "com.example.flutterapp",
  "backend": "grpc",
  "helperInstalled": true,
  "framework": "flutter",
  "frameworkSync": ["dart_vm"],
  "uiTree": {
    "role": "container",
    "bounds": "[0,0][1080,1920]",
    "children": [
      {
        "role": "button",
        "text": "Get Started",
        "bounds": "[48,1680][1032,1800]",
        "actions": ["tap"]
      }
    ]
  }
}
```

### What happened under the hood

1. Helper detected `framework: "flutter"` via `FlutterView` class name or `libflutter.so` in the native lib dir.
2. `FrameworkSync.attach()` scraped logcat for `The Dart VM service is listening on http://127.0.0.1:<port>/<authCode>/`, ran `adb forward`, and opened the VM Service WebSocket.
3. `ensureFlutterSemantics()` called the `ext.flutter.debugDumpSemanticsTreeInTraversalOrder` service extension — calling this extension has the side effect of building the semantics tree via `PipelineOwner.flushSemantics()`, so the a11y tree is now populated.
4. Subsequent `agentest_run_flow` calls see a real tree with `text`, `desc`, and `actions`.

### Release builds

Release Flutter builds strip the Dart VM Service. The logcat scrape returns no URL, `FrameworkSync.attach()` silently skips, `frameworkSync` is empty. If semantics weren't enabled manually (via `SemanticsBinding.instance.ensureSemantics()` in `main.dart`) the tree will be sparse. Flutter 3.19+ gives apps a `SemanticsProperties.identifier` that maps to `resource-id` on Android — encourage that in shipping code.

---

## Example 9: Opt-in IdlingResource bridge (Phase 3.10)

For apps with heavy background work that the accessibility tree doesn't reflect (network calls, coroutine dispatchers, offline sync queues), AgenTest ships an optional AAR that exposes Espresso's `IdlingRegistry` + any custom sources to the helper process.

### Adding the AAR to a React Native app

One line in `android/app/build.gradle`:

```groovy
dependencies {
    debugImplementation files("../../node_modules/agentest/android-helper/prebuilt/agentest-idling-bridge.aar")
}
```

Rebuild the debug APK, reinstall, reconnect. The connect response now includes:

```json
{
  "framework": "react_native",
  "frameworkSync": ["hermes", "idling_bridge"]
}
```

### What it does

The AAR registers a ContentProvider at `content://<your-app-package>.agentest.idling/state`. AgenTest's host-side `AdbClient.queryIdlingBridge()` polls this via `adb shell content query` between actions. When `idle_count > 0`, `waitForIdle()` keeps waiting until all registered resources report idle.

### Registering custom sources

If your app doesn't use Espresso but has its own async state you want to track:

```kotlin
// In any debug-only file (e.g. android/app/src/debug/java/.../DebugIdling.kt)
import com.agentest.bridge.AgenTestIdlingBridge

class NetworkIdling {
    @Volatile var inFlight = 0

    init {
        AgenTestIdlingBridge.register(object : AgenTestIdlingBridge.IdleSource {
            override val name = "NetworkIdling"
            override fun isIdleNow() = inFlight == 0
        })
    }
}
```

Then increment `inFlight` when requests start and decrement when they finish. AgenTest will automatically wait for pending requests to drain between actions, eliminating "tap, but the fetch hasn't completed yet" flakiness without any test-code changes.

### Stale-AAR warning

If you update AgenTest via `npm update agentest` but forget to rebuild your Android app, the AAR baked into your debug APK will be an older version than what AgenTest expects. The next `agentest_connect` response will include a `warnings` field with a ready-to-paste rebuild command:

```json
{
  "warnings": [
    "AgenTest idling bridge is out of date: the AAR baked into this app reports wire version 1, but AgenTest expects version 2. This usually means AgenTest was updated via `npm update agentest` but the Android app hasn't been rebuilt yet — Gradle caches AARs in the app's build cache. Rebuild the app with:\n\n    cd android && ./gradlew :app:assembleDebug\n\nthen reinstall and relaunch. Alternatively, in Android Studio use 'Build > Rebuild Project'. Until you rebuild, the idling bridge sync channel may report stale idle state or silently skip."
  ]
}
```

Warnings always surface in the response (regardless of the `verbose` flag) because they're actionable.

---

## Example 10: Typical AI Agent Session

Here is what a typical conversation looks like when a developer uses AgenTest through an AI coding agent:

**Developer:**
> I just built the signup screen. Test it — try valid registration, duplicate email, and weak password.

**AI agent's internal process:**
1. Reads the signup screen source code (components, validation logic, API calls)
2. Calls `agentest_connect` with the package name
   - On first connect ever: the helper APK auto-installs in the background (~5–8s, no user input)
   - Response includes `framework: "react_native"`, so the AI knows to use text/description selectors instead of resource-ids (RN Fabric rarely populates IDs)
   - Response also includes `frameworkSync: ["hermes"]` because Metro is running and AgenTest auto-attached the Hermes CDP sync channel — every action will now wait for the JS event loop to settle before firing the next one
3. Reads the UI tree to identify form fields and buttons using the returned semantic tree (text, desc, bounds, Compose extras when applicable)
4. Generates 3 test flows:
   - Valid registration: fill all fields correctly, submit, assert success
   - Duplicate email: use existing email, submit, assert error message
   - Weak password: use short password, submit, assert validation error
5. Calls `agentest_run_flow` for each test
   - Heavy actions (tap, swipe, long_press) take ~1.3-1.5s end-to-end on a typical API 36 emulator with Hermes CDP attached — helper push-based a11y-event idle (~150ms) plus the Hermes JS-liveness tail probe plus any loading-indicator wait. Lightweight actions (type, press_key, *_coordinates) skip idle polling and run in ~200-400ms.
   - If a tap triggers a navigation that erases the next step's target, the pre-validation gate fails fast with a "screen changed" error instead of wasting seconds searching a stale tree
6. Calls `agentest_reset_app` between tests
7. Analyzes results

**AI agent's response to developer:**

> Tested the signup screen with 3 scenarios:
> 
> 1. **Valid registration** - PASSED. Form submits, navigates to home screen.
> 2. **Duplicate email** - FAILED. The form submits successfully instead of showing an error. Looking at `src/api/auth.ts:45`, the `signup()` function doesn't check the API response status code — a 409 (conflict) is treated as success.
> 3. **Weak password** - PASSED. Shows "Password must be at least 8 characters" error.
> 
> The duplicate email bug is in `auth.ts` — you need to check `response.status` before navigating.

This is the product: The AI correlates runtime behavior with source code to give actionable debugging information. The whole 3-flow test runs in ~20-40 seconds end-to-end on a warm emulator with Hermes CDP attached — fast enough to use inside the dev loop instead of as a CI-only step. Add the opt-in idling bridge AAR (Example 9) for an additional ~10-20% speedup on apps with lots of background async work.
