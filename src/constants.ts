// ---------------------------------------------------------------------------
// MCP Tool Names
// ---------------------------------------------------------------------------

export const TOOL_NAMES = {
  CONNECT: 'agentest_connect',
  GET_UI_TREE: 'agentest_get_ui_tree',
  RUN_FLOW: 'agentest_run_flow',
  RESET_APP: 'agentest_reset_app',
} as const;

// ---------------------------------------------------------------------------
// MCP Server Identity
// ---------------------------------------------------------------------------

export const SERVER_NAME = 'agentest';
export const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// ADB Command Fragments
// ---------------------------------------------------------------------------

export const ADB = {
  BINARY: 'adb',
  SHELL: 'shell',
  EXEC_OUT: 'exec-out',
  DEVICE_FLAG: '-s',
  DUMP_PATH: '/sdcard/window_dump.xml',
} as const;

export const ADB_COMMANDS = {
  DEVICES: 'devices',
  UI_DUMP: 'uiautomator dump',
  INPUT_TAP: 'input tap',
  INPUT_TEXT: 'input text',
  INPUT_SWIPE: 'input swipe',
  INPUT_KEYEVENT: 'input keyevent',
  INPUT_LONG_PRESS: 'input swipe',
  AM_START: 'am start',
  AM_FORCE_STOP: 'am force-stop',
  MONKEY_LAUNCH: 'monkey -p',
  CAT: 'cat',
} as const;

export const MONKEY_FLAGS = {
  CATEGORY_LAUNCHER: '-c android.intent.category.LAUNCHER',
  EVENT_COUNT: '1',
} as const;

// ---------------------------------------------------------------------------
// Android Widget Class Names
// ---------------------------------------------------------------------------

export const ANDROID_CLASSES = {
  // Input
  BUTTON: 'android.widget.Button',
  IMAGE_BUTTON: 'android.widget.ImageButton',
  EDIT_TEXT: 'android.widget.EditText',
  CHECK_BOX: 'android.widget.CheckBox',
  SWITCH: 'android.widget.Switch',
  TOGGLE_BUTTON: 'android.widget.ToggleButton',
  RADIO_BUTTON: 'android.widget.RadioButton',
  SEEK_BAR: 'android.widget.SeekBar',
  SPINNER: 'android.widget.Spinner',

  // Display
  TEXT_VIEW: 'android.widget.TextView',
  IMAGE_VIEW: 'android.widget.ImageView',
  PROGRESS_BAR: 'android.widget.ProgressBar',

  // Containers
  FRAME_LAYOUT: 'android.widget.FrameLayout',
  LINEAR_LAYOUT: 'android.widget.LinearLayout',
  RELATIVE_LAYOUT: 'android.widget.RelativeLayout',
  SCROLL_VIEW: 'android.widget.ScrollView',
  HORIZONTAL_SCROLL_VIEW: 'android.widget.HorizontalScrollView',
  LIST_VIEW: 'android.widget.ListView',
  RECYCLER_VIEW: 'androidx.recyclerview.widget.RecyclerView',
  VIEW_PAGER: 'androidx.viewpager.widget.ViewPager',
  WEB_VIEW: 'android.webkit.WebView',
  TAB_WIDGET: 'android.widget.TabWidget',
  TOOLBAR: 'android.widget.Toolbar',
  ANDROIDX_TOOLBAR: 'androidx.appcompat.widget.Toolbar',

  // Compose
  COMPOSE_VIEW: 'androidx.compose.ui.platform.ComposeView',

  // React Native
  RCT_VIEW: 'com.facebook.react.views.view.ReactViewGroup',
} as const;

// ---------------------------------------------------------------------------
// Timeouts & Polling
// ---------------------------------------------------------------------------

