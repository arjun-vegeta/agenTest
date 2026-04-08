import { AdbClient } from '../android/adb.js';
import { snapshotTree, waitForIdle } from '../android/idle.js';
import { checkAssertion, executeAction } from '../android/input.js';
import { serializeTreeForLlm } from '../android/tree-parser.js';
import type { ActionStep, Bounds, FlowTrace, ShellExecutor, StepResult } from '../types.js';

// Default screen bounds (1080x1920) — used for screen-level swipes
// when we can't determine actual screen size from the tree root
const DEFAULT_SCREEN_BOUNDS: Bounds = {
  left: 0,
  top: 0,
  right: 1080,
  bottom: 1920,
};

function isAssertionStep(step: ActionStep): boolean {
  return step.action.startsWith('assert_');
}

export async function handleRunFlow(
  shell: ShellExecutor,
  steps: ActionStep[],
  deviceId?: string,
): Promise<FlowTrace> {
  const adb = new AdbClient(shell, deviceId);
  const results: StepResult[] = [];

  // Get initial tree to determine screen bounds and provide context for actions
  let currentTree = await snapshotTree(adb);
  const screenBounds: Bounds =
    currentTree.bounds.right > 0 ? currentTree.bounds : DEFAULT_SCREEN_BOUNDS;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const stepStart = Date.now();

    try {
      if (isAssertionStep(step)) {
        // For assertions, re-read the tree to get fresh state
        currentTree = await snapshotTree(adb);
        const assertionResult = checkAssertion(currentTree, step);

        results.push({
          stepIndex: i,
          action: step,
          success: assertionResult.passed,
          durationMs: Date.now() - stepStart,
          error: assertionResult.passed ? undefined : assertionResult.message,
        });

        // Stop on first assertion failure
        if (!assertionResult.passed) {
          return {
            success: false,
            stepsCompleted: i,
            totalSteps: steps.length,
            results,
            finalUiTree: serializeTreeForLlm(currentTree),
            error: assertionResult.message,
          };
        }
      } else if (step.action === 'wait') {
        // Wait steps just sleep — no tree interaction needed
        await executeAction(adb, currentTree, step, screenBounds);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else {
        // Action step — execute then wait for idle
        await executeAction(adb, currentTree, step, screenBounds);
        currentTree = await waitForIdle(adb);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      results.push({
        stepIndex: i,
        action: step,
        success: false,
        durationMs: Date.now() - stepStart,
        error: errorMessage,
      });

      // Try to get the current tree for debugging, even on failure
      try {
        currentTree = await snapshotTree(adb);
      } catch {
        // If we can't even snapshot, use whatever we had
      }

      return {
        success: false,
        stepsCompleted: i,
        totalSteps: steps.length,
        results,
        finalUiTree: serializeTreeForLlm(currentTree),
        error: `Step ${i} (${step.action}) failed: ${errorMessage}`,
      };
    }
  }

  // All steps passed
  return {
    success: true,
    stepsCompleted: steps.length,
    totalSteps: steps.length,
    results,
    finalUiTree: serializeTreeForLlm(currentTree),
  };
}
