import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { FrameworkSync } from './android/framework-sync.js';
import type { GrpcEmulatorClient } from './android/grpc-client.js';
import type { HelperHandle } from './android/helper-installer.js';
import { RefRegistry } from './android/ref-registry.js';
import { LOGCAT, SERVER_NAME, SERVER_VERSION, TOOL_NAMES, TOOL_NAMES_EXT } from './constants.js';
import { AgenTestError } from './errors.js';
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

/** Tracks the active framework sync backend (Hermes CDP / Dart VM Service) */
let activeSync: FrameworkSync | undefined;

/** Ref registry — maps @ref tokens to nodes across tool calls within a session */
const activeRefRegistry = new RefRegistry();

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// ---------------------------------------------------------------------------
// Tool: agentest_connect
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES.CONNECT,
  `Connect to an Android emulator/device and launch the app. Returns the initial UI screen in compact text format with @ref tokens you can use as selectors.

The compact format uses one line per element:
  @b1 btn "Sign in"      — button, ref @b1
  @f1 input "Email"      — text field, ref @f1
  @c1 check "Remember me" — checkbox
  @s1 scroll              — scrollable area
  @l1 link "Forgot?"     — clickable text link
  @g1 tap                 — generic clickable (unlabeled)
  "plain text"            — non-interactive text

Use refs in subsequent run_flow steps: { "action": "tap", "target": { "ref": "@b1" } }
Traditional selectors (id/text/className/description) still work alongside refs.

Pass verbose:true to include framework-sync diagnostics.`,
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
        'Input backend: "auto" (default) tries gRPC then falls back to ADB; "adb" forces ADB only; "grpc" requires gRPC (emulator only).',
      ),
    verbose: z.boolean().optional().describe('Include framework-sync diagnostics in the response.'),
  },
  async ({ packageName, deviceId, backend, verbose }) => {
    try {
      const result = await handleConnect(
        shell,
        packageName,
        deviceId,
        backend ?? 'auto',
        activeGrpcClient,
        activeHelper,
        activeSync,
        activeRefRegistry,
      );
      activeDeviceId = result.deviceId;
      activePackageName = packageName;
      activeGrpcClient = result.grpcClient;
      activeHelper = result.helper;
      activeSync = result.sync;

      const anomalyDetected =
        result.framework === undefined ||
        (result.warnings !== undefined && result.warnings.length > 0);
      const includeDiagnostics = verbose === true || anomalyDetected;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              deviceId: result.deviceId,
              packageName: result.packageName,
              backend: result.backend,
              helperInstalled: result.helperInstalled,
              framework: result.framework,
              frameworkSync: result.frameworkSync,
              screenFingerprint: result.screenFingerprint,
              warnings: result.warnings,
              diagnostics: includeDiagnostics ? result.diagnostics : undefined,
            }),
          },
          {
            type: 'text',
            text: result.uiTree,
          },
        ],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: agentest_get_ui_tree
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES.GET_UI_TREE,
  `Get a fresh snapshot of the current UI screen. Returns compact text with @ref tokens by default.

Use refs in selectors: { "ref": "@b1" }. If a ref is stale (screen changed), you'll get a clear error — just call this tool again for fresh refs.

Options:
- format: "compact" (default) or "full" (legacy JSON tree with bounds + classNames — use for debugging or layout inspection)
- depth: max tree depth (omit for unlimited)
- onlyInteractive: true to drop plain text lines (hoisted labels still appear on interactives)`,
  {
    format: z
      .enum(['compact', 'full'])
      .optional()
      .describe(
        'Output format: "compact" (default, indented text with @refs) or "full" (JSON tree with bounds/classNames for debugging)',
      ),
    depth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max tree depth. Deeper subtrees are summarized as "+N interactive elements".'),
    onlyInteractive: z
      .boolean()
      .optional()
      .describe(
        'Drop plain text lines — only show interactive elements with refs. Labels are still hoisted onto interactives.',
      ),
  },
  async ({ format, depth, onlyInteractive }) => {
    try {
      const result = await handleGetUiTree(
        shell,
        activeRefRegistry,
        { format, depth, onlyInteractive },
        activeDeviceId,
        activeGrpcClient,
        activeHelper?.client,
        activeSync,
      );

      if (result.format === 'full') {
        return {
          content: [{ type: 'text', text: JSON.stringify(result.uiTree, null, 2) }],
        };
      }

      return {
        content: [{ type: 'text', text: result.uiTree as string }],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: agentest_run_flow
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES.RUN_FLOW,
  `Execute a batch of UI actions and assertions. Stops on first failure.

TARGET ELEMENTS using refs from the last tree snapshot:
  { "action": "tap", "target": { "ref": "@b1" } }
Or use traditional selectors (id/text/textContains/className/description/index) — both work.

DO NOT add "wait" or "wait_for_stable" steps — the server auto-waits after every action.

RESPONSE: includes screenFingerprint and screenChanged. If screenChanged is false and success is true, the UI is exactly where you left it — reuse your prior refs without re-snaphotting. The tree is only included when the screen actually changed or the flow failed.

ACTIONS: tap, tap_coordinates, type, clear_text, swipe, swipe_coordinates, long_press, long_press_coordinates, double_tap, double_tap_coordinates, press_key, scroll_to.
ASSERTIONS: assert_visible, assert_not_visible, assert_text_equals, assert_text_contains.

SELECTORS: ref (fastest — from last snapshot), id (substring), text (exact), textContains (substring), className (short or full name), description (substring), index (0-based Nth match).`,
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
        activeSync,
        activeRefRegistry,
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
// Tool: agentest_reset_app
// ---------------------------------------------------------------------------

server.tool(
  TOOL_NAMES.RESET_APP,
  'Force-stop and relaunch the app. Returns fresh compact tree with @refs. Use between test cases for clean state.',
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
                'No package name provided and no app currently connected. Call agentest_connect first.',
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
        activeSync,
        activeRefRegistry,
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              packageName: result.packageName,
              screenFingerprint: result.screenFingerprint,
            }),
          },
          {
            type: 'text',
            text: result.uiTree,
          },
        ],
      };
    } catch (err) {
      return formatError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: agentest_get_logs
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
                'No package name provided and no app currently connected. Call agentest_connect first.',
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
// Tool: agentest_screenshot
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
// Tool: agentest_device_info
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
// Tool: agentest_get_shared_prefs
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
                'No package name provided and no app currently connected. Call agentest_connect first.',
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
// Tool: agentest_query_db
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
                'No package name provided and no app currently connected. Call agentest_connect first.',
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
// Tool: agentest_set_network
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
    err instanceof AgenTestError
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
