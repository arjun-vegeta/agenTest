import {
  DOUBLE_TAP,
  IOS_KEYCODES,
  IOS_WDA,
  SCROLL_TO,
  SWIPE_OFFSETS,
  TIMEOUTS,
} from '../constants.js';
import { ElementNotFoundError } from '../errors.js';
import type { ActionStep, Bounds, ElementSelector, SystemDialog, UnifiedUINode } from '../types.js';
import { findElements } from '../android/tree-parser.js';
import type { WdaClient } from './wda-client.js';
import { snapshotIosTree } from './idle.js';

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

interface SwipeCoordinates {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function computeSwipeCoords(
  direction: 'up' | 'down' | 'left' | 'right',
  bounds: Bounds,
): SwipeCoordinates {
  const centerX = Math.round((bounds.left + bounds.right) / 2);
  const centerY = Math.round((bounds.top + bounds.bottom) / 2);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const offsetX = Math.round((width * SWIPE_OFFSETS.DISTANCE_FRACTION) / 2);
  const offsetY = Math.round((height * SWIPE_OFFSETS.DISTANCE_FRACTION) / 2);

  switch (direction) {
    case 'up':
      return { x1: centerX, y1: centerY + offsetY, x2: centerX, y2: centerY - offsetY };
    case 'down':
      return { x1: centerX, y1: centerY - offsetY, x2: centerX, y2: centerY + offsetY };
    case 'left':
      return { x1: centerX + offsetX, y1: centerY, x2: centerX - offsetX, y2: centerY };
    case 'right':
      return { x1: centerX - offsetX, y1: centerY, x2: centerX + offsetX, y2: centerY };
  }
}

// ---------------------------------------------------------------------------
// Element resolution (shared with Android — delegates to findElements)
// ---------------------------------------------------------------------------

/**
 * Resolve a selector against a tree, returning the first matching node.
 * Throws ElementNotFoundError when nothing matches.
 */
export function resolveIosTarget(tree: UnifiedUINode, selector: ElementSelector): UnifiedUINode {
  const matches = findElements(tree, selector);
  const first = matches[0];
  if (!first) {
    throw new ElementNotFoundError(
      `No element found matching selector: ${JSON.stringify(selector)}`,
      selector,
    );
  }
  return first;
}

// ---------------------------------------------------------------------------
// Main action executor
// ---------------------------------------------------------------------------

/**
 * Execute a single ActionStep against an iOS Simulator via WDA.
 *
 * Mirrors `android/input.ts:executeAction` but calls WdaClient instead of
 * DeviceClient. All 18 action types are handled; assertion steps are no-ops
 * (handled by the run-flow orchestrator).
 */
export async function executeIosAction(
  client: WdaClient,
  tree: UnifiedUINode,
  step: ActionStep,
  screenBounds: Bounds,
  packageName: string,
): Promise<void> {
  switch (step.action) {
    case 'tap': {
      const element = resolveIosTarget(tree, step.target);
      await client.tap(element.center.x, element.center.y);
      break;
    }

    case 'tap_coordinates': {
      await client.tap(step.x, step.y);
      break;
    }

    case 'long_press_coordinates': {
      const duration = step.durationMs ?? TIMEOUTS.LONG_PRESS_DURATION_MS;
      await client.longPress(step.x, step.y, duration);
      break;
    }

    case 'type': {
      const element = resolveIosTarget(tree, step.target);
      // Tap to focus, settle for keyboard, then type
      await client.tap(element.center.x, element.center.y);
      await sleep(IOS_WDA.KEYBOARD_SETTLE_MS);
      await client.type(step.value);
      break;
    }

    case 'swipe': {
      const bounds = step.target ? resolveIosTarget(tree, step.target).bounds : screenBounds;
      const coords = computeSwipeCoords(step.direction, bounds);
      const duration = step.durationMs ?? TIMEOUTS.SWIPE_DURATION_MS;
      await client.swipe(coords.x1, coords.y1, coords.x2, coords.y2, duration);
      break;
    }

    case 'swipe_coordinates': {
      const duration = step.durationMs ?? TIMEOUTS.SWIPE_DURATION_MS;
      await client.swipe(step.x1, step.y1, step.x2, step.y2, duration);
      break;
    }

    case 'double_tap': {
      const element = resolveIosTarget(tree, step.target);
      await client.doubleTap(element.center.x, element.center.y);
      break;
    }

    case 'double_tap_coordinates': {
      // WDA natively supports doubleTap — no manual interval needed
      await client.doubleTap(step.x, step.y);
      break;
    }

    case 'clear_text': {
      const element = resolveIosTarget(tree, step.target);
      await client.clearText(element.center.x, element.center.y, IOS_WDA.TRIPLE_TAP_INTERVAL_MS);
      await sleep(IOS_WDA.CLEAR_TEXT_SETTLE_MS);
      break;
    }

    case 'long_press': {
      const element = resolveIosTarget(tree, step.target);
      const duration = step.durationMs ?? TIMEOUTS.LONG_PRESS_DURATION_MS;
      await client.longPress(element.center.x, element.center.y, duration);
      break;
    }

    case 'press_key': {
      // Map Android keycode names to WebDriver Unicode values where possible
      const wdaKey = IOS_KEYCODES[step.keycode] ?? step.keycode;
      await client.type(wdaKey);
      break;
    }

    case 'pinch': {
      const duration = step.durationMs ?? TIMEOUTS.PINCH_DURATION_MS;
      await client.pinch(step.cx, step.cy, step.startRadius, step.endRadius, duration);
      break;
    }

    case 'rotate': {
      const duration = step.durationMs ?? TIMEOUTS.ROTATE_DURATION_MS;
      await client.rotate(
        step.cx,
        step.cy,
        step.radius,
        step.startAngleDeg,
        step.endAngleDeg,
        duration,
      );
      break;
    }

    case 'wait': {
      await sleep(step.timeoutMs);
      break;
    }

    case 'scroll_to': {
      const direction = step.direction ?? 'down';
      const maxScrolls = step.maxScrolls ?? SCROLL_TO.MAX_SCROLLS;
      const scrollBounds = step.scrollTarget
        ? resolveIosTarget(tree, step.scrollTarget).bounds
        : screenBounds;

      for (let i = 0; i < maxScrolls; i++) {
        const currentTree = await snapshotIosTree(client, packageName);
        const matches = findElements(currentTree, step.target);
        if (matches.length > 0) {
          return; // Found it
        }

        const coords = computeSwipeCoords(direction, scrollBounds);
        await client.swipe(coords.x1, coords.y1, coords.x2, coords.y2, TIMEOUTS.SWIPE_DURATION_MS);
        await sleep(SCROLL_TO.SCROLL_SETTLE_MS);
      }

      // Final check after all scrolls
      const finalTree = await snapshotIosTree(client, packageName);
      const finalMatches = findElements(finalTree, step.target);
      if (finalMatches.length === 0) {
        throw new ElementNotFoundError(
          `Element not found after ${maxScrolls} scroll attempts: ${JSON.stringify(step.target)}`,
          step.target,
        );
      }
      break;
    }

    // Assertion steps are handled by the run-flow orchestrator
    case 'assert_visible':
    case 'assert_not_visible':
    case 'assert_text_equals':
    case 'assert_text_contains':
    case 'wait_for_stable':
      break;
  }
}

// ---------------------------------------------------------------------------
// System alert detection
// ---------------------------------------------------------------------------

/**
 * Query WDA for an active system alert and return it as a SystemDialog entry.
 * Returns an empty array when no alert is present.
 */
export async function detectIosSystemDialogs(client: WdaClient): Promise<SystemDialog[]> {
  const alertText = await client.getAlert();
  if (!alertText) {
    return [];
  }

  return [
    {
      title: alertText,
      buttons: ['Accept', 'Dismiss'],
      packageName: 'com.apple.springboard',
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export DOUBLE_TAP so dependents don't need a separate import
export { DOUBLE_TAP };
