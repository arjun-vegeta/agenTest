import { IDLE_LOADING, LIGHTWEIGHT_ACTIONS, SYSTEM_PACKAGES } from '../constants.js';
import { DeviceClient } from '../android/device-client.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import { snapshotTree, waitForIdle } from '../android/idle.js';
import { checkAssertion, executeAction, resolveTarget } from '../android/input.js';
import { serializeTreeForLlm } from '../android/tree-parser.js';
import type {
  ActionStep,
  Bounds,
  ElementSelector,
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

/**
 * Extract the target selector from a step, if it has one.
 * Steps like tap_coordinates, press_key, wait have no target.
 */
function getStepTarget(step: ActionStep): ElementSelector | undefined {
  if ('target' in step && step.target) {
    return step.target as ElementSelector;
  }
  return undefined;
}

/**
 * Pre-validate: check if the next step's target exists in the current tree.
 * Returns true if the target is found or the step has no target.
 * Returns false if the step has a target that doesn't exist — screen likely changed.
 */
function canExecuteNextStep(tree: UnifiedUINode, step: ActionStep): boolean {
  const target = getStepTarget(step);
  if (!target) return true;
  try {
    resolveTarget(tree, target);
    return true;
  } catch {
    return false;
  }
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
  grpcClient?: GrpcEmulatorClient,
): Promise<FlowTrace> {
  const device = new DeviceClient(shell, deviceId, grpcClient);
  const results: StepResult[] = [];
  const detectedDialogs: SystemDialog[] = [];

  // Get initial tree to determine screen bounds and provide context for actions
  let currentTree = await snapshotTree(device);
  const screenBounds: Bounds =
    currentTree.bounds.right > 0 ? currentTree.bounds : DEFAULT_SCREEN_BOUNDS;

  // Capture the target package for crash detection
  const targetPackage = currentTree.packageName;

  // Check for system dialogs on the initial screen
  const initialDialogs = await device.detectSystemDialogs(currentTree);
  detectedDialogs.push(...initialDialogs);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const stepStart = Date.now();

    try {
      if (isAssertionStep(step)) {
        // For assertions, re-read the tree to get fresh state
        currentTree = await snapshotTree(device);
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
        await executeAction(device, currentTree, step, screenBounds);
        currentTree = await snapshotTree(device);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else if (step.action === 'wait_for_stable') {
        // Smart wait: polls tree until stable AND loading indicators disappear
        const timeout = step.timeoutMs ?? IDLE_LOADING.MAX_LOADING_WAIT_MS;
        const idleResult = await waitForIdle(device, {
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
          loadingCompleted: idleResult.loadingDescription,
        });
      } else if (isScrollToStep(step)) {
        // scroll_to handles its own idle/snapshot loop internally
        await executeAction(device, currentTree, step, screenBounds);
        currentTree = await snapshotTree(device);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else if (LIGHTWEIGHT_ACTIONS.includes(step.action)) {
        // Lightweight action — single snapshot, no idle polling (faster)
        await executeAction(device, currentTree, step, screenBounds);
        currentTree = await snapshotTree(device);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else {
        // Heavy action (tap, swipe, etc.) — full idle detection with loading awareness
        await executeAction(device, currentTree, step, screenBounds);
        const idleResult = await waitForIdle(device);
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
        const dialogs = await device.detectSystemDialogs(currentTree);
        detectedDialogs.push(...dialogs);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
          loadingCompleted: idleResult.loadingDescription,
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
        currentTree = await snapshotTree(device);
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

    // Pre-validate: if the next step has a target, check if it exists now.
    // If the screen changed (e.g., app auto-navigated), fail fast instead of
    // wasting time on idle detection for a stale target.
    const nextStep = steps[i + 1];
    if (nextStep && !canExecuteNextStep(currentTree, nextStep)) {
      return {
        success: false,
        stepsCompleted: i + 1,
        totalSteps: steps.length,
        results,
        finalUiTree: serializeTreeForLlm(currentTree),
        error: `Screen changed after step ${i} (${step.action}): target for step ${i + 1} (${nextStep.action}) no longer exists. The previous action may have triggered a navigation.`,
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
