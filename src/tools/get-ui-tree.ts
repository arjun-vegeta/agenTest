import { DeviceClient } from '../android/device-client.js';
import type { FrameworkSync } from '../android/framework-sync.js';
import type { GrpcEmulatorClient } from '../android/grpc-client.js';
import type { HelperClient } from '../android/helper-client.js';
import { snapshotTree } from '../android/idle.js';
import type { RefRegistry } from '../android/ref-registry.js';
import { serializeTreeForLlm } from '../android/tree-parser.js';
import type { LlmTreeNode, ShellExecutor } from '../types.js';

export type GetUiTreeFormat = 'compact' | 'full';

export interface GetUiTreeOptions {
  format?: GetUiTreeFormat;
  depth?: number;
  onlyInteractive?: boolean;
}

export interface GetUiTreeResult {
  format: GetUiTreeFormat;
  fingerprint: string;
  refCount?: number;
  uiTree: string | LlmTreeNode;
}

export async function handleGetUiTree(
  shell: ShellExecutor,
  registry: RefRegistry,
  opts?: GetUiTreeOptions,
  deviceId?: string,
  grpcClient?: GrpcEmulatorClient,
  helperClient?: HelperClient,
  frameworkSync?: FrameworkSync,
): Promise<GetUiTreeResult> {
  const device = new DeviceClient(shell, deviceId, grpcClient, false, helperClient, frameworkSync);
  const tree = await snapshotTree(device);

  // Phase 3.6 — fetch fiber labels for unlabeled interactives when
  // Hermes is attached. Silent no-op otherwise.
  const fiberLabels = frameworkSync
    ? await frameworkSync.snapshotFiberLabels(tree)
    : new Map<string, string>();

  const format = opts?.format ?? 'compact';

  if (format === 'full') {
    // Legacy JSON tree format — rebuild registry for consistent fingerprints
    const result = registry.rebuild(tree, { externalLabels: fiberLabels });
    return {
      format: 'full',
      fingerprint: result.fingerprint,
      uiTree: serializeTreeForLlm(tree),
    };
  }

  // Compact format (default)
  const result = registry.rebuild(tree, {
    maxDepth: opts?.depth,
    onlyInteractive: opts?.onlyInteractive,
    externalLabels: fiberLabels,
  });

  return {
    format: 'compact',
    fingerprint: result.fingerprint,
    refCount: result.refCount,
    uiTree: result.text,
  };
}
