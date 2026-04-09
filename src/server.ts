import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { GrpcEmulatorClient } from './android/grpc-client.js';
import type { HelperHandle } from './android/helper-installer.js';
import { LOGCAT, SERVER_NAME, SERVER_VERSION, TOOL_NAMES, TOOL_NAMES_EXT } from './constants.js';
import { LazyTestError } from './errors.js';
import { ProcessShellExecutor } from './shell.js';
import { handleConnect } from './tools/connect.js';
import { handleDeviceInfo } from './tools/device-info.js';
import { handleGetLogs } from './tools/get-logs.js';
import { handleGetSharedPrefs } from './tools/get-shared-prefs.js';
import { handleGetUiTree } from './tools/get-ui-tree.js';
import { handleQueryDb } from './tools/query-db.js';
import { handleResetApp } from './tools/reset-app.js';
import { handleRunFlow } from './tools/run-flow.js';
import { handleScreenshot } from './tools/screenshot.js';
import { handleSetNetwork } from './tools/set-network.js';
import { ActionStepSchema } from './types.js';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const shell = new ProcessShellExecutor();

/** Tracks the active device ID once connected */
let activeDeviceId: string | undefined;

/** Tracks the active package name once connected */
let activePackageName: string | undefined;

/** Tracks the active gRPC client for emulator input injection */
let activeGrpcClient: GrpcEmulatorClient | undefined;

