# AgenTest

AI-driven mobile app testing via MCP. Any AI coding agent can test any Android app.

Your AI reads your code, generates test cases, and executes them against a real emulator -- no test framework, no boilerplate, no `testID`s required.

**Works with:** Claude Code, Cursor, Windsurf, Copilot, Kiro, Antigravity, and any MCP-compatible agent.

## How it works

```
Developer: "Test the login flow of my app"

AI agent:
  1. Connects to your emulator
  2. Reads the accessibility tree (compact, token-efficient)
  3. Generates test steps from your source code + UI
  4. Executes taps, types, swipes, assertions
  5. Reports exactly what broke -- down to the line of code
```

AgenTest is a **dumb execution engine** -- it reads UI trees and injects input via ADB. All intelligence lives in your AI agent.

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
| `agentest_connect` | Connect to emulator, launch app, return UI tree |
| `agentest_get_ui_tree` | Fresh UI snapshot (compact text with `@ref` tokens) |
| `agentest_run_flow` | Execute a batch of actions + assertions |
| `agentest_reset_app` | Force-stop and relaunch, return fresh tree |
| `agentest_screenshot` | Capture screen as base64 PNG |
| `agentest_get_logs` | Logcat output filtered to app PID |
| `agentest_device_info` | Screen size, density, Android version |
| `agentest_set_network` | Simulate network conditions (offline, 2g, 3g, lte) |
| `agentest_get_shared_prefs` | Inspect SharedPreferences (debug builds) |
| `agentest_query_db` | Query SQLite databases (debug builds) |

## Compact UI tree

AgenTest returns UI trees in a token-efficient compact format:

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

Each `@ref` token (`@b1`, `@f1`, etc.) is a stable selector the AI uses in subsequent actions:

```json
{ "action": "tap", "target": { "ref": "@b1" } }
{ "action": "type", "target": { "ref": "@f1" }, "value": "user@example.com" }
```

**No `testID`s needed.** For React Native apps built with Cursor/Bolt/v0/Lovable, AgenTest extracts React component names from the Hermes runtime and labels icon buttons automatically:

```
@b5 btn "Phone"          -- from React Fiber: <Phone /> component
@b6 btn "DotsVertical"   -- from React Fiber: <DotsVertical /> component
@b7 btn "Microphone"     -- from React Fiber: <Microphone /> component
```

## Framework support

| Framework | Support | How |
|-----------|---------|-----|
| **React Native** (debug) | Full | Hermes CDP for fiber labels + JS-idle sync |
| **React Native** (release) | Good | A11y tree + text hoisting (no fiber labels) |
| **Flutter** (debug) | Full | Dart VM Service for semantics + idle sync |
| **Flutter** (release) | Good | A11y tree only |
| **Native Android / Compose** | Good | A11y tree + text hoisting |

## iOS support (coming soon)

iOS simulator support is in active development -- same MCP tools, same compact tree format, same AI workflow. Android is fully supported today.

## Architecture

```
+------------------------------------------+
|         AI Agent (any MCP client)        |
+------------------------------------------+
                    |  MCP (stdio)
+------------------------------------------+
|              AgenTest Server             |
|   TypeScript -- reads trees, sends input |
+------------------------------------------+
       |              |              |
    gRPC           ADB          Helper APK
  (emulator     (physical      (on-device,
   input)       devices)      auto-installed)
```

- **Helper APK**: Auto-installed on first connect. Reads UI trees in ~80ms (vs ~1.5s with `uiautomator dump`). Zero user setup.
- **gRPC**: Direct emulator input injection (tap/swipe/key). Instant, no shell overhead.
- **ADB fallback**: Works on physical devices and when gRPC/helper unavailable.

## Performance

| Mode | Per-action latency |
|------|-------------------|
| Helper + gRPC (emulator) | ~150-400ms |
| Helper + ADB (physical device) | ~300-600ms |
| ADB only (fallback) | ~1.5-3s |

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
