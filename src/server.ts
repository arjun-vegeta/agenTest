import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SERVER_NAME, SERVER_VERSION, TOOL_NAMES } from './constants.js';
import { LazyTestError } from './errors.js';
import { ProcessShellExecutor } from './shell.js';
import { handleConnect } from './tools/connect.js';
import { handleGetUiTree } from './tools/get-ui-tree.js';
import { handleResetApp } from './tools/reset-app.js';
import { handleRunFlow } from './tools/run-flow.js';
import { ActionStepSchema } from './types.js';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const shell = new ProcessShellExecutor();

/** Tracks the active device ID once connected */
let activeDeviceId: string | undefined;

/** Tracks the active package name once connected */
let activePackageName: string | undefined;

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
  },
  async ({ packageName, deviceId }) => {
    try {
      const result = await handleConnect(shell, packageName, deviceId);
      activeDeviceId = result.deviceId;
      activePackageName = packageName;

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
      const result = await handleGetUiTree(shell, activeDeviceId);

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
  `Execute a batch of UI actions and assertions sequentially. Stops on first failure.
Each step is one of: tap, type, swipe, long_press, press_key, wait, assert_visible, assert_not_visible, assert_text_equals, assert_text_contains.
Target elements using selectors: id (resource-id substring), text (exact), textContains (partial), className, description.
Returns a full trace with step results and the final UI tree.`,
  {
    steps: z
      .array(ActionStepSchema)
      .min(1)
      .describe('Ordered list of actions and assertions to execute'),
  },
  async ({ steps }) => {
    try {
      const result = await handleRunFlow(shell, steps, activeDeviceId);

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
      const result = await handleResetApp(shell, pkg, activeDeviceId);

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