export const TIMEOUTS = {
  /** Default timeout for shell commands (ms) */
  SHELL_COMMAND_MS: 30_000,
  /** Default timeout for idle detection (ms) */
  IDLE_DETECTION_MS: 10_000,
  /** Polling interval between tree snapshots during idle detection (ms) */
  IDLE_POLL_INTERVAL_MS: 200,
  /** Number of consecutive stable snapshots required to declare idle */
  IDLE_STABLE_COUNT: 2,
  /** Default timeout for waiting on a single action (ms) */
  ACTION_TIMEOUT_MS: 10_000,
  /** Default swipe duration (ms) */
  SWIPE_DURATION_MS: 300,
  /** Default long press duration (ms) */
  LONG_PRESS_DURATION_MS: 1_000,
  /** Delay after tapping a text field to let keyboard animate in (ms) */
  KEYBOARD_SETTLE_MS: 300,
  /** Default pinch gesture duration (ms) */
  PINCH_DURATION_MS: 300,
  /** Default rotate gesture duration (ms) */
  ROTATE_DURATION_MS: 400,
} as const;

// ---------------------------------------------------------------------------
// Bounds Parsing
// ---------------------------------------------------------------------------

export const BOUNDS_REGEX = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/;

// ---------------------------------------------------------------------------
// Tree Diff Noise Thresholds
// ---------------------------------------------------------------------------

export const DIFF_THRESHOLDS = {
  /** Ignore bounds changes smaller than this (pixels) */
  BOUNDS_JITTER_PX: 2,
} as const;

// ---------------------------------------------------------------------------
// Android Keycodes (commonly used)
// ---------------------------------------------------------------------------

export const KEYCODES = {
  HOME: 'KEYCODE_HOME',
  BACK: 'KEYCODE_BACK',
  ENTER: 'KEYCODE_ENTER',
  TAB: 'KEYCODE_TAB',
  DELETE: 'KEYCODE_DEL',
  ESCAPE: 'KEYCODE_ESCAPE',
  SPACE: 'KEYCODE_SPACE',
  DPAD_UP: 'KEYCODE_DPAD_UP',
  DPAD_DOWN: 'KEYCODE_DPAD_DOWN',
  DPAD_LEFT: 'KEYCODE_DPAD_LEFT',
  DPAD_RIGHT: 'KEYCODE_DPAD_RIGHT',
  APP_SWITCH: 'KEYCODE_APP_SWITCH',
  PASTE: 'KEYCODE_PASTE',
} as const;

// ---------------------------------------------------------------------------
// Swipe Geometry
// ---------------------------------------------------------------------------

export const SWIPE_OFFSETS = {
  /** Fraction of element (or screen) dimension used for swipe distance */
  DISTANCE_FRACTION: 0.6,
} as const;

// ---------------------------------------------------------------------------
// Double Tap Timing
// ---------------------------------------------------------------------------

export const DOUBLE_TAP = {
  /** Delay between the two taps (ms) */
  INTERVAL_MS: 100,
} as const;

// ---------------------------------------------------------------------------
// Clear Text Key Sequence
// ---------------------------------------------------------------------------

export const CLEAR_TEXT = {
  /** Number of delete key presses to clear a field (generous upper bound) */
  MAX_DELETE_PRESSES: 100,
  /** Keycode for select-all */
  SELECT_ALL_KEYCODE: 'KEYCODE_MOVE_HOME',
  SHIFT_SELECT_ALL: '--longpress',
} as const;

// ---------------------------------------------------------------------------
// Retry Configuration
// ---------------------------------------------------------------------------

export const RETRY = {
  /** Max retry attempts for flaky ADB commands (e.g. uiautomator dump) */
  MAX_ATTEMPTS: 3,
  /** Base delay between retries (ms) — doubles each attempt */
  BASE_DELAY_MS: 500,
} as const;

// ---------------------------------------------------------------------------
// New Tool Names
// ---------------------------------------------------------------------------

