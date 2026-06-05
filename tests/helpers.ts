/**
 * Test utilities for agent-skill-analysis.
 *
 * Preferred usage: build all SkillSources with mem() / memReversed() — these
 * are fully in-memory and have zero fs flakiness. Disk fixtures (tests/fixtures/)
 * are reserved exclusively for testing fromDir.
 *
 * Imports go through the public surface (src/index.ts) so meta-tests exercise
 * the same API that consumers use. index.ts is coverage-excluded (barrel) so
 * this costs nothing in coverage metrics.
 */
import { fromFiles, SkillAnalysisSchema } from '../src/index.js';

const enc = new TextEncoder();

/**
 * Build an in-memory SkillSource from a plain object mapping path → UTF-8 string.
 *
 * The Map insertion order matches the object's own-key enumeration order, which
 * determines what source.list() returns. Use memReversed() alongside this to
 * test that analyze() is independent of list() ordering.
 */
export function mem(files: Record<string, string>) {
  return fromFiles(new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)])));
}

/**
 * Same files as mem() but Map insertion order is reversed.
 *
 * Pair with mem() on the same `files` object to verify that shuffling
 * source.list() order does not change the analyze() output.
 */
export function memReversed(files: Record<string, string>) {
  return fromFiles(
    new Map(
      Object.entries(files)
        .reverse()
        .map(([k, v]) => [k, enc.encode(v)]),
    ),
  );
}

/**
 * Assert that `result` is a valid SkillAnalysis by running it through
 * SkillAnalysisSchema.parse(). Throws a ZodError on mismatch.
 *
 * Use this in every fixture test so a schema regression fails loudly.
 */
export function assertSchemaValid(result: unknown): void {
  SkillAnalysisSchema.parse(result);
}
