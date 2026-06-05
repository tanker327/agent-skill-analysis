/**
 * Unit tests for src/tokenizer.ts — default token counter + injection interface.
 *
 * R2 (plan §5 decision table): token counts are not comparable across
 * tokenizers — the output always carries `tokens.tokenizer` so consumers
 * know which was used. Default is 'approx-chars-4' (~chars/4 approximation).
 *
 * Two concerns:
 *   A. DEFAULT_TOKENIZER — name, count semantics, determinism.
 *   B. Injection via analyze() options.tokenizer — tokenizer name surfaces in
 *      tokens.tokenizer; custom count function drives tokens.body/metadata/total.
 */
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/index.js';
import { DEFAULT_TOKENIZER } from '../src/tokenizer.js';
import { mem } from './helpers.js';

// Minimal valid SKILL.md used across integration tests.
const SKILL_MD =
  '---\nname: tok-skill\ndescription: Token integration test.\nmetadata:\n  version: "1.0.0"\n---\n\n# Heading\n\nBody text for token counting.';

// ── A. DEFAULT_TOKENIZER unit tests ──────────────────────────────────────────

describe('DEFAULT_TOKENIZER', () => {
  it('name is "approx-chars-4"', () => {
    expect(DEFAULT_TOKENIZER.name).toBe('approx-chars-4');
  });

  it('empty string → 0 tokens', () => {
    expect(DEFAULT_TOKENIZER.count('')).toBe(0);
  });

  it('count is deterministic for the same input', () => {
    const text = 'Hello, world! This is some text for determinism verification.';
    expect(DEFAULT_TOKENIZER.count(text)).toBe(DEFAULT_TOKENIZER.count(text));
  });

  it('longer text → more tokens than shorter text', () => {
    const short = 'Hi';
    const long = 'This is a much longer piece of text for counting tokens via the approximation.';
    expect(DEFAULT_TOKENIZER.count(long)).toBeGreaterThan(DEFAULT_TOKENIZER.count(short));
  });

  it('approximates ~1 token per 4 characters (within ±25%)', () => {
    // 40 characters → should be in [7, 13] for a chars/4 approximation
    const text = 'a'.repeat(40);
    const count = DEFAULT_TOKENIZER.count(text);
    expect(count).toBeGreaterThanOrEqual(7);
    expect(count).toBeLessThanOrEqual(13);
  });

  it('returns a non-negative integer', () => {
    const count = DEFAULT_TOKENIZER.count('some test text here');
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('satisfies the Tokenizer interface shape', () => {
    expect(typeof DEFAULT_TOKENIZER.name).toBe('string');
    expect(typeof DEFAULT_TOKENIZER.count).toBe('function');
  });
});

// ── B. Tokenizer injection via analyze() ─────────────────────────────────────

describe('tokenizer injection via analyze()', () => {
  it('default tokenizer name appears in tokens.tokenizer', async () => {
    const result = await analyze(mem({ 'SKILL.md': SKILL_MD }));
    expect(result.tokens.tokenizer).toBe('approx-chars-4');
  });

  it('custom tokenizer name surfaces in tokens.tokenizer (R2)', async () => {
    const custom = { name: 'test-always-42', count: () => 42 };
    const result = await analyze(mem({ 'SKILL.md': SKILL_MD }), { tokenizer: custom });
    expect(result.tokens.tokenizer).toBe('test-always-42');
  });

  it('custom tokenizer count drives tokens.body', async () => {
    const custom = { name: 'always-7', count: () => 7 };
    const result = await analyze(mem({ 'SKILL.md': SKILL_MD }), { tokenizer: custom });
    expect(result.tokens.body).toBe(7);
  });

  it('custom tokenizer count drives tokens.metadata', async () => {
    const custom = { name: 'always-3', count: () => 3 };
    const result = await analyze(mem({ 'SKILL.md': SKILL_MD }), { tokenizer: custom });
    expect(result.tokens.metadata).toBe(3);
  });

  it('tokens.total = tokens.metadata + tokens.body (default tokenizer)', async () => {
    const result = await analyze(mem({ 'SKILL.md': SKILL_MD }));
    expect(result.tokens.total).toBe(result.tokens.metadata + result.tokens.body);
  });

  it('tokens.total = tokens.metadata + tokens.body (custom always-N tokenizer)', async () => {
    const custom = { name: 'always-5', count: () => 5 };
    const result = await analyze(mem({ 'SKILL.md': SKILL_MD }), { tokenizer: custom });
    // Both metadata and body are each 5 → total should be 10
    expect(result.tokens.total).toBe(result.tokens.metadata + result.tokens.body);
    expect(result.tokens.total).toBe(10);
  });

  it('determinism: same source + same tokenizer → same token counts', async () => {
    const source = mem({ 'SKILL.md': SKILL_MD });
    const [r1, r2] = await Promise.all([analyze(source), analyze(source)]);
    expect(r1.tokens).toEqual(r2.tokens);
  });

  it('all token values are non-negative integers', async () => {
    const result = await analyze(mem({ 'SKILL.md': SKILL_MD }));
    expect(Number.isInteger(result.tokens.metadata)).toBe(true);
    expect(Number.isInteger(result.tokens.body)).toBe(true);
    expect(Number.isInteger(result.tokens.total)).toBe(true);
    expect(result.tokens.metadata).toBeGreaterThanOrEqual(0);
    expect(result.tokens.body).toBeGreaterThanOrEqual(0);
    expect(result.tokens.total).toBeGreaterThanOrEqual(0);
  });

  it('tokens.metadata is non-zero when name and description are present', async () => {
    const result = await analyze(mem({ 'SKILL.md': SKILL_MD }));
    expect(result.tokens.metadata).toBeGreaterThan(0);
  });

  it('tokens.metadata reflects name + description content', async () => {
    // Skill with no name/description should have lower metadata tokens than
    // a full skill — use a char-counting custom tokenizer to make this precise.
    const counter = { name: 'char-counter', count: (t: string) => t.length };
    const noMeta = await analyze(mem({ 'SKILL.md': '# Just body\n\nNo frontmatter fence here.' }), {
      tokenizer: counter,
    });
    const withMeta = await analyze(mem({ 'SKILL.md': SKILL_MD }), { tokenizer: counter });
    expect(withMeta.tokens.metadata).toBeGreaterThan(noMeta.tokens.metadata);
  });

  it('no-skill-md → tokens all zero', async () => {
    const result = await analyze(mem({}));
    expect(result.tokens.metadata).toBe(0);
    expect(result.tokens.body).toBe(0);
    expect(result.tokens.total).toBe(0);
  });

  it('SKILL.md with no name/description: metadata tokens may be 0 or near-0', async () => {
    // No frontmatter → name=null, description=null
    const custom = { name: 'char-counter', count: (t: string) => t.length };
    const result = await analyze(mem({ 'SKILL.md': '# Only body\n\nNo frontmatter.' }), {
      tokenizer: custom,
    });
    // metadata token count for null name+null description should be 0 or very small
    expect(result.tokens.metadata).toBeLessThanOrEqual(2); // allow for separators
  });

  it('tokens.body is non-zero for non-empty body', async () => {
    const result = await analyze(mem({ 'SKILL.md': SKILL_MD }));
    expect(result.tokens.body).toBeGreaterThan(0);
  });
});
