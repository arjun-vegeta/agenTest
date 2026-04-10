import { IDLE_LOADING, LOADING_INDICATORS, TIMEOUTS } from '../constants.js';
import { IdleTimeoutError } from '../errors.js';
import type { UnifiedUINode } from '../types.js';
import type { DeviceClient } from './device-client.js';
import { computeIdleFingerprint, parseUiAutomatorXml } from './tree-parser.js';

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
 * Wait for the UI to settle and return a fresh tree.
 *
 * Two execution paths:
 *
 *   FAST PATH (helper available):
 *     1. Call helper /wait-idle — pushes events from UiAutomation. Typical
 *        latency 150-300ms.
 *     2. Pull a fresh tree via helper /tree (still much faster than dump+cat).
 *     3. Run loading-indicator pass on the fresh tree.
 *
 *   POLLING PATH (helper unavailable):
 *     1. Poll uiautomator dump every 200ms.
 *     2. Fingerprint compare; declare stable when 2 consecutive snapshots
 *        match.
 *     3. Loading-indicator pass.
 *
 * The fast path is preferred whenever DeviceClient.hasHelper is true. It
 * collapses what was 1-2 seconds of polling into ~250ms.
 */
export async function waitForIdle(
  device: DeviceClient,
  options?: Partial<IdleOptions>,
): Promise<IdleResult> {
  const opts = { ...DEFAULT_IDLE_OPTIONS, ...options };

  if (device.hasHelper) {
    return waitForIdleFast(device, opts);
  }
  return waitForIdleByPolling(device, opts);
}

/**
 * Fast path: event-driven idle via the on-device helper, optionally
 * augmented by a framework-specific sync probe (Hermes CDP for React
 * Native, Dart VM Service for Flutter — see `framework-sync.ts`).
 */
async function waitForIdleFast(device: DeviceClient, opts: IdleOptions): Promise<IdleResult> {
  // Block on the helper's event-driven /wait-idle. If it returns false (no
  // helper / unhealthy / etc) fall back to polling.
  const idle = await device.waitForIdleViaHelper(opts.timeoutMs);
  if (!idle) {
    return waitForIdleByPolling(device, opts);
  }

  // Framework sync tail probe (Phase 3.9). Runs after the a11y-event idle
  // so it only adds latency when there's actual pending JS/Dart work. Any
  // failure is non-fatal — we treat the helper's idle signal as authoritative
  // and the framework sync as a best-effort augmentation.
  if (device.sync) {
    try {
      await device.sync.waitForSync();
    } catch {
      // ignore — helper idle already confirmed UI work is done
    }
  }

  // Always grab a fresh tree after the wait — UI may have changed since the
  // last event but before we polled.
  const tree = await snapshotTree(device);

  if (opts.waitForLoadingIndicators) {
    return waitForLoadingToFinish(device, tree, opts);
  }
  return { tree, loadingDetected: false };
}

/**
 * Polling path: legacy fingerprint-stability detection. Used when the
 * on-device helper isn't installed (gracefully degraded mode).
 */
async function waitForIdleByPolling(device: DeviceClient, opts: IdleOptions): Promise<IdleResult> {
  const startTime = Date.now();
  let previousFingerprint: string | null = null;
  let stableCount = 0;
  let lastTree: UnifiedUINode | null = null;

  while (Date.now() - startTime < opts.timeoutMs) {
    const tree = await snapshotTree(device);
    const fingerprint = computeIdleFingerprint(tree);

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

  if (opts.waitForLoadingIndicators) {
    return waitForLoadingToFinish(device, lastTree, opts);
  }
  return { tree: lastTree, loadingDetected: false };
}

/**
 * Take a single snapshot without waiting for idle. Prefers the helper's
 * /tree endpoint when available, falls back to ADB uiautomator dump.
 */
export async function snapshotTree(device: DeviceClient): Promise<UnifiedUINode> {
  const fast = await device.dumpUiTreeFast();
  if (fast) return fast;
  const xml = await device.dumpUiTree();
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
 * until they disappear or timeout. Uses helper-fast snapshots when available.
 */
async function waitForLoadingToFinish(
  device: DeviceClient,
  stableTree: UnifiedUINode,
  opts: IdleOptions,
): Promise<IdleResult> {
  const indicators = detectLoadingIndicators(stableTree);

  if (indicators.length === 0) {
    return { tree: stableTree, loadingDetected: false };
  }

  const description = indicators.join(', ');
  const loadingStartTime = Date.now();

  while (Date.now() - loadingStartTime < opts.maxLoadingWaitMs) {
    await sleep(IDLE_LOADING.LOADING_POLL_INTERVAL_MS);

    const tree = await snapshotTree(device);
    const currentIndicators = detectLoadingIndicators(tree);

    if (currentIndicators.length === 0) {
      // Loading finished — do one more stability check.
      await sleep(opts.pollIntervalMs);
      const finalTree = await snapshotTree(device);
      return {
        tree: finalTree,
        loadingDetected: true,
        loadingDescription: `Waited for: ${description}`,
      };
    }
  }

  // Timeout — loading indicators still present, return whatever we have.
  const finalTree = await snapshotTree(device);
  return {
    tree: finalTree,
    loadingDetected: true,
    loadingDescription: `Timed out waiting for: ${description}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