export const TOOL_NAMES_EXT = {
  GET_LOGS: 'agentest_get_logs',
  SCREENSHOT: 'agentest_screenshot',
  DEVICE_INFO: 'agentest_device_info',
  GET_SHARED_PREFS: 'agentest_get_shared_prefs',
  QUERY_DB: 'agentest_query_db',
  SET_NETWORK: 'agentest_set_network',
} as const;

// ---------------------------------------------------------------------------
// ADB Extended Commands
// ---------------------------------------------------------------------------

export const ADB_COMMANDS_EXT = {
  LOGCAT_DUMP: 'logcat -d',
  LOGCAT_PID_FLAG: '--pid',
  PIDOF: 'pidof',
  SCREENCAP: 'screencap -p',
  WM_SIZE: 'wm size',
  WM_DENSITY: 'wm density',
  GETPROP: 'getprop',
  RUN_AS: 'run-as',
  SQLITE3: 'sqlite3',
  SHARED_PREFS_DIR: 'shared_prefs',
  DATABASES_DIR: 'databases',
  SVC_WIFI: 'svc wifi',
  SVC_DATA: 'svc data',
  AIRPLANE_MODE: 'cmd connectivity airplane-mode',
  EMU: 'emu',
  NETWORK_SPEED: 'network speed',
  NETWORK_DELAY: 'network delay',
  INSTALL: 'install',
  INSTALL_REPLACE: '-r',
  INSTALL_TEST: '-t',
  UNINSTALL: 'uninstall',
  FORWARD: 'forward',
  FORWARD_REMOVE: 'forward --remove',
  AM_INSTRUMENT: 'am instrument -w -r',
  PM_LIST_PKGS: 'pm list packages',
  DUMPSYS_PACKAGE: 'dumpsys package',
  CONTENT_QUERY: 'content query',
} as const;

/**
 * Valid presets for `adb emu network speed`.
 * See: https://developer.android.com/studio/run/emulator-networking
 */
export const NETWORK_SPEED_PRESETS = [
  'gsm', // 14.4/14.4 kbps
  'gprs', // 28.8/57.6 kbps
  'edge', // 236.8/473.6 kbps
  'umts', // 384/384 kbps
  '3g', // same as umts
  'hsdpa', // 5.76/14.4 Mbps
  'lte', // 58/173 Mbps
  'full', // unlimited
] as const;

/** Valid presets for `adb emu network delay` (latency). */
export const NETWORK_DELAY_PRESETS = [
  'none', // 0ms
  'gprs', // 150-550ms
  'edge', // 80-400ms
  'umts', // 35-200ms
] as const;

export type NetworkSpeedPreset = (typeof NETWORK_SPEED_PRESETS)[number];
export type NetworkDelayPreset = (typeof NETWORK_DELAY_PRESETS)[number];

export const ANDROID_PROPS = {
  SDK_VERSION: 'ro.build.version.sdk',
  ANDROID_VERSION: 'ro.build.version.release',
  DEVICE_MODEL: 'ro.product.model',
  DEVICE_MANUFACTURER: 'ro.product.manufacturer',
} as const;

// ---------------------------------------------------------------------------
// Logcat
// ---------------------------------------------------------------------------

export const LOGCAT = {
  /** Max lines to return from logcat */
  MAX_LINES: 200,
} as const;

// ---------------------------------------------------------------------------
// Scroll-to-find
// ---------------------------------------------------------------------------

export const SCROLL_TO = {
  /** Default max scrolls before giving up */
  MAX_SCROLLS: 10,
  /** Delay between scroll + tree check (ms) */
  SCROLL_SETTLE_MS: 300,
} as const;

// ---------------------------------------------------------------------------
// System Dialog Detection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Loading Indicator Detection
// ---------------------------------------------------------------------------

