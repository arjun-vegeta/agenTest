import { TIMEOUTS } from '../constants.js';
import { IdleTimeoutError } from '../errors.js';
import { computeIdleFingerprint } from '../android/tree-parser.js';
import type { UnifiedUINode } from '../types.js';
import type { WdaClient } from './wda-client.js';
import { parseWdaJsonTree } from './tree-parser.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface IosIdleOptions {
  /** Max time to wait for stability (ms) */
  timeoutMs: number;
  /** Interval between tree snapshots (ms) */
  pollIntervalMs: number;
  /** Consecutive stable snapshots required */
  requiredStableCount: number;
}

const DEFAULT_IOS_IDLE_OPTIONS: IosIdleOptions = {
  timeoutMs: TIMEOUTS.IDLE_DETECTION_MS,
  pollIntervalMs: TIMEOUTS.IDLE_POLL_INTERVAL_MS,
  requiredStableCount: TIMEOUTS.IDLE_STABLE_COUNT,
};

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface IosIdleResult {
  tree: UnifiedUINode;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a single tree snapshot from WDA without waiting for idle.
 */
export async function snapshotIosTree(
  client: WdaClient,
  packageName: string,
): Promise<UnifiedUINode> {
  const rawTree = await client.getSource();
  return parseWdaJsonTree(rawTree, packageName);
}

/**
 * Poll WDA until two consecutive tree snapshots have the same fingerprint,
 * then return the stable tree. Throws IdleTimeoutError if the UI never settles.
 */
export async function waitForIosIdle(
  client: WdaClient,
  packageName: string,
  options?: Partial<IosIdleOptions>,
): Promise<IosIdleResult> {
  const opts = { ...DEFAULT_IOS_IDLE_OPTIONS, ...options };
  const startTime = Date.now();
  let previousFingerprint: string | null = null;
  let stableCount = 0;
  let lastTree: UnifiedUINode | null = null;

  while (Date.now() - startTime < opts.timeoutMs) {
    const tree = await snapshotIosTree(client, packageName);
    const fingerprint = computeIdleFingerprint(tree);

    if (previousFingerprint !== null && fingerprint === previousFingerprint) {
      stableCount++;
      if (stableCount >= opts.requiredStableCount) {
        return { tree };
      }
    } else {
      stableCount = 0;
    }

    previousFingerprint = fingerprint;
    lastTree = tree;
    await sleep(opts.pollIntervalMs);
  }

  if (lastTree) {
    // Timed out but we have a snapshot — return it rather than crashing
    throw new IdleTimeoutError(opts.timeoutMs);
  }

  throw new IdleTimeoutError(opts.timeoutMs);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
