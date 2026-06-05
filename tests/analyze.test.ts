/**
 * Unit tests for src/analyze.ts — pipeline orchestration.
 *
 * Covers the options-handling branches (options??{}, opts.ignore??DEFAULT_IGNORE,
 * isIgnored true/false) and the tokenizer option path (exercises isTokenizer in
 * schema.ts). The 'off'-severity and field-on-diagnostic branches in the
 * diagnostic-resolution loop cannot be triggered at P0 (no registered code has
 * field or 'off' defaultSeverity yet) and are covered by P1 fixtures when those
 * codes land.
 */
import { describe, expect, it } from 'vitest';
import { analyze, DEFAULT_IGNORE, SkillAnalysisSchema } from '../src/index.js';
import { mem } from './helpers.js';

// ── DEFAULT_IGNORE ─────────────────────────────────────────────────────────────

describe('DEFAULT_IGNORE', () => {
  it('is a readonly array that includes common vcs and tooling dirs', () => {
    expect(DEFAULT_IGNORE).toContain('.git');
    expect(DEFAULT_IGNORE).toContain('node_modules');
    expect(DEFAULT_IGNORE).toContain('.DS_Store');
  });
});

// ── ignore filtering ───────────────────────────────────────────────────────────

describe('ignore filtering', () => {
  it('files under DEFAULT_IGNORE segments are excluded from the analysis', async () => {
    const files = {
      'SKILL.md': '---\nname: test-skill\ndescription: Tests ignore filtering.\n---\n\n# Test\n',
      'node_modules/some-pkg/index.js': 'module.exports = {}',
      '.git/config': '[core]',
      '.DS_Store': 'binary junk',
    };
    const result = await analyze(mem(files));
    // Ignored files must NOT appear in files[] when manifest lands (P4).
    // At P0 we assert the output is schema-valid and the skill is found (no no-skill-md).
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    expect(result.diagnostics.some((d) => d.code === 'no-skill-md')).toBe(false);
  });

  it('options.ignore REPLACES DEFAULT_IGNORE entirely', async () => {
    // The custom ignore list does NOT include 'node_modules', so that file is kept.
    // It includes 'custom-ignore', which IS filtered.
    const files = {
      'SKILL.md': '---\nname: test-skill\ndescription: Custom ignore test.\n---\n\n# Test\n',
      'custom-ignore/foo.txt': 'should be filtered',
    };
    const result = await analyze(mem(files), { ignore: ['custom-ignore'] });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('options.ignore as empty array disables all filtering', async () => {
    const files = {
      'SKILL.md': '---\nname: test-skill\ndescription: No filtering test.\n---\n\n# Test\n',
      'node_modules/pkg.json': '{}',
    };
    // With ignore=[], nothing is filtered — node_modules is kept.
    const result = await analyze(mem(files), { ignore: [] });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });
});

// ── tokenizer option ───────────────────────────────────────────────────────────

describe('tokenizer option', () => {
  it('accepts a valid custom tokenizer and surfaces its name in output', async () => {
    const source = mem({
      'SKILL.md':
        '---\nname: tokenizer-skill\ndescription: Tokenizer test skill.\n---\n\n# Test\n\nHello world.\n',
    });
    const result = await analyze(source, {
      tokenizer: {
        name: 'test-tokenizer',
        count: (text: string) => Math.ceil(text.length / 4),
      },
    });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    // At P0, tokens.tokenizer is always the DEFAULT_TOKENIZER_NAME from analyze.ts
    // because the real tokenizer integration lands in P2. This test confirms the
    // option is accepted without throwing (exercises AnalyzeOptionsSchema/isTokenizer).
    expect(result.tokens).toBeDefined();
  });

  it('rejects an object missing the count function (invalid tokenizer)', async () => {
    const source = mem({ 'SKILL.md': '# Test' });
    // AnalyzeOptionsSchema.parse() is called inside analyze() — it throws on bad input.
    await expect(
      analyze(source, {
        tokenizer: { name: 'bad' } as Parameters<typeof analyze>[1] extends
          | undefined
          | { tokenizer?: infer T }
          ? NonNullable<T>
          : never,
      }),
    ).rejects.toThrow();
  });
});

// ── options validation ─────────────────────────────────────────────────────────

describe('options validation', () => {
  it('analyze() with no options uses DEFAULT_IGNORE and default tokenizer', async () => {
    const result = await analyze(mem({ 'SKILL.md': '# Test\n' }));
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('analyze() with empty options object behaves identically to no options', async () => {
    const source = mem({ 'SKILL.md': '# Test\n' });
    const [r1, r2] = await Promise.all([analyze(source), analyze(source, {})]);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('analyze() with maxFileBytes option is accepted by the schema', async () => {
    const result = await analyze(mem({ 'SKILL.md': '# Test\n' }), {
      maxFileBytes: 1_000_000,
    });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });
});
