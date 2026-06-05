import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // Generate the JSON Schema artifact after each build.
  // Runs as a separate process to avoid Node.js module-cache interference
  // between consecutive builds (watch mode and CI alike).
  onSuccess: 'node scripts/generate-schema.mjs',
});