export const LOADING_INDICATORS = {
  /** Android class names that indicate loading */
  CLASS_NAMES: ['android.widget.ProgressBar'] as readonly string[],
  /** Class name substrings that indicate loading */
  CLASS_FRAGMENTS: [
    'ProgressBar',
    'ProgressIndicator',
    'ShimmerFrameLayout',
    'Shimmer',
    'SkeletonLayout',
  ] as readonly string[],
  /** Text patterns that indicate loading (case-insensitive) */
  TEXT_PATTERNS: [
    /^loading\.{0,3}$/i,
    /^please wait\.{0,3}$/i,
    /^fetching\.{0,3}$/i,
    /^connecting\.{0,3}$/i,
  ] as readonly RegExp[],
  /** Content description patterns that indicate loading (case-insensitive) */
  DESC_PATTERNS: [/loading/i, /progress/i, /spinner/i] as readonly RegExp[],
} as const;

export const IDLE_LOADING = {
  /** Max time to wait for loading indicators to disappear after tree stabilizes (ms).
   *  Kept short (8s) so the server returns control to Claude quickly.
   *  If loading is still in progress, the next step's idle detection will pick it up. */
  MAX_LOADING_WAIT_MS: 8_000,
  /** Poll interval when waiting for loading indicators to disappear (ms) */
  LOADING_POLL_INTERVAL_MS: 500,
} as const;

// ---------------------------------------------------------------------------
// Lightweight Actions (skip full idle detection — single snapshot only)
// ---------------------------------------------------------------------------

export const LIGHTWEIGHT_ACTIONS: readonly string[] = [
  'press_key',
  'type',
  'clear_text',
  'tap_coordinates',
  'long_press_coordinates',
  'double_tap_coordinates',
  'swipe_coordinates',
] as const;

export const SYSTEM_PACKAGES = [
  'com.android.systemui',
  'com.android.packageinstaller',
  'com.google.android.permissioncontroller',
  'android',
  'com.android.settings',
] as const;

// ---------------------------------------------------------------------------
// gRPC Emulator Backend
// ---------------------------------------------------------------------------

export const GRPC = {
  /** gRPC port = emulator console port + this offset */
  PORT_OFFSET: 3000,
  /** Connection timeout for initial gRPC health check (ms) */
  CONNECT_TIMEOUT_MS: 5_000,
  /** Deadline for individual RPC calls (ms) */
  RPC_DEADLINE_MS: 10_000,
  /** Target FPS for swipe touch interpolation */
  SWIPE_FPS: 60,
  /** Touch pressure value for finger-down events */
  DEFAULT_PRESSURE: 100,
  /** Touch pressure value for finger-up (release) events */
  RELEASE_PRESSURE: 0,
  /** Default multitouch finger identifier */
  DEFAULT_FINGER_ID: 0,
} as const;

// ---------------------------------------------------------------------------
// On-device Helper APK (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Constants for the AgenTest on-device helper. The helper APK runs inside an
 * `am instrument` process on the device and exposes UiAutomation primitives
 * over a localhost HTTP server. The host TypeScript MCP server reaches it via
 * `adb forward`. See android-helper/ for the source.
 */
export const HELPER = {
  /** Main APK package name. */
  PACKAGE: 'com.agentest.helper',
  /** Test APK package name (the one `am instrument` targets). */
  TEST_PACKAGE: 'com.agentest.helper.test',
  /** AndroidJUnitRunner full class — what `am instrument` invokes. */
  RUNNER: 'androidx.test.runner.AndroidJUnitRunner',
  /** Port the helper binds to inside the device. */
  DEVICE_PORT: 8765,
  /**
   * Host port to use for `adb forward`. Distinct from DEVICE_PORT so a
   * developer can run a normal local server on 8765 without colliding.
   */
  HOST_PORT: 8765,
  /** Filenames in android-helper/prebuilt/ shipped with the npm package. */
  MAIN_APK_FILENAME: 'agentest-helper.apk',
  TEST_APK_FILENAME: 'agentest-helper-test.apk',
  /**
   * Minimum versionCode the helper APK must have for the host to accept it.
   * Bump in lockstep with android-helper/app/build.gradle.kts versionCode.
   */
  MIN_VERSION_CODE: 1,
  /** The protocol version the host expects. Must match HelperServer.PROTOCOL_VERSION. */
  EXPECTED_PROTOCOL_VERSION: 1,
  /** How long to wait for the helper /status endpoint to come up after launch (ms). */
  STARTUP_TIMEOUT_MS: 30_000,
  /** Poll interval while waiting for /status (ms). */
  STARTUP_POLL_MS: 250,
  /** Default request timeout for non-blocking helper endpoints (ms). */
  REQUEST_TIMEOUT_MS: 10_000,
  /** Timeout for /wait-idle (longer because it can legitimately block). */
  WAIT_IDLE_TIMEOUT_MS: 30_000,
} as const;

