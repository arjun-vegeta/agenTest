import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests against the unit-tested handlers without spinning up the
    // Phase 3 on-device helper. The helper requires an actual emulator and
    // a real adb binary; tests use MockShellExecutor instead.
    env: {
      LAZYTEST_DISABLE_HELPER: '1',
    },
  },
});
