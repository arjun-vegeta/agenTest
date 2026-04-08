import { SCROLL_TO, SWIPE_OFFSETS, TIMEOUTS } from '../constants.js';
import { ElementNotFoundError } from '../errors.js';
import type { ActionStep, Bounds, ElementSelector, UnifiedUINode } from '../types.js';
import type { AdbClient } from './adb.js';
import { snapshotTree } from './idle.js';
import { findElements } from './tree-parser.js';

// ---------------------------------------------------------------------------
// Resolve a selector to a single element's center point
// ---------------------------------------------------------------------------

export function resolveTarget(tree: UnifiedUINode, selector: ElementSelector): UnifiedUINode {
  const matches = findElements(tree, selector);

  if (matches.length === 0) {
    throw new ElementNotFoundError(
      `No element found matching selector: ${JSON.stringify(selector)}`,
      selector,
    );
  }

  // findElements already handles the index filter, so take the first match
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
// Compute swipe coordinates from direction + optional target
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
// Execute a single action step
// ---------------------------------------------------------------------------

export async function executeAction(
  adb: AdbClient,
  tree: UnifiedUINode,
  step: ActionStep,
  screenBounds: Bounds,
): Promise<void> {
  switch (step.action) {
    case 'tap': {
      const element = resolveTarget(tree, step.target);
      await adb.tap(element.center.x, element.center.y);
      break;
    }

    case 'type': {
      const element = resolveTarget(tree, step.target);
      // Tap the field first to focus it
      await adb.tap(element.center.x, element.center.y);
      await adb.type(step.value);
      break;
    }

    case 'swipe': {
      const bounds = step.target ? resolveTarget(tree, step.target).bounds : screenBounds;
      const coords = computeSwipeCoords(step.direction, bounds);
      const duration = step.durationMs ?? TIMEOUTS.SWIPE_DURATION_MS;
      await adb.swipe(coords.x1, coords.y1, coords.x2, coords.y2, duration);
      break;
    }

    case 'long_press': {
      const element = resolveTarget(tree, step.target);
      const duration = step.durationMs ?? TIMEOUTS.LONG_PRESS_DURATION_MS;
      await adb.longPress(element.center.x, element.center.y, duration);
      break;
    }

    case 'press_key': {
      await adb.keyEvent(step.keycode);
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
        ? resolveTarget(tree, step.scrollTarget).bounds
        : screenBounds;

      for (let i = 0; i < maxScrolls; i++) {
        // Check if target is already visible
        const currentTree = await snapshotTree(adb);
        const matches = findElements(currentTree, step.target);
        if (matches.length > 0) {
          return; // Found it
        }

        // Swipe to scroll
        const coords = computeSwipeCoords(direction, scrollBounds);
        const duration = TIMEOUTS.SWIPE_DURATION_MS;
        await adb.swipe(coords.x1, coords.y1, coords.x2, coords.y2, duration);
        await sleep(SCROLL_TO.SCROLL_SETTLE_MS);
      }

      // Final check after all scrolls
      const finalTree = await snapshotTree(adb);
      const finalMatches = findElements(finalTree, step.target);
      if (finalMatches.length === 0) {
        throw new ElementNotFoundError(
          `Element not found after ${maxScrolls} scroll attempts: ${JSON.stringify(step.target)}`,
          step.target,
        );
      }
      break;
    }

    // Assertions are handled separately in run-flow
    case 'assert_visible':
    case 'assert_not_visible':
    case 'assert_text_equals':
    case 'assert_text_contains':
      break;
  }
}

// ---------------------------------------------------------------------------
// Check an assertion step against the current UI tree
// ---------------------------------------------------------------------------

export interface AssertionResult {
  passed: boolean;
  message: string;
}

export function checkAssertion(tree: UnifiedUINode, step: ActionStep): AssertionResult {
  switch (step.action) {
    case 'assert_visible': {
      const matches = findElements(tree, step.target);
      const first = matches[0];
      return {
        passed: matches.length > 0,
        message: first
          ? `Element found: ${describeElement(first)}`
          : `Element not found matching: ${JSON.stringify(step.target)}`,
      };
    }

    case 'assert_not_visible': {
      const matches = findElements(tree, step.target);
      const first = matches[0];
      return {
        passed: matches.length === 0,
        message: !first
          ? 'Element correctly not present'
          : `Element unexpectedly found: ${describeElement(first)}`,
      };
    }

    case 'assert_text_equals': {
      const matches = findElements(tree, step.target);
      const first = matches[0];
      if (!first) {
        return {
          passed: false,
          message: `Element not found matching: ${JSON.stringify(step.target)}`,
        };
      }
      const actual = first.text;
      return {
        passed: actual === step.value,
        message:
          actual === step.value
            ? `Text matches: "${step.value}"`
            : `Expected text "${step.value}" but got "${actual}"`,
      };
    }

    case 'assert_text_contains': {
      const matches = findElements(tree, step.target);
      const first = matches[0];
      if (!first) {
        return {
          passed: false,
          message: `Element not found matching: ${JSON.stringify(step.target)}`,
        };
      }
      const actual = first.text;
      return {
        passed: actual.includes(step.value),
        message: actual.includes(step.value)
          ? `Text contains: "${step.value}"`
          : `Expected text to contain "${step.value}" but got "${actual}"`,
      };
    }

    default:
      // Non-assertion steps always pass
      return { passed: true, message: 'Not an assertion' };
  }
}

function describeElement(node: UnifiedUINode): string {
  const parts: string[] = [node.role];
  if (node.resourceId) parts.push(`id="${node.resourceId}"`);
  if (node.text) parts.push(`text="${node.text}"`);
  return parts.join(' ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