// ---------------------------------------------------------------------------
// Framework sync backends (Phase 3.5 / 3.6 / 3.7 / 3.9)
// ---------------------------------------------------------------------------

/**
 * Hermes inspector (React Native debug builds). Metro exposes an inspector
 * proxy on port 8081 that multiplexes CDP sessions to connected Hermes
 * runtimes. Discovery: `GET /json/list` returns an array of targets with
 * `webSocketDebuggerUrl`. The MCP server reaches Metro through `adb reverse`
 * (so the emulator's localhost:8081 hits the host's Metro).
 *
 * Hermes debugging is disabled in release builds — every failure here is
 * non-fatal; we just skip the CDP sync channel and rely on the helper's
 * accessibility-event idle.
 */
export const HERMES = {
  /** Metro inspector proxy host port. */
  METRO_PORT: 8081,
  /** Discovery endpoint on Metro. Returns JSON array of debug targets. */
  JSON_LIST_PATH: '/json/list',
  /** Max time to wait for the /json/list probe (ms). */
  DISCOVERY_TIMEOUT_MS: 2_000,
  /** Max time to wait for a CDP method reply (ms). */
  CDP_REPLY_TIMEOUT_MS: 5_000,
  /** Max time to keep probing for JS liveness after the helper reports UI idle (ms). */
  SYNC_TIMEOUT_MS: 3_000,
  /** Poll interval for JS liveness checks (ms). */
  SYNC_POLL_MS: 80,
  /**
   * Round-trip threshold for declaring "JS thread is responsive" — an
   * `evaluate` that returns within this window means Hermes isn't stuck in
   * a hot loop. Kept generous because the CDP roundtrip through Metro's
   * inspector proxy itself eats ~20-40ms on a real device.
   */
  SYNC_IDLE_THRESHOLD_MS: 120,
  /** Consecutive responsive probes required to declare liveness. */
  SYNC_STABLE_COUNT: 2,
} as const;

/**
 * Flutter Dart VM Service. Flutter debug+profile builds write their
 * Observatory URL to logcat on startup: `The Dart VM service is listening on
 * http://127.0.0.1:<port>/<authCode>/`. We discover the port by grepping
 * logcat, `adb forward` it to the host, then connect over WebSocket at
 * `ws://127.0.0.1:<hostPort>/<authCode>/ws`. JSON-RPC 2.0.
 *
 * Disabled in `--release` builds — every failure is non-fatal.
 */
