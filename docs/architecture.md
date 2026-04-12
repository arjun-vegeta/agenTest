# Architecture

## Design Philosophy

AgenTest is an MCP (Model Context Protocol) server that gives an AI agent the ability to interact with Android apps running on emulators or physical devices. The core principle is **"The AI is the brain, AgenTest is the fingers."**

The MCP server is intentionally a **dumb execution engine**. It does not generate test cases, interpret results, or contain any AI logic. All intelligence lives in the LLM that calls the tools. AgenTest only knows how to:

1. Read the accessibility tree (what's on screen)
2. Inject input events (tap, type, swipe)
3. Wait for the UI to settle
4. Report what happened

This separation means the MCP server stays small, predictable, and testable, while the LLM handles the creative work of deciding what to test and interpreting failures.

---

## System Diagram

```
                    ┌──────────────────────────────────┐
                    │         AI Agent (LLM)        │
                    │                                  │
                    │  1. Reads app source code         │
                    │  2. Generates test scenarios       │
                    │  3. Calls AgenTest MCP tools      │
                    │  4. Interprets results            │
                    │  5. Reports findings to developer │
                    └──────────────┬───────────────────┘
                                   │
                                   │ MCP Protocol (stdio, JSON-RPC 2.0)
                                   │
                    ┌──────────────▼───────────────────┐
                    │      AgenTest MCP Server          │
                    │          (server.ts)              │
                    │                                  │
                    │  ┌────────────────────────────┐  │
                    │  │    10 MCP Tools             │  │
                    │  └─────────────┬──────────────┘  │
                    │                │                  │
                    │  ┌─────────────▼──────────────┐  │
                    │  │      DeviceClient           │  │
                    │  │  (3-backend router)        │  │
                    │  │   helper > grpc > adb       │  │
                    │  └──┬──────────┬──────────┬───┘  │
                    │     │          │          │       │
                    │  ┌──▼──┐  ┌────▼────┐ ┌──▼─────┐ │
                    │  │Helper│ │  gRPC   │ │  ADB   │ │
                    │  │HTTP  │ │ Client  │ │ Client │ │
                    │  │Client│ └────┬────┘ └────┬───┘ │
                    │  └──┬───┘      │           │     │
                    │     │          │           │     │
                    │  ┌──┴──────────┴───────────┴───┐ │
                    │  │   Shell Executor (DI)        │ │
                    │  └─────────────┬───────────────┘ │
                    └────────────────┼─────────────────┘
                                     │
                ┌────────────────────┼────────────────────┐
                │                    │                    │
       fetch HTTP            child_process.exec    grpc-js (TLS+JWT)
                │                    │                    │
                ▼                    ▼                    ▼
         localhost:8765         adb binary           localhost:8554
       (forwarded to            (host)              (emulator gRPC
        device:8765)                                  host-side)
                │                    │                    │
                │                    ▼                    │
                │            ┌───────────────┐            │
                │            │  ADB (host)    │            │
                │            └───────┬───────┘            │
                │                    │                    │
                │             USB / TCP                   │
                │                    │                    │
                ▼                    ▼                    ▼
              ┌────────────────────────────────────────────┐
              │       Android Emulator / Device            │
              │                                            │
              │  ┌──────────────────────────────────────┐ │
              │  │  Helper APK process                    │ │
              │  │  (am instrument, shell UID)            │ │
              │  │   - NanoHTTPD on :8765                 │ │
              │  │   - TreeDumper (UiAutomation)         │ │
              │  │   - InputInjector (injectInputEvent)  │ │
              │  │   - IdleWaiter (event listener)       │ │
              │  │   - ScreenshotEncoder                 │ │
              │  │   - FrameworkDetector                  │ │
              │  └──────────────────────────────────────┘ │
              │                                            │
              │  ┌──────────────────────────────────────┐ │
              │  │  App Under Test                        │ │
              │  │   - View hierarchy                     │ │
              │  │   - Accessibility tree                 │ │
              │  └──────────────────────────────────────┘ │
              └────────────────────────────────────────────┘
```

---

## Layer Breakdown

### Layer 1: MCP Server (`server.ts`)

The entry point. Registers 10 tools with the MCP SDK and connects over stdio transport. Manages shared state (active device ID, active package name, active gRPC client). Delegates all work to the tool handlers.

**Key decisions:**
- Uses `McpServer` from `@modelcontextprotocol/sdk` with `StdioServerTransport`
- All tool inputs validated with Zod schemas before reaching handler code
- Errors are caught and returned as structured JSON, never as thrown exceptions that would crash the MCP connection
- State (active device, active package, gRPC client) persists between tool calls within a session
- `agentest_connect` accepts a `backend` parameter: `"auto"` (default, try gRPC then ADB), `"adb"`, `"grpc"`

### Layer 2: Tool Handlers (`tools/`)

Ten files, each exporting a single `handle*` function. These orchestrate the Android layer — they compose ADB/gRPC calls, tree parsing, idle detection, and input injection into higher-level operations. They contain no business logic of their own. All handlers accept an optional `GrpcEmulatorClient` and create a `DeviceClient` facade.

| Tool | Handler | Responsibility |
|------|---------|---------------|
| `agentest_connect` | `handleConnect` | Verify device → auto-detect gRPC → launch app → wait for idle → return tree + backend |
| `agentest_get_ui_tree` | `handleGetUiTree` | Single tree snapshot → serialize for LLM |
| `agentest_run_flow` | `handleRunFlow` | Loop over steps with pre-validation gate: detect screen changes between steps, stop on failure |
| `agentest_reset_app` | `handleResetApp` | Force-stop → relaunch → wait for idle → return tree |
| `agentest_get_logs` | `handleGetLogs` | Logcat capture filtered by app PID |
| `agentest_screenshot` | `handleScreenshot` | Screenshot via gRPC (emulator) or ADB screencap |
| `agentest_device_info` | `handleDeviceInfo` | Screen size, density, Android version, model |
| `agentest_get_shared_prefs` | `handleGetSharedPrefs` | Read SharedPreferences XML via `run-as cat` |
| `agentest_query_db` | `handleQueryDb` | SQL queries against app SQLite databases via `run-as sqlite3` |
| `agentest_set_network` | `handleSetNetwork` | Network condition simulation (speed/delay/wifi/airplane mode) |

### Layer 3: Android Layer (`android/`)

Sixteen files that encapsulate all Android-specific knowledge:

| File | Responsibility |
|------|---------------|
| `adb.ts` | Thin wrapper over ADB shell commands. Builds command strings from constants, executes via injected `ShellExecutor`. Includes app state inspection (run-as cat/sqlite3), network simulation (adb emu network, svc wifi/data), helper-lifecycle commands (install, uninstall, forward, am instrument), and the opt-in idling bridge query (`queryIdlingBridge`). |
| `device-client.ts` | `DeviceClient` facade: composes `AdbClient` + optional `GrpcEmulatorClient` + optional `HelperClient` + optional `FrameworkSync`. Three-backend router: tree/idle prefer helper, input prefers gRPC > helper > ADB on emulators. Per-method graceful fallback on failure. Exposes `sync` for the idle pipeline to tail-probe framework-specific channels. |
| `helper-client.ts` | HTTP client for the on-device helper APK. Methods: status, getTree, screenshot, waitForIdle, detectFramework, tap, swipe, longPress, key, typeText, shutdown. |
| `helper-installer.ts` | `ensureHelper()` — auto-install + launch the helper on first connect with zero user input. Locates prebuilt APKs (env var or relative path), checks installed versionCode, installs both APKs if missing/stale, sets up adb forward, spawns am instrument as a background child, polls /status. |
| `grpc-client.ts` | `GrpcEmulatorClient`: connects to emulator's gRPC port with JWT bearer token auth. Wraps sendTouch, sendKey, getScreenshot, clipboard RPCs. |
| `grpc-discovery.ts` | Auto-discovers emulator JWT token from `pid_*.ini` files in platform-specific temp dirs (macOS, Linux, Windows). |
| `grpc-touch.ts` | Pure gesture functions: tap, swipe (interpolated 60fps), long press, pinch (two-finger), rotate (two-finger). |
| `hermes-cdp.ts` | **Phase 3.5.** React Native sync backend. Discovers Metro's `/json/list` inspector targets, picks the one matching the package, opens the Hermes CDP WebSocket, enables `Runtime`, and implements `waitForHermesJsIdle` as a JS-event-loop idle probe. Debug builds only; every failure returns undefined silently. |
| `dart-vm-service.ts` | **Phase 3.6 / 3.7.** Flutter sync backend. Scrapes logcat for `The Dart VM service is listening on ...`, parses the URL, sets up `adb forward`, opens a JSON-RPC 2.0 WebSocket, and exposes `callExtension` (`ext.flutter.*`), `ensureFlutterSemantics`, and `waitForFlutterFrameIdle`. Debug+profile builds only. |
| `framework-sync.ts` | **Phase 3.9 / 3.6.** Orchestrator that composes Hermes CDP + Dart VM Service + idling bridge behind a single `FrameworkSync` object. `attach()` opens all applicable channels (non-fatal per-channel); `waitForSync()` runs them in sequence after the helper's a11y-event idle. Also exposes `snapshotFiberLabels()` — the Phase 3.6 one-shot fiber walker that extracts React component names for unlabeled icon buttons. Fingerprint-keyed cache. Gated on `AGENTEST_DISABLE_FRAMEWORK_SYNC=1` and `AGENTEST_DISABLE_FIBER_INFERENCE=1` for unit tests. |
| `fiber-extractor.ts` | **Phase 3.6.** React Fiber walker. Sends a synchronous JS blob to Hermes via CDP `Runtime.evaluate`, walks `__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots()`, collects `{tag, host, component, ancestors, props}` for every HostComponent fiber. `SKIP_NAMES` set walks past generic React ancestors (Svg, Path, View, Pressable, RCTView) to find the real icon component. Two-call pattern to work around Hermes's unreliable `awaitPromise`: walker kicks off `stateNode.measureInWindow` callbacks into `globalThis.__agentest_measures`, host waits 150ms, second call drains the bag. Debug builds only. |
| `fiber-merger.ts` | **Phase 3.6.** Fiber ↔ a11y correlation. `mergeFiberLabels` runs two-stage matching: **(A)** exact `testID` / `accessibilityLabel` prop match, **(B)** containment matching — a11y-first iteration, clickables sorted by area ascending, tightest-inside-wins. `calibrateOffset` auto-detects fiber↔a11y coordinate delta by voting on size-matching pairs (no hardcoded constants). `GENERIC_HOSTS` set ensures layout wrappers never win over meaningful components. Each fiber labels at most one a11y node so Camera / Photo / Microphone don't all inherit the same label. |
| `ref-registry.ts` | **Phase 3.5.** Session-scoped map from `@ref` tokens (`@b1`, `@f2`, …) to `UnifiedUINode` instances. `rebuild(tree)` walks once, assigns refs by kind (btn/field/check/link/scroll/generic), computes fingerprint, stores compact text; `resolve(ref)` is O(1) and throws `ElementNotFoundError` with a stale-ref recovery hint. Rebuilt on every tree snapshot. Lives in `server.ts` session state and is threaded through all 4 tool handlers. |
| `tree-parser.ts` | Parses `uiautomator dump` XML AND helper JSON into `UnifiedUINode` tree. LLM serialization with tree pruning (collapse single-child wrappers, skip invisible/system UI). Phase 3.5 `serializeTreeCompact` / `hoistClickableLabels` / `computeScreenFingerprint` / `computeIdleFingerprint`. Flexible className matching. Propagates Phase 3.8 Compose extras (hintText / stateDescription / paneTitle / tooltipText) end-to-end. |
| `input.ts` | Resolves element selectors to screen coordinates. Ref-aware: `@ref` selectors short-circuit via `RefRegistry` before falling back to legacy selector fields. Executes 20 action types including pinch and rotate. Checks assertions against the tree via `effectiveTextOf` which traverses text → description → hint → tooltip → descendant text for RN container nodes. |
| `idle.ts` | Two execution paths. **Fast (helper available):** event-driven via helper's `/wait-idle` endpoint, ~150-300ms — now followed by an optional `FrameworkSync.waitForSync()` tail probe when Hermes / Dart VM / idling bridge is attached. **Polling (no helper):** legacy fingerprint stability, ~600-2000ms. Both with visibility-checked loading indicator detection. |

### Layer 5: On-Device Helper APK (`android-helper/`, Phase 3)

A separate Gradle project that produces two prebuilt APKs committed to `android-helper/prebuilt/` and shipped inside the npm package, plus an opt-in idling bridge AAR users can add to their own debug builds:

- **Main APK** (`com.agentest.helper`, ~815 KB): contains the HTTP server source and all helper logic. No launcher activity, no service — exists purely as the target package for the test APK's instrumentation.
- **Test APK** (`com.agentest.helper.test`, ~952 KB): single JUnit `@Test` method (`HelperEntryPoint`) that's invoked by `androidx.test.runner.AndroidJUnitRunner`. It starts the embedded NanoHTTPD server bound to `127.0.0.1:8765` and blocks on a `CountDownLatch` for up to 24h.
- **Idling Bridge AAR** (`com.agentest.bridge`, Phase 3.10): opt-in library. Users add `debugImplementation` to expose a ContentProvider at `<app-package>.agentest.idling/state` that reports pending Espresso `IdlingResource`s and custom `IdleSource`s. The host-side `AdbClient.queryIdlingBridge` reads the provider via `adb shell content query` and `FrameworkSync` drains it between actions. Framework-agnostic — works for RN, Flutter, Compose, and native.

**Why two APKs?** Android requires instrumentation tests to live in a separate APK signed with the same key as the target package. This is the same pattern Appium's `appium-uiautomator2-server` uses. Launching via `am instrument -w -r com.agentest.helper.test/androidx.test.runner.AndroidJUnitRunner` gives the helper process the **shell UID**, which holds `INJECT_EVENTS` permission — the only way to call `UiAutomation.injectInputEvent` without a signature-level grant.

**Auto-install flow** (`ensureHelper` in `helper-installer.ts`, runs inside `agentest_connect`):

```
1. Check AGENTEST_DISABLE_HELPER env var — short-circuit return null
2. Locate prebuilt APKs (AGENTEST_HELPER_APK_DIR env, or repo-relative path)
3. adb shell pm list packages com.agentest.helper{,.test}
4. adb shell dumpsys package com.agentest.helper | grep versionCode
5. If versionCode missing/stale: adb uninstall + adb install -r -t (both APKs)
6. adb forward tcp:8765 tcp:8765
7. spawn('adb', 'shell', 'am', 'instrument', '-w', '-r',
        'com.agentest.helper.test/androidx.test.runner.AndroidJUnitRunner')
8. Poll http://127.0.0.1:8765/status every 250ms until { ok: true, protocolVersion: 1 }
9. Return HelperHandle { client, status, shutdown() }
```

Every failure mode (helper APK missing, install failed, port forward failed, instrumentation crashed, /status timeout) returns null silently with a single stderr log — the rest of the connect flow degrades to ADB+gRPC and the user never sees a hard error.

### Layer 4: ADB Discovery + Shell Executor (`adb-path.ts`, `shell.ts`)

**`adb-path.ts`** auto-discovers the `adb` binary from standard Android SDK locations (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk` on macOS, `~/Android/Sdk` on Linux, `%LOCALAPPDATA%\Android\Sdk` on Windows). The resolved path is cached for the session and used by both `AdbClient` (shell commands) and `spawnInstrumentation` (helper APK launch). Users never need to configure PATH manually.

**`shell.ts`** is the dependency injection boundary. All external process execution flows through the `ShellExecutor` interface. In production, `ProcessShellExecutor` calls `child_process.exec`. In tests, a mock executor returns canned responses.

```
ShellExecutor (interface)
├── ProcessShellExecutor (production — real adb calls)
└── MockShellExecutor (testing — fixture responses)
```

---

## Data Flow: Executing a Test Step

Here is the exact sequence when The AI calls `agentest_run_flow` with a `tap` step:

```
1. MCP SDK receives JSON-RPC call
2. Zod validates the input (steps array, element selectors)
3. handleRunFlow() is called with validated ActionStep[]

4. For each step:
   a. snapshotTree() → adb.dumpUiTree()
      → shell.exec("adb shell uiautomator dump /sdcard/window_dump.xml")
      → shell.exec("adb shell cat /sdcard/window_dump.xml")
      → parseUiAutomatorXml(xml) → UnifiedUINode tree

   b. executeAction(adb, tree, step, screenBounds)
      → resolveTarget(tree, step.target)
        → findElements(tree, selector) — depth-first search
        → returns first matching UnifiedUINode
      → adb.tap(element.center.x, element.center.y)
        → shell.exec("adb shell input tap 540 960")

   c. waitForIdle(adb)
      → loop:
        → dumpUiTree() → parseUiAutomatorXml() → computeFingerprint()
        → compare with previous fingerprint
        → if stable for 2 consecutive snapshots, return tree
        → if timeout, return last tree anyway

   d. Record StepResult { stepIndex, action, success, durationMs }

5. After all steps (or on first failure):
   → serializeTreeForLlm(currentTree) — compact JSON
   → Return FlowTrace { success, stepsCompleted, results, finalUiTree }

6. MCP SDK serializes result as JSON-RPC response
```

---

## Element Resolution Pipeline

When a step targets an element (e.g., `{ id: "email", className: "android.widget.EditText" }`), the resolution follows this pipeline:

```
ElementSelector
  │
  ▼
findElements(tree, selector)
  │  Depth-first traversal of UnifiedUINode tree
  │  Each node checked against ALL specified criteria (AND logic)
  │
  │  Matching rules:
  │  - id: substring match against resourceId
  │  - text: exact match
  │  - textContains: substring match
  │  - className: exact match
  │  - description: substring match against content description
  │
  ▼
Matching nodes (array)
  │
  │  If selector.index is set: pick the Nth match
  │  Otherwise: return all matches
  │
  ▼
resolveTarget() picks first match
  │
  │  If no matches → throw ElementNotFoundError
  │
  ▼
UnifiedUINode.center → { x, y } screen coordinates
  │
  ▼
adb.tap(x, y) → "adb shell input tap {x} {y}"
```

---

## Idle Detection Strategy

The idle detection system determines when the UI has finished updating after an action. This is the hardest problem in the system because Android apps may never fully "stabilize" — clocks tick, cursors blink, animations loop.

### Algorithm

```
1. Dump the UI tree
2. Compute a fingerprint of the tree
3. Compare with the previous fingerprint
4. If they match, increment stableCount
5. If stableCount >= 2 (configurable), UI is idle
6. If they differ, reset stableCount to 0
7. If timeout exceeded, return the last tree anyway
```

### Noise Filtering

The fingerprint intentionally ignores known-noisy properties:

| Property | Why it's noisy | Mitigation |
|----------|---------------|------------|
| `focused` state | Cursor blink on text fields | Excluded from fingerprint entirely |
| Timestamp-like text | Clock widgets, "Last updated" labels | Regex filter: `/^\d{1,2}:\d{2}(:\d{2})?(\s?(AM\|PM))?$/` |
| Bounds jitter | Sub-pixel rendering differences | Rounded to nearest 2px before comparison |

### Timing Budget

- Each batched `uiautomator dump` call (rm + dump + cat in single shell): ~500ms-1s
- Poll interval: 200ms
- Minimum time to declare idle: ~1-1.5s (dump + wait + dump + compare)
- Default timeout: 10s
- Loading indicator wait: up to 8s extra if spinners/shimmer detected
- **Lightweight actions** (type, press_key, clear_text, *_coordinates): single snapshot (~500ms), no polling
- **Heavy actions** (tap, swipe, long_press, double_tap): full idle + loading detection (~1-2s)

---

## Error Handling Strategy

Errors flow through three layers:

### 1. Custom Error Classes (`errors.ts`)

Every anticipated failure has a dedicated error class extending `AgenTestError`, each carrying an error code string:

| Error Class | Code | When |
|---|---|---|
| `AdbConnectionError` | `ADB_CONNECTION_ERROR` | No device connected, specified device not found |
| `AdbCommandError` | `ADB_COMMAND_ERROR` | ADB command returned unexpected output |
| `ElementNotFoundError` | `ELEMENT_NOT_FOUND` | Selector matched zero elements |
| `IdleTimeoutError` | `IDLE_TIMEOUT` | UI didn't stabilize within timeout |
| `AssertionFailedError` | `ASSERTION_FAILED` | Assertion condition not met |
| `AppNotInstalledError` | `APP_NOT_INSTALLED` | Target package not on device |
| `TreeParseError` | `TREE_PARSE_ERROR` | XML parsing failed or invalid structure |

### 2. Tool Handler Level

Each tool handler wraps its entire body in try/catch. Errors are never thrown to the MCP SDK — they're serialized as structured JSON in the tool response:

```json
{
  "error": "No element found matching selector: {\"id\":\"login_btn\"}",
  "code": "ELEMENT_NOT_FOUND"
}
```

### 3. Flow Execution Level

`run_flow` has special error handling: on any step failure, it captures the current UI tree (for debugging context), records the failure in the step results, and returns the full trace up to the failure point. The LLM receives enough context to diagnose what went wrong.

---

## Dependency Injection

The `ShellExecutor` interface is the single point where external I/O enters the system. Every class and function that needs to run shell commands receives a `ShellExecutor` instance, never imports `child_process` directly.

```typescript
interface ShellExecutor {
  exec(command: string, options?: ShellExecOptions): Promise<string>;
}

interface ShellExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
```

This enables:
- **Unit testing** with `MockShellExecutor` that returns pre-recorded ADB output
- **Integration testing** with a real `ProcessShellExecutor` against a live emulator
- **Future platform support** (iOS) by creating alternative executors or swapping the Android layer entirely

---

## Why No Screenshots

The entire system operates on the accessibility tree, not screenshots. This is a deliberate choice:

1. **Accessibility trees are structured data.** The LLM can reason about element types, labels, and relationships without vision capabilities.
2. **Trees are fast.** A `uiautomator dump` + parse takes ~500ms. A screenshot capture + base64 encoding + vision model analysis takes 2-5s.
3. **Trees enable precise interaction.** Element bounds give exact tap coordinates. Screenshots require coordinate inference.
4. **Trees work across frameworks.** React Native, Flutter, Compose, and native Android all produce accessibility trees. Screenshots look different for each.
5. **Trees support assertions natively.** "Is element X visible?" is a tree search. With screenshots, it requires OCR or vision.

The tradeoff: custom-drawn content (Canvas, OpenGL, games) has no accessibility nodes and is invisible to AgenTest. A screenshot fallback tool is planned for Phase 2.
