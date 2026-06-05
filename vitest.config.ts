import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Barrel file — no logic, just re-exports; excluded from per-file enforcement.
      exclude: ['src/index.ts'],
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
