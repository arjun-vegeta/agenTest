import { DIFF_THRESHOLDS, IDLE_LOADING, LOADING_INDICATORS, TIMEOUTS } from '../constants.js';
import { IdleTimeoutError } from '../errors.js';
import type { UnifiedUINode } from '../types.js';
import type { DeviceClient } from './device-client.js';
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
  /** Whether to wait for loading indicators to disappear after tree stabilizes */
  waitForLoadingIndicators: boolean;
  /** Max extra time to wait for loading indicators (ms) */
  maxLoadingWaitMs: number;
}

const DEFAULT_IDLE_OPTIONS: IdleOptions = {
  timeoutMs: TIMEOUTS.IDLE_DETECTION_MS,
  pollIntervalMs: TIMEOUTS.IDLE_POLL_INTERVAL_MS,
  requiredStableCount: TIMEOUTS.IDLE_STABLE_COUNT,
  waitForLoadingIndicators: true,
  maxLoadingWaitMs: IDLE_LOADING.MAX_LOADING_WAIT_MS,
};

// ---------------------------------------------------------------------------
// Result type — tells callers what happened during idle detection
// ---------------------------------------------------------------------------

export interface IdleResult {
  tree: UnifiedUINode;
  /** Whether loading indicators were detected and waited out */
  loadingDetected: boolean;
  /** Description of what loading indicators were found (if any) */
  loadingDescription?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Poll the UI tree until it stabilizes AND loading indicators disappear.
 *
 * Phase 1: Poll until tree fingerprint is stable (2 consecutive matches).
 * Phase 2: If stable tree contains loading indicators (ProgressBar, shimmer, etc.),
 *          keep polling until they disappear or maxLoadingWaitMs is exceeded.
 */
export async function waitForIdle(
  adb: DeviceClient,
  options?: Partial<IdleOptions>,
): Promise<IdleResult> {
  const opts = { ...DEFAULT_IDLE_OPTIONS, ...options };
  const startTime = Date.now();
  let previousFingerprint: string | null = null;
  let stableCount = 0;
  let lastTree: UnifiedUINode | null = null;

  // Phase 1: Wait for tree to stabilize
  while (Date.now() - startTime < opts.timeoutMs) {
    const xml = await adb.dumpUiTree();
    const tree = parseUiAutomatorXml(xml);
    const fingerprint = computeFingerprint(tree);

    if (previousFingerprint !== null && fingerprint === previousFingerprint) {
      stableCount++;
      if (stableCount >= opts.requiredStableCount) {
        lastTree = tree;
        break;
      }
    } else {
      stableCount = 0;
    }

    previousFingerprint = fingerprint;
    lastTree = tree;
    await sleep(opts.pollIntervalMs);
  }

  if (!lastTree) {
    throw new IdleTimeoutError(opts.timeoutMs);
  }

  // Phase 2: If loading indicators present, wait for them to disappear
  if (opts.waitForLoadingIndicators) {
    const loadingResult = await waitForLoadingToFinish(adb, lastTree, opts);
    return loadingResult;
  }

  return { tree: lastTree, loadingDetected: false };
}

/**
 * Take a single snapshot without waiting for idle.
 */
export async function snapshotTree(adb: DeviceClient): Promise<UnifiedUINode> {
  const xml = await adb.dumpUiTree();
  return parseUiAutomatorXml(xml);
}

// ---------------------------------------------------------------------------
// Loading indicator detection
// ---------------------------------------------------------------------------

/**
 * Check if a tree contains any loading indicators (spinners, progress bars,
 * shimmer layouts, skeleton screens, "loading..." text).
 */
export function detectLoadingIndicators(root: UnifiedUINode): string[] {
  const found: string[] = [];
  collectLoadingIndicators(root, found);
  return found;
}

/**
 * Check if a node is actually visible on screen.
 * React Native apps often have ProgressBar-like components in the tree
 * that are zero-sized, disabled, or off-screen — not real spinners.
 */
function isVisibleIndicator(node: UnifiedUINode): boolean {
  const width = node.bounds.right - node.bounds.left;
  const height = node.bounds.bottom - node.bounds.top;

  // Zero or negative size — hidden/collapsed
  if (width <= 0 || height <= 0) return false;

  // Very small (< 5x5 px) — likely hidden
  if (width < 5 || height < 5) return false;

  // Completely off-screen
  if (node.bounds.right <= 0 || node.bounds.bottom <= 0) return false;

  // Disabled elements are often decorative
  if (!node.enabled) return false;

  return true;
}

function collectLoadingIndicators(node: UnifiedUINode, results: string[]): void {
  // Only consider nodes that are actually visible on screen
  if (isVisibleIndicator(node)) {
    // Check class name exact match
    if (LOADING_INDICATORS.CLASS_NAMES.includes(node.className)) {
      results.push(`${node.className} at [${node.bounds.left},${node.bounds.top}]`);
    }

    // Check class name fragments
    if (
      !LOADING_INDICATORS.CLASS_NAMES.includes(node.className) &&
      LOADING_INDICATORS.CLASS_FRAGMENTS.some((f) => node.className.includes(f))
    ) {
      results.push(`${node.className} at [${node.bounds.left},${node.bounds.top}]`);
    }

    // Check text patterns
    if (node.text) {
      for (const pattern of LOADING_INDICATORS.TEXT_PATTERNS) {
        if (pattern.test(node.text)) {
          results.push(`text "${node.text}" at [${node.bounds.left},${node.bounds.top}]`);
          break;
        }
      }
    }

    // Check description patterns
    if (node.description) {
      for (const pattern of LOADING_INDICATORS.DESC_PATTERNS) {
        if (pattern.test(node.description)) {
          results.push(`desc "${node.description}" at [${node.bounds.left},${node.bounds.top}]`);
          break;
        }
      }
    }
  }

  for (const child of node.children) {
    collectLoadingIndicators(child, results);
  }
}

/**
 * After tree stabilizes, if loading indicators are present, keep polling
 * until they disappear or timeout.
 */
async function waitForLoadingToFinish(
  adb: DeviceClient,
  stableTree: UnifiedUINode,
  opts: IdleOptions,
): Promise<IdleResult> {
  const indicators = detectLoadingIndicators(stableTree);

  if (indicators.length === 0) {
    return { tree: stableTree, loadingDetected: false };
  }

  const description = indicators.join(', ');
  const loadingStartTime = Date.now();

  // Poll until loading indicators disappear
  while (Date.now() - loadingStartTime < opts.maxLoadingWaitMs) {
    await sleep(IDLE_LOADING.LOADING_POLL_INTERVAL_MS);

    const xml = await adb.dumpUiTree();
    const tree = parseUiAutomatorXml(xml);
    const currentIndicators = detectLoadingIndicators(tree);

    if (currentIndicators.length === 0) {
      // Loading finished — do one more stability check
      await sleep(opts.pollIntervalMs);
      const finalXml = await adb.dumpUiTree();
      const finalTree = parseUiAutomatorXml(finalXml);

      return {
        tree: finalTree,
        loadingDetected: true,
        loadingDescription: `Waited for: ${description}`,
      };
    }
  }

  // Timeout — loading indicators still present, return whatever we have
  const xml = await adb.dumpUiTree();
  const finalTree = parseUiAutomatorXml(xml);
  return {
    tree: finalTree,
    loadingDetected: true,
    loadingDescription: `Timed out waiting for: ${description}`,
  };
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
