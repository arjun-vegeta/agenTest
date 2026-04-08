// ---------------------------------------------------------------------------
// MCP Tool Names
// ---------------------------------------------------------------------------

export const TOOL_NAMES = {
  CONNECT: 'lazytest_connect',
  GET_UI_TREE: 'lazytest_get_ui_tree',
  RUN_FLOW: 'lazytest_run_flow',
  RESET_APP: 'lazytest_reset_app',
} as const;

// ---------------------------------------------------------------------------
// MCP Server Identity
// ---------------------------------------------------------------------------

export const SERVER_NAME = 'lazytest';
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
  IDLE_POLL_INTERVAL_MS: 500,
  /** Number of consecutive stable snapshots required to declare idle */
  IDLE_STABLE_COUNT: 2,
  /** Default timeout for waiting on a single action (ms) */
  ACTION_TIMEOUT_MS: 10_000,
  /** Default swipe duration (ms) */
  SWIPE_DURATION_MS: 300,
  /** Default long press duration (ms) */
  LONG_PRESS_DURATION_MS: 1_000,
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
} as const;

// ---------------------------------------------------------------------------
// Swipe Geometry
// ---------------------------------------------------------------------------

export const SWIPE_OFFSETS = {
  /** Fraction of element (or screen) dimension used for swipe distance */
  DISTANCE_FRACTION: 0.6,
} as const;
