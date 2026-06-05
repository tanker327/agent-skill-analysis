import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Excluded from per-file enforcement:
      //   index.ts — barrel, no logic, just re-exports.
      //   cli-entry.ts — bin shim, no logic, just process wiring around
      //   runCli (cli.ts carries the testable CLI logic at 100%).
      exclude: ['src/index.ts', 'src/cli-entry.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
        // Enforce thresholds on every individual file, not just the aggregate.
        perFile: true,
        // When actual coverage exceeds a threshold, vitest bumps the config value
        // automatically (ratchet — only moves up, never down).
        autoUpdate: true,
      },
    },
  },
});
