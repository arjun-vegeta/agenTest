# Setup Guide

## Prerequisites

- **Node.js** >= 18.0.0
- **Android SDK** installed (Android Studio or standalone SDK)
- **Android Emulator** running or a physical device connected via USB/Wi-Fi
- **An MCP-compatible AI coding agent** (Claude Code, Cursor, Windsurf, Copilot, Kiro, Antigravity, etc.)

AgenTest **auto-discovers `adb`** from standard SDK locations — no PATH configuration needed. It checks `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk` (macOS), `~/Android/Sdk` (Linux), and `%LOCALAPPDATA%\Android\Sdk` (Windows).

That's the complete list. You do **not** need:
- `adb` on your PATH (auto-discovered)
- A JDK or Android Studio on the host
- Gradle, Kotlin, or any Android build tooling
- To install anything onto the emulator manually
- To configure ports, services, or accessibility settings

AgenTest ships a tiny on-device helper APK (~1.8 MB) inside the npm package
and **auto-installs it on the first `agentest_connect` call** with zero user
input. The first connect takes ~5–8 seconds (mostly the two `adb install`
calls); every subsequent connect is ~1 second. If anything in the auto-install
flow fails, AgenTest silently falls back to the slower ADB-only path — you'll
never see a hard error from helper issues.

### Verify ADB is Working

```bash
adb devices
```

You should see at least one device listed:

```
List of devices attached
emulator-5554   device
```

If the list is empty, start an emulator from Android Studio or connect a device with USB debugging enabled.

---

## Installation

### From npm (recommended)

```bash
npm install -g agentest
```

Or use `npx` directly in your MCP config (no global install needed):

```json
{ "command": "npx", "args": ["-y", "agentest"] }
```

### From Source

```bash
git clone https://github.com/arjun-vegeta/agenTest.git
cd agentest
npm install
npm run build
```

### Verify the Build

```bash
npm run typecheck   # Zero errors
npm run lint        # Zero errors
npm run format:check # All files formatted
```

---

## Configuring Your AI Agent

Add AgenTest as an MCP server in your AI agent's MCP configuration.

### Option 1: Project-level (recommended)

Create or edit `.claude/settings.json` in your project:

```json
{
  "mcpServers": {
    "agentest": {
      "command": "node",
      "args": ["/absolute/path/to/agentest/dist/server.js"]
    }
  }
}
```

### Option 2: Global

Edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agentest": {
      "command": "node",
      "args": ["/absolute/path/to/agentest/dist/server.js"]
    }
  }
}
```

### Verify Connection

The AgenTest tools should appear in your agent. Ask the AI:

> "What MCP tools do you have available?"

You should see `agentest_connect`, `agentest_get_ui_tree`, `agentest_run_flow`, and `agentest_reset_app`.

---

## Usage

### Basic Flow

1. Have an Android emulator running with your app installed
2. Open your project in your AI coding agent
3. Tell the AI to test your app:

```
Test the login flow of my app. The package name is com.example.myapp.
```

The AI will:
1. Call `agentest_connect` with your package name
2. Read the accessibility tree to understand the UI
3. Generate test steps based on what it sees (and the source code if available)
4. Call `agentest_run_flow` with the test steps
5. Analyze the results and report findings

### Testing After Making Changes

```
I just added form validation to the signup screen. Test it — 
try valid inputs, empty fields, and invalid email formats.
```

The AI reads your code, understands the validation rules, generates appropriate test cases, and runs them.

### Resetting Between Tests

```
Reset the app and test the logout flow.
```

The AI calls `agentest_reset_app` to get clean state, then proceeds with testing.

---

## Development

### Watch Mode

```bash
npm run dev
```

Recompiles on every file change. Restart the MCP server in your AI agent after rebuilding.

### Running Tests

```bash
npm test            # Run once
npm run test:watch  # Watch mode
```

### Code Quality

```bash
npm run typecheck   # TypeScript strict mode check
npm run lint        # ESLint (strict + stylistic rules)
npm run lint:fix    # Auto-fix lint issues
npm run format      # Prettier format all files
```

---

## Troubleshooting

### "No Android devices/emulators connected"

- Run `adb devices` manually to verify
- If using an emulator, ensure it's fully booted (not still on the Android boot animation)
- Try `adb kill-server && adb start-server`

### "uiautomator dump returned invalid XML"

- The app may still be loading. Try again after a few seconds.
- Some system screens (lock screen, boot animation) don't produce valid dumps.
- If the app uses a custom SurfaceView or OpenGL rendering, the accessibility tree may be empty.

### "UI did not stabilize within 10000ms"

- The app has continuous animations or live-updating content (clock, timer, streaming data).
- This is a warning, not a crash. The last captured tree is still returned.
- Consider using `wait` steps before assertions to give the app more time.

### Tool calls timeout

- Default shell command timeout is 30s.
- `uiautomator dump` can be slow on older emulators (~1-2s per call) — but only matters if the helper APK fell back to ADB; the helper itself reads trees in ~80ms.
- If the emulator is under heavy load, commands may take longer.

### Helper APK didn't install

If `agentest_connect` returns `"helperInstalled": false`, something blocked the auto-install. Check the MCP server stderr (your AI agent surfaces this in its logs) for the specific failure. Common causes:

- **`adb install` failed**: low disk space on the emulator, or the emulator is mid-boot. Wait for boot to finish and reconnect.
- **`am instrument` couldn't spawn**: `adb` isn't on PATH for the Node.js process. Set `PATH` explicitly in your `.mcp.json` env config.
- **Port 8765 already in use**: another tool (or a previous agentest session) is holding the forward. Run `adb forward --remove tcp:8765` and reconnect.
- **Manual cleanup**: `adb uninstall com.agentest.helper.test && adb uninstall com.agentest.helper`, then reconnect.

To verify the helper is currently running, after a successful connect:

```bash
adb shell pm list packages | grep agentest
# package:com.agentest.helper
# package:com.agentest.helper.test

