import { IDLE_LOADING, LIGHTWEIGHT_ACTIONS, SYSTEM_PACKAGES } from '../constants.js';
import { DeviceClient } from '../android/device-client.js';
import type { FrameworkSync } from '../android/framework-sync.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { HelperClient } from '../android/helper-client.js';
import { snapshotTree, waitForIdle } from '../android/idle.js';
import { checkAssertion, executeAction, resolveTarget } from '../android/input.js';
import type { RefRegistry } from '../android/ref-registry.js';
import { WdaClient } from '../ios/wda-client.js';
import { snapshotIosTree, waitForIosIdle } from '../ios/idle.js';
import { detectIosSystemDialogs, executeIosAction } from '../ios/input.js';
import type {
  ActionStep,
  Bounds,
  ElementSelector,
  FlowTrace,
  Platform,
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
 *
 * Skips the check for assertion steps entirely: assert_not_visible's whole
 * purpose is to pass when the target is absent, assert_visible reports
 * its own "not found" result, and assert_text_* handle missing targets
 * gracefully too. Pre-validation is only useful for tap/type/swipe
 * actions where a missing target means the LLM has a stale plan.
 */
function canExecuteNextStep(
  tree: UnifiedUINode,
  step: ActionStep,
  registry?: RefRegistry,
): boolean {
  if (isAssertionStep(step)) return true;
  const target = getStepTarget(step);
  if (!target) return true;
  try {
    resolveTarget(tree, target, registry);
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
  helperClient?: HelperClient,
  frameworkSync?: FrameworkSync,
  registry?: RefRegistry,
  platform?: Platform,
  wdaPort?: number,
  packageName?: string,
): Promise<FlowTrace> {
  if (platform === 'ios') {
    if (!wdaPort) {
      throw new Error('wdaPort is required when platform is ios');
    }
    return handleIosRunFlow(new WdaClient(wdaPort), steps, packageName ?? '');
  }

  const device = new DeviceClient(shell, deviceId, grpcClient, false, helperClient, frameworkSync);
  const results: StepResult[] = [];
  const detectedDialogs: SystemDialog[] = [];

  // Fetch fiber labels for the current tree (Phase 3.6). Cached by
  // fingerprint inside FrameworkSync, so repeated calls on the same
  // screen are cheap. Silent no-op when no Hermes backend.
  const fetchLabels = async (tree: UnifiedUINode): Promise<Map<string, string>> => {
    if (!frameworkSync) return new Map();
    return frameworkSync.snapshotFiberLabels(tree);
  };

  // Rebuild helper: fetches fiber labels + rebuilds the registry. Used
  // after every tree snapshot to keep refs in sync.
  const rebuildRegistry = async (tree: UnifiedUINode) => {
    const externalLabels = await fetchLabels(tree);
    return registry?.rebuild(tree, { externalLabels });
  };

  // Get initial tree to determine screen bounds and provide context for actions
  let currentTree = await snapshotTree(device);
  const screenBounds: Bounds =
    currentTree.bounds.right > 0 ? currentTree.bounds : DEFAULT_SCREEN_BOUNDS;

  // Capture the target package for crash detection
  const targetPackage = currentTree.packageName;

  // Build initial registry snapshot — captures fingerprint + refs + fiber labels
  const initialResult = await rebuildRegistry(currentTree);
  const initialFingerprint = initialResult?.fingerprint ?? '';

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
        await rebuildRegistry(currentTree);
        const assertionResult = checkAssertion(currentTree, step, registry);

        results.push({
          stepIndex: i,
          action: step,
          success: assertionResult.passed,
          durationMs: Date.now() - stepStart,
          error: assertionResult.passed ? undefined : assertionResult.message,
        });

        // Stop on first assertion failure
        if (!assertionResult.passed) {
          const finalResult = await rebuildRegistry(currentTree);
          const finalFingerprint = finalResult?.fingerprint ?? '';
          return {
            success: false,
            stepsCompleted: i,
            totalSteps: steps.length,
            results,
            screenFingerprint: finalFingerprint,
            screenChanged: finalFingerprint !== initialFingerprint,
            finalUiTree: finalResult?.text,
            error: assertionResult.message,
            systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
          };
        }
      } else if (step.action === 'wait') {
        // Wait steps sleep then re-snapshot the tree so finalUiTree reflects post-wait state
        await executeAction(device, currentTree, step, screenBounds, registry);
        currentTree = await snapshotTree(device);
        await rebuildRegistry(currentTree);

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
        await rebuildRegistry(currentTree);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
          loadingCompleted: idleResult.loadingDescription,
        });
      } else if (isScrollToStep(step)) {
        // scroll_to handles its own idle/snapshot loop internally
        await executeAction(device, currentTree, step, screenBounds, registry);
        currentTree = await snapshotTree(device);
        await rebuildRegistry(currentTree);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else if (LIGHTWEIGHT_ACTIONS.includes(step.action)) {
        // Lightweight action — single snapshot, no idle polling (faster)
        await executeAction(device, currentTree, step, screenBounds, registry);
        currentTree = await snapshotTree(device);
        await rebuildRegistry(currentTree);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else {
        // Heavy action (tap, swipe, etc.) — full idle detection with loading awareness
        await executeAction(device, currentTree, step, screenBounds, registry);
        const idleResult = await waitForIdle(device);
        currentTree = idleResult.tree;
        await rebuildRegistry(currentTree);

        // Check for app crash (root package changed to system package)
        if (detectAppCrash(currentTree, targetPackage)) {
          const finalResult = await rebuildRegistry(currentTree);
          const finalFingerprint = finalResult?.fingerprint ?? '';
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
            screenFingerprint: finalFingerprint,
            screenChanged: true,
            finalUiTree: finalResult?.text,
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

      const finalResult = await rebuildRegistry(currentTree);
      const finalFingerprint = finalResult?.fingerprint ?? '';
      return {
        success: false,
        stepsCompleted: i,
        totalSteps: steps.length,
        results,
        screenFingerprint: finalFingerprint,
        screenChanged: finalFingerprint !== initialFingerprint,
        finalUiTree: finalResult?.text,
        error: `Step ${i} (${step.action}) failed: ${errorMessage}`,
        systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
      };
    }

    // Pre-validate: if the next step has a target, check if it exists now.
    // If the screen changed (e.g., app auto-navigated), fail fast instead of
    // wasting time on idle detection for a stale target.
    const nextStep = steps[i + 1];
    if (nextStep && !canExecuteNextStep(currentTree, nextStep, registry)) {
      const finalResult = await rebuildRegistry(currentTree);
      const finalFingerprint = finalResult?.fingerprint ?? '';
      return {
        success: false,
        stepsCompleted: i + 1,
        totalSteps: steps.length,
        results,
        screenFingerprint: finalFingerprint,
        screenChanged: finalFingerprint !== initialFingerprint,
        finalUiTree: finalResult?.text,
        error: `Screen changed after step ${i} (${step.action}): target for step ${i + 1} (${nextStep.action}) no longer exists. The previous action may have triggered a navigation.`,
        systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
      };
    }
  }

  // All steps passed — compute final fingerprint
  const finalResult = await rebuildRegistry(currentTree);
  const finalFingerprint = finalResult?.fingerprint ?? '';
  const screenChanged = finalFingerprint !== initialFingerprint;

  return {
    success: true,
    stepsCompleted: steps.length,
    totalSteps: steps.length,
    results,
    screenFingerprint: finalFingerprint,
    screenChanged,
    // Only include the tree when the screen changed — if nothing changed and
    // all steps passed, saving the tokens is the whole point of this work.
    finalUiTree: screenChanged ? finalResult?.text : undefined,
    systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
  };
}

// ---------------------------------------------------------------------------
// iOS run-flow implementation
// ---------------------------------------------------------------------------

/**
 * Execute a batch of ActionSteps against an iOS Simulator via WDA.
 * Mirrors the Android handleRunFlow structure but uses WdaClient for all
 * device interaction. No gRPC, no helper APK, no frameworkSync.
 */
async function handleIosRunFlow(
  client: WdaClient,
  steps: ActionStep[],
  packageName: string,
): Promise<FlowTrace> {
  const results: StepResult[] = [];
  const detectedDialogs: SystemDialog[] = [];

  const DEFAULT_IOS_SCREEN_BOUNDS: Bounds = {
    left: 0,
    top: 0,
    right: 390,
    bottom: 844,
  };

  // Get initial tree for screen bounds + context
  let currentTree = await snapshotIosTree(client, packageName);
  const screenBounds: Bounds =
    currentTree.bounds.right > 0 ? currentTree.bounds : DEFAULT_IOS_SCREEN_BOUNDS;

  const initialFingerprint = buildFingerprint(currentTree);

  // Check for alerts on the initial screen
  const initialDialogs = await detectIosSystemDialogs(client);
  detectedDialogs.push(...initialDialogs);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const stepStart = Date.now();

    try {
      if (isAssertionStep(step)) {
        currentTree = await snapshotIosTree(client, packageName);
        const assertionResult = checkAssertion(currentTree, step);

        results.push({
          stepIndex: i,
          action: step,
          success: assertionResult.passed,
          durationMs: Date.now() - stepStart,
          error: assertionResult.passed ? undefined : assertionResult.message,
        });

        if (!assertionResult.passed) {
          return {
            success: false,
            stepsCompleted: i,
            totalSteps: steps.length,
            results,
            screenFingerprint: buildFingerprint(currentTree),
            screenChanged: buildFingerprint(currentTree) !== initialFingerprint,
            error: assertionResult.message,
            systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
          };
        }
      } else if (step.action === 'wait') {
        await executeIosAction(client, currentTree, step, screenBounds, packageName);
        currentTree = await snapshotIosTree(client, packageName);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else if (step.action === 'wait_for_stable') {
        const timeout = step.timeoutMs;
        const idleResult = await waitForIosIdle(client, packageName, { timeoutMs: timeout });
        currentTree = idleResult.tree;

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else if (isScrollToStep(step)) {
        await executeIosAction(client, currentTree, step, screenBounds, packageName);
        currentTree = await snapshotIosTree(client, packageName);

        results.push({
          stepIndex: i,
          action: step,
          success: true,
          durationMs: Date.now() - stepStart,
        });
      } else {
        // Heavy action — inject gesture then wait for idle
        await executeIosAction(client, currentTree, step, screenBounds, packageName);
        const idleResult = await waitForIosIdle(client, packageName);
        currentTree = idleResult.tree;

        // Check for system alerts after each action
        const dialogs = await detectIosSystemDialogs(client);
        detectedDialogs.push(...dialogs);

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

      try {
        currentTree = await snapshotIosTree(client, packageName);
      } catch {
        // Use stale tree if snapshot fails
      }

      return {
        success: false,
        stepsCompleted: i,
        totalSteps: steps.length,
        results,
        screenFingerprint: buildFingerprint(currentTree),
        screenChanged: buildFingerprint(currentTree) !== initialFingerprint,
        error: `Step ${i} (${step.action}) failed: ${errorMessage}`,
        systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
      };
    }
  }

  const finalFingerprint = buildFingerprint(currentTree);
  const screenChanged = finalFingerprint !== initialFingerprint;

  return {
    success: true,
    stepsCompleted: steps.length,
    totalSteps: steps.length,
    results,
    screenFingerprint: finalFingerprint,
    screenChanged,
    systemDialogs: detectedDialogs.length > 0 ? detectedDialogs : undefined,
  };
}

function buildFingerprint(tree: UnifiedUINode): string {
  // Simple fingerprint: role+text of visible leaves — same idea as computeIdleFingerprint
  const parts: string[] = [];
  collectParts(tree, parts);
  return parts.slice(0, 20).join('|');
}

function collectParts(node: UnifiedUINode, parts: string[]): void {
  if (node.text) {
    parts.push(`${node.role}:${node.text}`);
  }
  for (const child of node.children) {
    collectParts(child, parts);
  }
}
