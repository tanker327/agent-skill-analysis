/**
 * P6 property-based tests (fast-check) — the two universal invariants:
 *
 *   1. Never-throw: any SKILL.md content → analyze() always resolves (never rejects).
 *      Bad content produces diagnostics; the only allowed rejection is SkillSource IO.
 *
 *   2. Schema conformance: any file tree → output always passes SkillAnalysisSchema.
 *      analyze() guarantees a valid SkillAnalysis regardless of what's in the tree.
 *
 * Fixed seed (42) throughout: the test suite is deterministic — no random inputs in CI.
 * numRuns is conservative to keep the gate fast; increase locally to stress-test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { z } from 'zod';
import { analyze, fromFiles, SkillAnalysisSchema } from '../src/index.js';

const SCHEMA_ARTIFACT_PATH = resolve('dist/skill-analysis.schema.json');

// ── Property 1: never-throw ───────────────────────────────────────────────────

describe('never-throw property (fast-check, seed: 42)', () => {
  it('arbitrary SKILL.md string content → analyze() always resolves', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (content) => {
        const source = fromFiles({ 'SKILL.md': content });
        // Must resolve; must never throw or reject on content.
        const result = await analyze(source);
        expect(result).toBeDefined();
      }),
      { seed: 42, numRuns: 200 },
    );
  });

  it('SKILL.md with arbitrary frontmatter block → analyze() always resolves', async () => {
    // Wraps the arbitrary string in a frontmatter fence — exercises the full
    // YAML parse → normalize → validate → body chain with adversarial content.
    await fc.assert(
      fc.asyncProperty(fc.string(), async (yamlContent) => {
        const source = fromFiles({
          'SKILL.md': `---\n${yamlContent}\n---\n\nBody text.`,
        });
        const result = await analyze(source);
        expect(result).toBeDefined();
      }),
      { seed: 42, numRuns: 200 },
    );
  });
});

// ── Property 2: schema conformance ───────────────────────────────────────────

describe('schema conformance property (fast-check, seed: 42)', () => {
  it('arbitrary file tree → output always passes SkillAnalysisSchema', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          // Paths: at least 1 char so no empty-string keys.
          fc.string({ minLength: 1, maxLength: 200 }),
          // Content: arbitrary strings (fromFiles UTF-8 encodes them).
          fc.string({ maxLength: 2000 }),
          { maxKeys: 20 },
        ),
        async (fileMap) => {
          const source = fromFiles(fileMap);
          const result = await analyze(source);
          expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
        },
      ),
      { seed: 42, numRuns: 100 },
    );
  });

  it('arbitrary file tree with binary content → output always passes SkillAnalysisSchema', async () => {
    // Stress the binary-detection and sha256 paths with random Uint8Array content.
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.uint8Array({ maxLength: 500 }),
          { maxKeys: 10 },
        ),
        async (fileMap) => {
          const source = fromFiles(fileMap as Record<string, Uint8Array>);
          const result = await analyze(source);
          expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
        },
      ),
      { seed: 42, numRuns: 50 },
    );
  });

  it('ok is always a boolean (computed from post-override diagnostics)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 100 }), fc.string({ maxLength: 500 }), {
          maxKeys: 10,
        }),
        async (fileMap) => {
          const result = await analyze(fromFiles(fileMap));
          expect(typeof result.ok).toBe('boolean');
          // ok must be consistent: true iff no error-severity diagnostics
          const hasError = result.diagnostics.some((d) => d.severity === 'error');
          expect(result.ok).toBe(!hasError);
        },
      ),
      { seed: 42, numRuns: 100 },
    );
  });

  it('digest always matches the sha256:<hex> format', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 100 }), fc.string({ maxLength: 500 }), {
          maxKeys: 10,
        }),
        async (fileMap) => {
          const result = await analyze(fromFiles(fileMap));
          expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        },
      ),
      { seed: 42, numRuns: 100 },
    );
  });
});

// ── JSON Schema artifact ──────────────────────────────────────────────────────
//
// Two-layer verification:
//   1. Inline — always runs: z.toJSONSchema(SkillAnalysisSchema) produces a
//      valid JSON Schema document regardless of whether the build has run.
//   2. Post-build — skipIf(file absent): reads dist/skill-analysis.schema.json
//      and verifies it matches the inline-generated output byte-for-byte.
//
// The artifact is generated by scripts/generate-schema.mjs via tsup's onSuccess
// hook, so it only exists after `npm run build`. CI runs tests before build;
// the skipIf guard keeps the suite green on a clean checkout while still
// exercising the file content whenever a local build has run.

describe('JSON Schema artifact — z.toJSONSchema(SkillAnalysisSchema)', () => {
  it('produces a valid JSON Schema document (inline — always runs)', () => {
    const jsonSchema = z.toJSONSchema(SkillAnalysisSchema) as Record<string, unknown>;
    expect(jsonSchema).toBeDefined();
    expect(typeof jsonSchema).toBe('object');
    // Must be an object schema with a $schema declaration and properties
    expect(typeof jsonSchema['$schema']).toBe('string');
    expect(jsonSchema['type']).toBe('object');
    expect(typeof jsonSchema['properties']).toBe('object');
  });

  it('generated schema is JSON-serializable (no circular refs)', () => {
    const jsonSchema = z.toJSONSchema(SkillAnalysisSchema);
    expect(() => JSON.stringify(jsonSchema)).not.toThrow();
  });

  describe.skipIf(!existsSync(SCHEMA_ARTIFACT_PATH))(
    'dist/skill-analysis.schema.json (post-build)',
    () => {
      it('file is valid JSON', () => {
        const raw = readFileSync(SCHEMA_ARTIFACT_PATH, 'utf-8');
        expect(() => JSON.parse(raw)).not.toThrow();
      });

      it('file content matches z.toJSONSchema(SkillAnalysisSchema)', () => {
        const fileContent = readFileSync(SCHEMA_ARTIFACT_PATH, 'utf-8');
        const fromFile = JSON.parse(fileContent) as unknown;
        const inline = z.toJSONSchema(SkillAnalysisSchema);
        // Compare serialized forms — both must be stable JSON
        expect(JSON.stringify(fromFile)).toBe(JSON.stringify(inline));
      });
    },
  );
});
