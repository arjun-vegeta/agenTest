# AgenTest Helper APK

The on-device helper for AgenTest. Two APKs that get installed via `adb` on
the first MCP `agentest_connect` call. The helper exposes UiAutomation
primitives over a localhost HTTP server so the host TypeScript MCP server
can read trees, inject input, and detect idle without paying the per-call
process-spawn cost of `adb shell ...`.

## Architecture

Two APKs because Android instrumentation requires it:

- **`com.agentest.helper`** — main APK. Contains the embedded NanoHTTPD server
  and all UiAutomation logic. No launcher activity, no service. Exists purely
  as the target package for the test APK's `<instrumentation>` tag.
- **`com.agentest.helper.test`** — test APK. Contains a single JUnit `@Test`
  method (`HelperEntryPoint.startHelperServer`) that launches the embedded
  server and blocks on a `CountDownLatch` until shutdown. Pattern stolen
  from `appium/appium-uiautomator2-server`.

The host runs:

```
adb install -r -t agentest-helper.apk
adb install -r -t agentest-helper-test.apk
adb forward tcp:8765 tcp:8765
adb shell am instrument -w -r \
    com.agentest.helper.test/androidx.test.runner.AndroidJUnitRunner
```

`am instrument` runs the test process under the **shell UID**, which holds
`INJECT_EVENTS` — required for `UiAutomation.injectInputEvent` to dispatch
touches into other apps without a signature-level permission grant.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/status` | Health check + protocol version |
| GET    | `/tree?compact=1&package=...` | UI tree as JSON (compact mode = LLM-friendly) |
| GET    | `/framework?package=...` | Detect React Native / Flutter / Compose / native |
| GET    | `/screenshot` | base64 PNG via `UiAutomation.takeScreenshot` |
| GET    | `/wait-idle?timeoutMs=...` | Block until UI events stop firing for 150ms |
| POST   | `/tap` | `{x, y}` |
| POST   | `/swipe` | `{x1, y1, x2, y2, durationMs}` |
| POST   | `/long-press` | `{x, y, durationMs}` |
| POST   | `/key` | `{keycode}` (numeric Android KeyEvent code) |
| POST   | `/text` | `{text}` |
| POST   | `/shutdown` | Release the entry-point latch |

## Building locally

You only need to rebuild this when you change the helper source. The
prebuilt APKs in `prebuilt/` ship in the npm package and are committed to
the repo so end users never need to build anything.

Requirements:
- JDK 17+
- Android SDK with build-tools 34+ and platform-34

The first build downloads Gradle ~120 MB (~30s on a fast connection).

```bash
cd android-helper

# Generate local.properties pointing at your SDK if it's not in the standard
# location (~/Library/Android/sdk on macOS, $HOME/Android/Sdk on Linux).
echo "sdk.dir=$ANDROID_HOME" > local.properties

./gradlew assembleDebug assembleDebugAndroidTest

# Copy the freshly built APKs into prebuilt/ so the npm package picks them up.
cp app/build/outputs/apk/debug/app-debug.apk \
   prebuilt/agentest-helper.apk
cp app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk \
   prebuilt/agentest-helper-test.apk
```

After committing the new APKs, bump:
- `versionCode` in `app/build.gradle.kts`
- `HELPER.MIN_VERSION_CODE` in `../src/constants.ts`

so the host installer reinstalls on user devices.

## Compatibility

- **minSdk**: 24 (Android 7.0) — covers ~99% of devices in 2026
- **targetSdk / compileSdk**: 34
- **Tested on**: emulator API 36 (Pixel 9 Pro AVD)

`UiAutomation.injectInputEvent` requires the helper to run inside an
instrumentation process under the shell UID. This works on every emulator
and on physical devices with USB debugging enabled — no root required.

## Why not Appium UiAutomator2 server directly?

We considered it. Reasons we wrote our own minimal version:

1. **Size**: Appium's server is ~18 MB; ours is ~1.8 MB (no Netty, no MJPEG
   streamer, no Bluetooth permissions, no AsyncTask).
2. **Protocol**: Appium speaks W3C WebDriver. We just need a few JSON
   endpoints — no need to parse selector strings, capability bags, etc.
3. **Endpoint design**: ours is shaped to match AgenTest's existing
   `DeviceClient` API exactly, no impedance mismatch.
4. **Push idle detection**: Appium polls; we use
   `OnAccessibilityEventListener` for sub-frame idle signals.

Appium's source (Apache 2.0) was the structural reference for the two-APK
pattern, the `am instrument` launch dance, and the AndroidJUnit4 entry point
trick.