/** Tracks the active on-device helper handle (HTTP client + instrument process) */
let activeHelper: HelperHandle | undefined;

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// ---------------------------------------------------------------------------
// Tool: lazytest_connect
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES.CONNECT,
  'Connect to an Android emulator/device and launch the app. Returns the initial UI accessibility tree.',
  {
    packageName: z.string().describe('Android package name (e.g. "com.example.myapp")'),
    deviceId: z
      .string()
      .optional()
      .describe(
        'Specific device/emulator ID from "adb devices". Omit to use the first connected device.',
      ),
    backend: z
      .enum(['auto', 'adb', 'grpc'])
      .optional()
      .describe(
        'Input backend: "auto" (default) tries gRPC then falls back to ADB; "adb" forces ADB only; "grpc" requires gRPC (emulator only, fails if unavailable).',
      ),
  },
  async ({ packageName, deviceId, backend }) => {
    try {
      const result = await handleConnect(
        shell,
        packageName,
        deviceId,
        backend ?? 'auto',
        activeGrpcClient,
        activeHelper,
      );
      activeDeviceId = result.deviceId;
      activePackageName = packageName;
      activeGrpcClient = result.grpcClient;
      activeHelper = result.helper;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                deviceId: result.deviceId,
                packageName: result.packageName,
                backend: result.backend,
                helperInstalled: result.helperInstalled,
                framework: result.framework,
                uiTree: result.uiTree,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: lazytest_get_ui_tree
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES.GET_UI_TREE,
  'Get a fresh snapshot of the current UI accessibility tree as compact JSON. Use this to see what is on screen.',
  {},
  async () => {
    try {
      const result = await handleGetUiTree(
        shell,
        activeDeviceId,
        activeGrpcClient,
        activeHelper?.client,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: lazytest_run_flow
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES.RUN_FLOW,
  `Execute a batch of UI actions and assertions. Stops on first failure. Returns the final UI tree after all steps complete (or at point of failure).

DO NOT add "wait" or "wait_for_stable" steps. The server automatically waits after EVERY action for the UI to settle and all loading indicators to disappear. Adding wait steps wastes time. If you need to check the screen state, just call get_ui_tree instead.

If a step causes the app to navigate (e.g., auto-submit), the server detects that the next step's target is gone and returns immediately with the new screen — you can then re-plan.

ACTIONS: tap, tap_coordinates, type, clear_text, swipe, swipe_coordinates, long_press, long_press_coordinates, double_tap, double_tap_coordinates, press_key, scroll_to.
ASSERTIONS: assert_visible, assert_not_visible, assert_text_equals, assert_text_contains.

SELECTORS (all are flexible matching):
- id: substring match against resource-id ("email" matches "com.app:id/email")
- text: exact match against visible text
- textContains: substring match against visible text
- className: matches full name OR short name ("EditText" matches "android.widget.EditText")
- description: substring match against content-desc ("ira" matches "ira, Last seen today at 6:24 PM")
- index: pick the Nth match (0-based)

The tree uses "cls" field for short class names (e.g. "ReactEditText") — you can use this directly in the className selector.
Use *_coordinates variants (x,y from bounds) for unlabeled icons. Use clear_text before type to overwrite existing text.`,
  {
    steps: z
      .array(ActionStepSchema)
      .min(1)
      .describe('Ordered list of actions and assertions to execute'),
  },
  async ({ steps }) => {
    try {
      const result = await handleRunFlow(
        shell,
        steps,
        activeDeviceId,
        activeGrpcClient,
        activeHelper?.client,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: lazytest_reset_app
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES.RESET_APP,
  'Force-stop and relaunch the app. Returns the fresh UI tree after relaunch. Use between test cases for clean state.',
  {
    packageName: z
      .string()
      .optional()
      .describe('Package name to reset. Defaults to the last connected app.'),
  },
  async ({ packageName }) => {
    const pkg = packageName ?? activePackageName;
    if (!pkg) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                'No package name provided and no app currently connected. Call lazytest_connect first.',
            }),
          },
        ],
      };
    }

    try {
      const result = await handleResetApp(
        shell,
        pkg,
        activeDeviceId,
        activeGrpcClient,
        activeHelper?.client,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: lazytest_get_logs
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES_EXT.GET_LOGS,
  'Get recent app logs (logcat) filtered to the target app. Use to diagnose failures — API errors, crashes, exceptions.',
  {
    packageName: z
      .string()
      .optional()
      .describe('Package name to filter logs for. Defaults to the last connected app.'),
    maxLines: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Max log lines to return (default: ${LOGCAT.MAX_LINES})`),
  },
  async ({ packageName, maxLines }) => {
    const pkg = packageName ?? activePackageName;
    if (!pkg) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                'No package name provided and no app currently connected. Call lazytest_connect first.',
            }),
          },
        ],
      };
    }

    try {
      const result = await handleGetLogs(
        shell,
        pkg,
        maxLines,
        activeDeviceId,
        activeGrpcClient,
        activeHelper?.client,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: lazytest_screenshot
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES_EXT.SCREENSHOT,
  'Capture a screenshot of the current screen as a base64-encoded PNG. Use when the accessibility tree is insufficient — custom canvas, images, visual layout issues.',
  {},
  async () => {
    try {
      const result = await handleScreenshot(
        shell,
        activeDeviceId,
        activeGrpcClient,
        activeHelper?.client,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: lazytest_device_info
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES_EXT.DEVICE_INFO,
  'Get device/emulator info: screen size, density, Android version, SDK level, model. Use to understand the test environment.',
  {},
  async () => {
    try {
      const result = await handleDeviceInfo(
        shell,
        activeDeviceId,
        activeGrpcClient,
        activeHelper?.client,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: lazytest_get_shared_prefs
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES_EXT.GET_SHARED_PREFS,
  'Read a SharedPreferences XML file from the app. Use to verify stored state (tokens, user info, settings). Requires a debuggable build.',
  {
    file: z.string().describe('SharedPreferences filename (e.g. "my_prefs.xml" or "my_prefs")'),
    packageName: z
      .string()
      .optional()
      .describe('Package name. Defaults to the last connected app.'),
  },
  async ({ file, packageName }) => {
    const pkg = packageName ?? activePackageName;
    if (!pkg) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                'No package name provided and no app currently connected. Call lazytest_connect first.',
            }),
          },
        ],
      };
    }

    try {
      const result = await handleGetSharedPrefs(
        shell,
        pkg,
        file,
        activeDeviceId,
        activeGrpcClient,
        activeHelper?.client,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: lazytest_query_db
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES_EXT.QUERY_DB,
  'Run a SQL query against an app SQLite database (including Room). Use to verify DB state after test actions. Requires a debuggable build.',
  {
    database: z.string().describe('Database filename (e.g. "app.db")'),
    query: z.string().describe('SQL query (e.g. "SELECT * FROM users LIMIT 10")'),
    packageName: z
      .string()
      .optional()
      .describe('Package name. Defaults to the last connected app.'),
  },
  async ({ database, query, packageName }) => {
    const pkg = packageName ?? activePackageName;
    if (!pkg) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                'No package name provided and no app currently connected. Call lazytest_connect first.',
            }),
          },
        ],
      };
    }

    try {
      const result = await handleQueryDb(
        shell,
        pkg,
        database,
        query,
        activeDeviceId,
        activeGrpcClient,
        activeHelper?.client,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: lazytest_set_network
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES_EXT.SET_NETWORK,
  `Simulate network conditions on the emulator for testing offline/slow connections.

Presets: "full" (unlimited), "lte" (58/173 Mbps), "3g" (384 kbps), "edge" (237/474 kbps), "gsm" (14 kbps), "gprs" (29/58 kbps), "offline" (wifi + data off).
Latency presets: "none", "gprs" (150-550ms), "edge" (80-400ms), "umts" (35-200ms).
Custom: "speed" as "up:down" kbps, "delay" as "min:max" ms.
Also: toggle wifi and airplaneMode explicitly.`,
  {
    preset: z
      .string()
      .optional()
      .describe(
        'Speed preset: gsm/gprs/edge/umts/3g/hsdpa/lte/full, or "offline" to disable all network',
      ),
    speed: z.string().optional().describe('Custom speed as "up:down" kbps (e.g. "100:1000")'),
    delay: z
      .string()
      .optional()
      .describe('Latency: preset (none/gprs/edge/umts) or custom "min:max" ms'),
    wifi: z.boolean().optional().describe('Enable/disable WiFi'),
    airplaneMode: z.boolean().optional().describe('Enable/disable airplane mode'),
  },
  async (input) => {
    try {
      const result = await handleSetNetwork(
        shell,
        input,
        activeDeviceId,
        activeGrpcClient,
        activeHelper?.client,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function formatError(err: unknown): { content: { type: 'text'; text: string }[] } {
  const message =
    err instanceof LazyTestError
      ? { error: err.message, code: err.code }
      : { error: err instanceof Error ? err.message : String(err) };

  return {
    content: [{ type: 'text', text: JSON.stringify(message) }],
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} MCP server running on stdio`);
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
