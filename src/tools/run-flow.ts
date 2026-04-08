import { IDLE_LOADING, LIGHTWEIGHT_ACTIONS, SYSTEM_PACKAGES } from '../constants.js';
import { AdbClient } from '../android/adb.js';
import { snapshotTree, waitForIdle } from '../android/idle.js';
import { checkAssertion, executeAction } from '../android/input.js';
import { serializeTreeForLlm } from '../android/tree-parser.js';
import type {
  ActionStep,
  Bounds,
  FlowTrace,
  ShellExecutor,
  StepResult,
  SystemDialog,
  UnifiedUINode,
} from '../types.js';

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

function isScrollToStep(step: ActionStep): boolean {
  return step.action === 'scroll_to';
}

function detectAppCrash(tree: UnifiedUINode, targetPackage: string): boolean {
  if (!targetPackage) return false;
  const currentPackage = tree.packageName;
  if (currentPackage === targetPackage) return false;
  // App crashed if root package changed to a system package
  return SYSTEM_PACKAGES.some((pkg) => currentPackage === pkg);
}

export async function handleRunFlow(
  shell: ShellExecutor,
  steps: ActionStep[],
  deviceId?: string,
): Promise<FlowTrace> {
  const adb = new AdbClient(shell, deviceId);
  const results: StepResult[] = [];
  const detectedDialogs: SystemDialog[] = [];

  // Get initial tree to determine screen bounds and provide context for actions
  let currentTree = await snapshotTree(adb);
  const screenBounds: Bounds =
    currentTree.bounds.right > 0 ? currentTree.bounds : DEFAULT_SCREEN_BOUNDS;

  // Capture the target package for crash detection
  const targetPackage = currentTree.packageName;

  // Check for system dialogs on the initial screen
  const initialDialogs = await adb.detectSystemDialogs(currentTree);
  detectedDialogs.push(...initialDialogs);

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
            systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
          };
        }
      } else if (step.action === 'wait') {
        // Wait steps sleep then re-snapshot the tree so finalUiTree reflects post-wait state
        await executeAction(adb, currentTree, step, screenBounds);
        currentTree = await snapshotTree(adb);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else if (step.action === 'wait_for_stable') {
        // Smart wait: polls tree until stable AND loading indicators disappear
        const timeout = step.timeoutMs ?? IDLE_LOADING.MAX_LOADING_WAIT_MS;
        const idleResult = await waitForIdle(adb, {
          timeoutMs: timeout,
          waitForLoadingIndicators: true,
          maxLoadingWaitMs: timeout,
        });
        currentTree = idleResult.tree;

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
          loadingDetected: idleResult.loadingDescription,
        });
      } else if (isScrollToStep(step)) {
        // scroll_to handles its own idle/snapshot loop internally
        await executeAction(adb, currentTree, step, screenBounds);
        currentTree = await snapshotTree(adb);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else if (LIGHTWEIGHT_ACTIONS.includes(step.action)) {
        // Lightweight action — single snapshot, no idle polling (faster)
        await executeAction(adb, currentTree, step, screenBounds);
        currentTree = await snapshotTree(adb);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else {
        // Heavy action (tap, swipe, etc.) — full idle detection with loading awareness
        await executeAction(adb, currentTree, step, screenBounds);
        const idleResult = await waitForIdle(adb);
        currentTree = idleResult.tree;

        // Check for app crash (root package changed to system package)
        if (detectAppCrash(currentTree, targetPackage)) {
          results.push({
            stepIndex: i,
            action: step,
            success: false,
            durationMs: Date.now() - stepStart,
            error: `App crashed — screen changed to ${currentTree.packageName}`,
          });
          return {
            success: false,
            stepsCompleted: i,
            totalSteps: steps.length,
            results,
            finalUiTree: serializeTreeForLlm(currentTree),
            error: `App crashed after step ${i} (${step.action}). Current package: ${currentTree.packageName}`,
            systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
            appCrashDetected: true,
          };
        }

        // Check for system dialogs after each action
        const dialogs = await adb.detectSystemDialogs(currentTree);
        detectedDialogs.push(...dialogs);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
          loadingDetected: idleResult.loadingDescription,
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
        systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
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
    systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
  };
}