export const FLUTTER_VM = {
  /** Host-side adb forward port for the Dart VM Service. */
  HOST_PORT: 8766,
  /** Logcat pattern used to discover the listening URL. */
  LOGCAT_DISCOVERY_REGEX: /Dart VM [Ss]ervice is listening on (http:\/\/[^\s]+)/,
  /** Max time to wait for logcat discovery (ms). */
  DISCOVERY_TIMEOUT_MS: 5_000,
  /** How many logcat lines to scan for the URL. */
  DISCOVERY_MAX_LINES: 2_000,
  /** Max time to wait for a JSON-RPC reply (ms). */
  RPC_REPLY_TIMEOUT_MS: 5_000,
  /**
   * How many times to retry `getVM` when looking for the first isolate.
   * Freshly-started Flutter apps can report an empty isolates list for up
   * to ~500ms while the runtime initializes. Default = 8 retries × 100ms
   * poll = ~800ms worst case.
   */
  ISOLATE_DISCOVERY_ATTEMPTS: 8,
  /** Poll interval between isolate discovery retries (ms). */
  ISOLATE_DISCOVERY_POLL_MS: 100,
  /**
   * Retry budget for ensureFlutterSemantics. The service extension isn't
   * registered until the WidgetsBinding has initialized — on cold start
   * we may hit the isolate before the binding is ready.
   */
  ENSURE_SEMANTICS_ATTEMPTS: 5,
  /** Delay between ensureFlutterSemantics retries (ms). */
  ENSURE_SEMANTICS_POLL_MS: 120,
  /** Max time to keep probing for Flutter liveness (ms). */
  SYNC_TIMEOUT_MS: 3_000,
  /** Poll interval for liveness checks (ms). */
  SYNC_POLL_MS: 80,
  /**
   * Round-trip threshold for declaring "Dart VM is responsive" — a
   * getVM() that returns within this window means the isolate's event
   * loop isn't wedged. Must be larger than the WebSocket roundtrip alone.
   */
  SYNC_IDLE_THRESHOLD_MS: 150,
  /** Consecutive responsive probes required to declare liveness. */
  SYNC_STABLE_COUNT: 2,
} as const;

/**
 * AgenTest IdlingResource bridge (Phase 3.10). Opt-in AAR users add to their
 * app's `debugImplementation`. Exposes a ContentProvider that the helper can
 * query for pending-idle-resource counts.
 *
 * See android-helper/idling-bridge/ for the AAR source.
 */
export const IDLING_BRIDGE = {
  /** Suffix appended to the app's package to form the provider authority. */
  AUTHORITY_SUFFIX: '.agentest.idling',
  /** Content URI path for the idle-state query. */
  QUERY_PATH: 'state',
  /** Max time allowed for an idling-state query (ms). */
  QUERY_TIMEOUT_MS: 2_000,
  /**
   * Wire format version of the idling bridge ContentProvider. Must match
   * `AgenTestIdlingProvider.WIRE_VERSION` in the Kotlin AAR. Bump together
   * when the cursor schema changes.
   *
   * The host uses this to detect when a user has updated AgenTest via npm
   * but their Android app still has the old AAR baked into its debug build
   * — Gradle caches AARs in the app's build cache, so a stale version can
   * persist across `npm update agentest` until the user rebuilds their app.
   *
   * On mismatch, `agentest_connect` returns a warning with an actionable
   * `./gradlew` rebuild command that the LLM surfaces to the developer.
   */
  EXPECTED_WIRE_VERSION: 1,
} as const;

/** Maps Android KEYCODE_* strings to W3C key values for gRPC sendKey */
export const KEYCODE_TO_W3C: Readonly<Record<string, string>> = {
  KEYCODE_BACK: 'GoBack',
  KEYCODE_HOME: 'GoHome',
  KEYCODE_APP_SWITCH: 'AppSwitch',
  KEYCODE_ENTER: 'Enter',
  KEYCODE_DEL: 'Backspace',
  KEYCODE_FORWARD_DEL: 'Delete',
  KEYCODE_TAB: 'Tab',
  KEYCODE_ESCAPE: 'Escape',
  KEYCODE_SPACE: ' ',
  KEYCODE_DPAD_UP: 'ArrowUp',
  KEYCODE_DPAD_DOWN: 'ArrowDown',
  KEYCODE_DPAD_LEFT: 'ArrowLeft',
  KEYCODE_DPAD_RIGHT: 'ArrowRight',
  KEYCODE_MOVE_HOME: 'Home',
  KEYCODE_MOVE_END: 'End',
  KEYCODE_PAGE_UP: 'PageUp',
  KEYCODE_PAGE_DOWN: 'PageDown',
  KEYCODE_POWER: 'Power',
} as const;
