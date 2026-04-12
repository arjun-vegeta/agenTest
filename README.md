# AgenTest

AI-driven mobile app testing via MCP. Any AI coding agent can test any Android app.

Your AI reads your code, generates test cases, and executes them against a real emulator -- no test framework, no boilerplate, no `testID`s required.

**Works with:** Claude Code, Cursor, Windsurf, Copilot, Kiro, Antigravity, and any MCP-compatible agent.

## How is AgenTest different from Appium or Maestro?

Appium and Maestro are excellent test frameworks. If you have a QA team writing and maintaining structured test suites, they're the right tools. AgenTest solves a different problem.

**AgenTest is for developers who don't write tests.** If you're building with Cursor, Bolt, v0, or Lovable -- shipping fast, iterating daily, no QA team -- you probably have zero test coverage. AgenTest lets your AI agent test your app with a single prompt. No test code, no YAML, no page objects.

### Where AgenTest shines

- **Zero setup overhead.** `npm install -g agentest` + 4 lines of JSON. No Java, no Selenium, no drivers.
- **No testIDs required.** Most AI-generated apps don't have `testID`s. AgenTest auto-generates `@ref` selectors and extracts React component names from the Hermes runtime -- icon buttons like `<Phone />` and `<Microphone />` just work.
- **No test maintenance.** The AI sees the current UI tree and adapts. No selectors to update, no flows to rewrite when the UI changes.
- **Source code awareness.** When a test fails, the AI reads your code to explain *why* -- not just which assertion broke.
- **Fast.** ~150-400ms per action with the on-device helper + gRPC, comparable to Maestro, faster than Appium.

### Where Appium and Maestro are better

- **Deterministic CI suites.** If you need the same test to run identically 1000 times, a hand-written Appium/Maestro test is more predictable than an AI-generated one.
- **Cross-platform parity.** Appium supports iOS, Android, web, and desktop today. Maestro supports iOS and Android. AgenTest is Android-only (iOS coming soon).
- **Team-scale test management.** Page object patterns, test reporting dashboards, parallelized test runs across device farms -- Appium's ecosystem is mature here.

### Bottom line

Use Appium or Maestro when you have dedicated QA and need deterministic, version-controlled test suites. Use AgenTest when you're a developer who wants AI-powered testing with zero boilerplate -- especially on apps built with code-generation tools where nothing has a `testID`.

## How it works

```
Developer: "Test the login flow of my app"

AI agent:
  1. Connects to your emulator via AgenTest
  2. Reads the UI tree (compact, token-efficient format)
  3. Generates test steps from your source code + UI
  4. Executes taps, types, swipes, gestures, assertions
  5. Reports exactly what broke -- down to the line of code
```

AgenTest handles the hard parts: reading accessibility trees, injecting input via gRPC/ADB/helper APK, syncing with React Native and Flutter frameworks, extracting component metadata from running apps, and detecting when the UI has settled. All test intelligence lives in your AI agent.

## Quick start

### 1. Install

```bash
npm install -g agentest
```

Or from source:

```bash
git clone https://github.com/arjun-vegeta/agenTest.git
cd agentest
npm install && npm run build
```

### 2. Prerequisites

- **Node.js** >= 18
- **Android SDK** installed (Android Studio or standalone SDK)
- **Android emulator** running (or physical device via USB)

AgenTest auto-discovers `adb` from standard SDK locations -- no PATH configuration needed. It checks `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk` (macOS), `~/Android/Sdk` (Linux), and `%LOCALAPPDATA%\Android\Sdk` (Windows).

Verify your emulator is running: `adb devices` should list at least one device.

### 3. Configure your AI agent

Add AgenTest as an MCP server. The config format depends on your agent:

**Claude Code** (`.claude/settings.json` or `.mcp.json`):
```json
{
  "mcpServers": {
    "agentest": {
      "command": "npx",
      "args": ["-y", "agentest"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "agentest": {
      "command": "npx",
      "args": ["-y", "agentest"]
    }
  }
}
```

**VS Code / Copilot** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "agentest": {
      "command": "npx",
      "args": ["-y", "agentest"]
    }
  }
}
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):
```json
{
  "mcpServers": {
    "agentest": {
      "command": "npx",
      "args": ["-y", "agentest"]
    }
  }
}
```

