import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts', 'src/cli-entry.ts'],
  format: ['esm', 'cjs'],
  // tsup injects a deprecated `baseUrl` into its dts compiler options; TS 6
  // errors on it (TS5101) unless deprecations are explicitly acknowledged.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // Generate the JSON Schema artifact after each build.
  // Runs as a separate process to avoid Node.js module-cache interference
  // between consecutive builds (watch mode and CI alike).
  onSuccess: 'node scripts/generate-schema.mjs',
});
