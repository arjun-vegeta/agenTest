/**
 * RefRegistry — session-scoped map from short ref tokens (@b1, @f2, …) to
 * UnifiedUINode instances. Rebuilt on every tree snapshot so refs always
 * point at the live tree. Provides the `resolve(ref)` method consumed by
 * `resolveTarget` in `input.ts`.
 *
 * Lifecycle:
 *   - Created once per MCP session (in server.ts alongside activeDeviceId).
 *   - `rebuild(tree)` is called every time the tree is snapshotted.
 *   - `resolve(ref)` is called by `resolveTarget` when a selector has `ref`.
 *   - `clear()` is called on `agentest_connect` to drop stale refs from a
 *     previous app session.
 */
import { ElementNotFoundError } from '../errors.js';
import type { UnifiedUINode } from '../types.js';
import {
  type CompactSerializeOptions,
  type CompactSerializeResult,
  serializeTreeCompact,
} from './tree-parser.js';

export class RefRegistry {
  private refMap = new Map<string, UnifiedUINode>();
  private lastResult: CompactSerializeResult | null = null;

  /**
   * Rebuild the registry from a fresh tree. Walks the tree once via
   * `serializeTreeCompact` and caches the result. Call this every time the
   * tree changes (after snapshotTree, after idle, etc.).
   *
   * Returns the compact serialization result so callers that need the text
   * or fingerprint don't have to compute it again.
   */
  rebuild(
    tree: UnifiedUINode,
    opts?: CompactSerializeOptions,
  ): CompactSerializeResult {
    this.lastResult = serializeTreeCompact(tree, opts);
    this.refMap.clear();
    for (const [ref, node] of this.lastResult.refMap) {
      this.refMap.set(ref, node);
    }
    return this.lastResult;
  }

  /**
   * Look up a ref token. Throws `ElementNotFoundError` with an actionable
   * stale-ref message if the ref doesn't exist — tells the LLM to call
   * `agentest_get_ui_tree` for fresh refs instead of retrying blindly.
   *
   * Per concern #5: if ref is set, ref wins. No auto-fallback to other
   * selector fields. The LLM must re-snapshot to recover.
   */
  resolve(ref: string): UnifiedUINode {
    const node = this.refMap.get(ref);
    if (!node) {
      throw new ElementNotFoundError(
        `ref "${ref}" is stale — the screen changed since the last snapshot. ` +
          'Call agentest_get_ui_tree for fresh refs.',
        { ref },
      );
    }
    return node;
  }

  /** The 6-char screen fingerprint from the last rebuild. */
  get fingerprint(): string {
    return this.lastResult?.fingerprint ?? '';
  }

  /** The compact text output from the last rebuild. */
  get text(): string {
    return this.lastResult?.text ?? '';
  }

  /** Number of interactive elements that received refs in the last rebuild. */
  get size(): number {
    return this.refMap.size;
  }

  /** Drop all refs and cached state. Called on `agentest_connect`. */
  clear(): void {
    this.refMap.clear();
    this.lastResult = null;
  }
}
