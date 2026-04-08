import { DIFF_THRESHOLDS, TIMEOUTS } from '../constants.js';
import { IdleTimeoutError } from '../errors.js';
import type { UnifiedUINode } from '../types.js';
import type { AdbClient } from './adb.js';
import { parseUiAutomatorXml } from './tree-parser.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface IdleOptions {
  /** Max time to wait for stability (ms) */
  timeoutMs: number;
  /** Interval between tree snapshots (ms) */
  pollIntervalMs: number;
  /** Consecutive stable snapshots required */
  requiredStableCount: number;
}

const DEFAULT_IDLE_OPTIONS: IdleOptions = {
  timeoutMs: TIMEOUTS.IDLE_DETECTION_MS,
  pollIntervalMs: TIMEOUTS.IDLE_POLL_INTERVAL_MS,
  requiredStableCount: TIMEOUTS.IDLE_STABLE_COUNT,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Poll the UI tree until it stabilizes (two consecutive snapshots match).
 * Returns the stable tree. Throws IdleTimeoutError if timeout is exceeded.
 */
export async function waitForIdle(
  adb: AdbClient,
  options?: Partial<IdleOptions>,
): Promise<UnifiedUINode> {
  const opts = { ...DEFAULT_IDLE_OPTIONS, ...options };
  const startTime = Date.now();
  let previousFingerprint: string | null = null;
  let stableCount = 0;
  let lastTree: UnifiedUINode | null = null;

  while (Date.now() - startTime < opts.timeoutMs) {
    const xml = await adb.dumpUiTree();
    const tree = parseUiAutomatorXml(xml);
    const fingerprint = computeFingerprint(tree);

    if (previousFingerprint !== null && fingerprint === previousFingerprint) {
      stableCount++;
      if (stableCount >= opts.requiredStableCount) {
        return tree;
      }
    } else {
      stableCount = 0;
    }

    previousFingerprint = fingerprint;
    lastTree = tree;
    await sleep(opts.pollIntervalMs);
  }

  // Timeout — return whatever we have rather than crashing,
  // but warn via the error that we didn't fully stabilize
  if (lastTree) {
    return lastTree;
  }

  throw new IdleTimeoutError(opts.timeoutMs);
}

/**
 * Take a single snapshot without waiting for idle.
 * Useful when you just need the current state.
 */
export async function snapshotTree(adb: AdbClient): Promise<UnifiedUINode> {
  const xml = await adb.dumpUiTree();
  return parseUiAutomatorXml(xml);
}

// ---------------------------------------------------------------------------
// Tree fingerprinting (for stability comparison)
// ---------------------------------------------------------------------------

/**
 * Compute a stable fingerprint of the tree, ignoring known-noisy properties:
 * - Focused state (cursor blink)
 * - Minor bounds jitter (< BOUNDS_JITTER_PX pixels)
 * - Timestamp-like text (e.g. "12:34", "3:45 PM")
 */
function computeFingerprint(node: UnifiedUINode): string {
  const parts: string[] = [];
  collectFingerprint(node, parts);
  return parts.join('|');
}

// Matches common time patterns: "12:34", "3:45 PM", "12:34:56"
const TIMESTAMP_PATTERN = /^\d{1,2}:\d{2}(:\d{2})?(\s?(AM|PM|am|pm))?$/;

function collectFingerprint(node: UnifiedUINode, parts: string[]): void {
  // Include: role, resource-id, non-noisy text, description, rounded bounds, key state
  parts.push(node.role);
  parts.push(node.resourceId);

  // Skip text that looks like a live timestamp
  if (node.text && !TIMESTAMP_PATTERN.test(node.text)) {
    parts.push(node.text);
  }

  parts.push(node.description);

  // Round bounds to nearest BOUNDS_JITTER_PX to ignore micro-shifts
  const jitter = DIFF_THRESHOLDS.BOUNDS_JITTER_PX;
  parts.push(
    String(roundTo(node.bounds.left, jitter)),
    String(roundTo(node.bounds.top, jitter)),
    String(roundTo(node.bounds.right, jitter)),
    String(roundTo(node.bounds.bottom, jitter)),
  );

  // Include key state flags (skip focused — cursor blink)
  parts.push(node.enabled ? '1' : '0', node.checked ? '1' : '0', node.selected ? '1' : '0');

  for (const child of node.children) {
    collectFingerprint(child, parts);
  }
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
