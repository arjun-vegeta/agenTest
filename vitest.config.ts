import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude git worktrees so we don't end up running every test twice
    // when a branch is checked out under .claude/worktrees/*.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/worktrees/**'],
    // Run tests against the unit-tested handlers without spinning up the
    // Phase 3 on-device helper. The helper requires an actual emulator and
    // a real adb binary; tests use MockShellExecutor instead.
    env: {
      AGENTEST_DISABLE_HELPER: '1',
      // Phase 3.6 fiber inference — disabled in unit tests so handleConnect
      // doesn't accidentally fire the CDP Runtime.evaluate calls against a
      // real Hermes instance that happens to be running on the host
      // machine (common during dev when the user has an emulator + Metro
      // up). Tests that specifically exercise the fiber merger pass
      // `externalLabels` directly to `serializeTreeCompact` / `registry.rebuild`.
      AGENTEST_DISABLE_FIBER_INFERENCE: '1',
    },
  },
});