curl http://127.0.0.1:8765/status
# {"ok":true,"name":"agentest-helper","version":"1.0.0",...}
```

If both APKs are installed but the curl fails, run `adb forward tcp:8765 tcp:8765` to re-establish the host→device port mapping. The forward gets reset when adb is killed/restarted.

AgenTest works without the helper — it just falls back to the slower `uiautomator dump` + `adb shell input tap` path. Tests run ~3-5x slower but still pass.

### Text input issues

- `adb shell input text` has limited support for special characters.
- Spaces are converted to `%s` automatically.
- Shell metacharacters are escaped, but complex unicode may not work.
- For reliable text input with special characters, consider using the clipboard approach (not yet implemented).

---

## Optional: AgenTest Idling Bridge (Phase 3.10)

AgenTest already uses the on-device helper APK + framework-specific sync
backends (Hermes CDP for RN debug, Dart VM Service for Flutter debug) to
know when the UI has settled after an action. For most apps, this is
enough — actions auto-wait in ~150-300ms with no setup.

If your app does heavy background work that the accessibility tree
doesn't reflect — long-running network requests, custom coroutine
dispatchers, offline sync queues — you can optionally add the AgenTest
Idling Bridge AAR to your app's debug build. AgenTest will then drain
pending Espresso `IdlingResource`s + any custom `IdleSource`s between
actions, eliminating flakiness from "tap, but the request hasn't
finished yet" races.

The AAR ships prebuilt inside the npm package at
`node_modules/agentest/android-helper/prebuilt/agentest-idling-bridge.aar`
— no Gradle build step on your end.

### 1. React Native / Expo projects — one-line setup

Add this to your `android/app/build.gradle.kts` (or `build.gradle`):

```kotlin
dependencies {
    debugImplementation(
        files("../../node_modules/agentest/android-helper/prebuilt/agentest-idling-bridge.aar"),
    )
}
```

Adjust the `../../node_modules/` prefix if your Android project is
nested at a different depth relative to `node_modules/`.

### 1b. Pure-native Android or Flutter — copy the AAR

AgenTest isn't installed via npm in these projects, so you need to grab
the AAR directly from the AgenTest repo or a release asset:

```bash
# From a cloned AgenTest repo:
cp path/to/agentest/android-helper/prebuilt/agentest-idling-bridge.aar \
   my-app/app/libs/agentest-idling-bridge.aar
```

Then in `app/build.gradle.kts`:

```kotlin
dependencies {
    debugImplementation(files("libs/agentest-idling-bridge.aar"))
}
```

### 2. (Optional) Register custom idle sources

The bridge auto-wires Espresso's `IdlingRegistry` via reflection — if
your app already uses Espresso for local UI tests, every registered
`IdlingResource` is already visible to AgenTest with no extra code.

For state that isn't tracked by Espresso (e.g. a `Flow`-based loading
signal), register a custom `IdleSource` directly:

```kotlin
import com.agentest.bridge.AgenTestIdlingBridge

class MyRepository {
    val loading = MutableStateFlow(false)

    init {
        AgenTestIdlingBridge.register(object : AgenTestIdlingBridge.IdleSource {
            override val name = "MyRepository"
            override fun isIdleNow() = !loading.value
        })
    }
}
```

### 3. That's it

AgenTest auto-detects the bridge on the next `agentest_connect`. The
connect response will include `"frameworkSync": ["idling_bridge"]` (plus
any framework-specific channels). No MCP tool changes, no code changes
to your tests.

The bridge only runs on debug builds (because you only added it to
`debugImplementation`). Release builds automatically skip this channel.

### Rebuilding the AAR from source (maintainers)

```bash
cd android-helper
./gradlew :idling-bridge:assembleRelease
cp idling-bridge/build/outputs/aar/idling-bridge-release.aar \
   prebuilt/agentest-idling-bridge.aar
```