### 4. Use it

Tell your AI agent:

```
Test the login flow. Package name is com.example.myapp.
```

That's it. The AI handles the rest.

## Tools

AgenTest exposes 10 MCP tools:

| Tool | What it does |
|------|-------------|
| `agentest_connect` | Connect to emulator, launch app, auto-detect backends, return compact UI tree |
| `agentest_get_ui_tree` | Fresh UI snapshot (compact text with `@ref` tokens) |
| `agentest_run_flow` | Execute a batch of actions + assertions, stop on first failure |
| `agentest_reset_app` | Force-stop and relaunch, return fresh tree |
| `agentest_screenshot` | Capture screen as base64 PNG |
| `agentest_get_logs` | Logcat output filtered to app PID |
| `agentest_device_info` | Screen size, density, Android version, model |
| `agentest_set_network` | Simulate network conditions (offline, 2g, 3g, lte) |
| `agentest_get_shared_prefs` | Inspect SharedPreferences (debug builds) |
| `agentest_query_db` | Query SQLite databases (debug builds) |

### Supported actions in `agentest_run_flow`

| Category | Actions |
|----------|---------|
| **Tap** | `tap`, `tap_coordinates`, `double_tap`, `double_tap_coordinates`, `long_press`, `long_press_coordinates` |
| **Input** | `type`, `clear_text`, `press_key` |
| **Gestures** | `swipe`, `swipe_coordinates`, `pinch`, `rotate` |
| **Scroll** | `scroll_to` (scroll until target is visible) |
| **Wait** | `wait` (fixed delay), `wait_for_stable` (wait for UI to settle) |
| **Assert** | `assert_visible`, `assert_not_visible`, `assert_text_equals`, `assert_text_contains` |

## Compact UI tree

AgenTest returns UI trees in a token-efficient compact format with stable `@ref` selectors:

```
screen 1280x2856 com.example.myapp #a1b2c3
  @b1 btn "Sign in"
  @f1 input "Email"
  @f2 input "Password"
  @c1 check "Remember me"
  @b2 btn "Forgot password?"
  "Don't have an account?"
  @l1 link "Sign up"
```

**Ref types:** `@b` = button, `@f` = input field, `@c` = checkbox/switch, `@s` = scrollable, `@l` = link, `@g` = generic tappable.

The AI uses refs in subsequent actions:

```json
{ "action": "tap", "target": { "ref": "@b1" } }
{ "action": "type", "target": { "ref": "@f1" }, "value": "user@example.com" }
```

Traditional selectors (`id`, `text`, `textContains`, `className`, `description`) also work alongside refs.

### No testIDs needed

For React Native apps built with Cursor, Bolt, v0, or Lovable, AgenTest extracts React component names directly from the running Hermes runtime and labels icon buttons automatically:

```
@b5 btn "Phone"          -- from React Fiber: <Phone /> component
@b6 btn "DotsVertical"   -- from React Fiber: <DotsVertical /> component
@b7 btn "Microphone"     -- from React Fiber: <Microphone /> component
```

This means every icon button in a zero-testID app gets a usable label without any code changes to the target app.

## Framework support

| Framework | Support | How |
|-----------|---------|-----|
| **React Native** (debug) | Full | Hermes CDP for fiber labels + JS-idle sync |
| **React Native** (release) | Good | A11y tree + text hoisting (no fiber labels) |
| **Flutter** (debug) | Full | Dart VM Service for semantics + idle sync |
| **Flutter** (release) | Good | A11y tree only |
| **Native Android / Compose** | Good | A11y tree + text hoisting |

**Idle detection:** AgenTest auto-waits after every action. The helper APK detects UI stability via accessibility events (~150-300ms). For RN/Flutter debug builds, framework-specific sync probes (Hermes CDP JS-idle, Dart VM frame-idle) run as tail checks to catch async state changes the a11y layer doesn't see.

## iOS support (coming soon)

iOS simulator support is in active development -- same MCP tools, same compact tree format, same AI workflow. Android is fully supported today.

## Architecture

```
+------------------------------------------+
|         AI Agent (any MCP client)        |
+------------------------------------------+
                    |  MCP (stdio)
+------------------------------------------+
|           AgenTest Server (TS)           |
|  tree parsing, idle detection, fiber     |
|  extraction, framework sync, ref mgmt   |
+------------------------------------------+
       |              |              |
    gRPC           ADB          Helper APK
  (emulator     (universal     (on-device,
   gestures)    fallback)     auto-installed)
```

- **Helper APK** (~1.8 MB): Auto-installed on first connect. Reads UI trees in ~80ms via in-process UiAutomation (vs ~1.5s with `uiautomator dump`). Detects idle via accessibility events. Zero user setup.
- **gRPC**: Direct emulator input injection at 60 FPS (tap, swipe, long-press, pinch, rotate). Instant, no shell overhead. Emulator only.
- **ADB fallback**: Works everywhere -- physical devices, CI, and when gRPC/helper aren't available. Slower but always functional.
- **Framework sync**: Hermes CDP (React Native) and Dart VM Service (Flutter) for JS/Dart idle detection and React Fiber component extraction.

## Performance

| Mode | Per-action latency | When |
|------|-------------------|------|
| Helper + gRPC | ~150-400ms | Emulator (best case) |
| Helper + ADB | ~300-600ms | Physical device |
| ADB only | ~1.5-3s | Fallback when helper can't install |

## Optional: Idling Bridge

For apps with heavy background work (network requests, sync queues), add the opt-in idling bridge AAR to eliminate flakiness:

```kotlin
// android/app/build.gradle.kts
dependencies {
    debugImplementation(
        files("../../node_modules/agentest/android-helper/prebuilt/agentest-idling-bridge.aar")
    )
}
```

AgenTest auto-detects it on the next connect. See [docs/setup.md](docs/setup.md) for details.

## Troubleshooting

### `adb` not found

AgenTest auto-discovers `adb` from standard locations. If it still can't find it:

1. **Set `ANDROID_HOME`** in your shell profile:
   ```bash
   # macOS / Linux
   export ANDROID_HOME=~/Library/Android/sdk   # macOS
   export ANDROID_HOME=~/Android/Sdk           # Linux

   # Windows (PowerShell)
   $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
   ```

2. **Or pass PATH explicitly** in your MCP config:
   ```json
   {
     "mcpServers": {
       "agentest": {
         "command": "npx",
         "args": ["-y", "agentest"],
         "env": {
           "PATH": "/path/to/android/sdk/platform-tools:/usr/local/bin:/usr/bin:/bin"
         }
       }
     }
   }
   ```

### No devices found

- Make sure your emulator is fully booted (past the Android boot animation)
- Run `adb devices` manually -- you should see at least one `device` (not `offline` or `unauthorized`)
- Try `adb kill-server && adb start-server` to reset the connection

### Helper APK didn't install

If `agentest_connect` returns `"helperInstalled": false`, AgenTest falls back to the slower ADB path automatically. Everything still works, just ~3-5x slower tree reads. To fix:

- Check that the emulator has enough disk space
- Make sure the emulator is fully booted before connecting
- Try `adb uninstall com.agentest.helper.test && adb uninstall com.agentest.helper` then reconnect

### UI tree is empty

- The app may still be loading. Wait a moment and call `agentest_get_ui_tree` again
- Some screens (splash, OpenGL/SurfaceView) don't expose accessibility nodes
- Use `agentest_screenshot` as a fallback to see what's on screen

### Slow performance

AgenTest has three speed tiers:
1. **Helper + gRPC** (~150-400ms/action) -- best, emulator only
2. **Helper + ADB** (~300-600ms/action) -- physical devices
3. **ADB only** (~1.5-3s/action) -- fallback when helper can't install

If you're stuck on tier 3, check the helper install issue above.

## Documentation

- [Architecture](docs/architecture.md) -- system design, data flow
- [MCP Tools Reference](docs/mcp-tools.md) -- all tools, parameters, responses
- [Type System](docs/type-system.md) -- types, schemas, constants
- [Setup Guide](docs/setup.md) -- installation, configuration, troubleshooting
- [Examples](docs/examples.md) -- usage patterns, real-world flows

## Development

```bash
npm install          # install dependencies
npm run build        # compile TypeScript
npm run dev          # watch mode
npm test             # run tests (293 tests)
npm run typecheck    # type check
npm run lint         # lint
```

## License

MIT
