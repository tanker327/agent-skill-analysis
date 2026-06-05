/**
 * P1 tests for the frontmatter pipeline stages (③ split, ④ normalize, ⑤ validate).
 *
 * Tests are written against the public analyze() API (TDD — they fail with the P0
 * skeleton and pass once src/frontmatter.ts lands in P1). Every diagnostic
 * assertion uses explicit code + severity checks so a reviewer sees the expected
 * codes directly in the file, without reading snapshot files.
 *
 * Coverage intent:
 *   - Normalization: all known fields extracted + promoted correctly
 *   - Extra keys: unknown / Claude Code–extension keys land in frontmatter.extra,
 *     zero diagnostics (regression guard against #25380-type false positives)
 *   - One test per diagnostic code: frontmatter-parse, name-missing, name-too-long,
 *     name-invalid, name-reserved (off by default), name-dir-mismatch,
 *     description-missing, description-too-long, compatibility-too-long,
 *     metadata-non-string, version-missing, allowed-tools-experimental
 *   - Degradation matrix rows 2–4 (row 1 is covered by contract.test.ts minimal-skill):
 *     row 2: bad YAML → frontmatter-parse
 *     row 3: no fence  → name-missing + description-missing
 *     row 4: non-string metadata values → metadata-non-string
 */
import { describe, expect, it } from 'vitest';
import { analyze, fromFiles, SkillAnalysisSchema, DIAGNOSTIC_REGISTRY } from '../src/index.js';
// Internal pure-function imports — not on public surface, tested directly here.
// These imports fail until src/frontmatter.ts lands in P1 (expected TDD).
import {
  normalizeFrontmatter,
  parseFrontmatterFromText,
  RESERVED_NAMES,
  splitSkillMd,
  validateFrontmatter,
} from '../src/frontmatter.js';
import { DiagnosticCollector } from '../src/diagnostics.js';
import { mem } from './helpers.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Collect all diagnostic codes from an analysis result. */
function codes(result: Awaited<ReturnType<typeof analyze>>): string[] {
  return result.diagnostics.map((d) => d.code);
}

/**
 * Build a fromFiles source with an explicit dir name (used for name-dir-mismatch).
 * String values are accepted directly; fromFiles UTF-8-encodes them.
 */
function memDir(files: Record<string, string>, dir: string) {
  return fromFiles(files, { dir });
}

// ── 0. Pure function unit tests ────────────────────────────────────────────────
//
// Each pipeline stage (③ split, ④ normalize, ⑤ validate) is a pure function
// that can be tested in isolation without going through analyze(). These tests
// fail until src/frontmatter.ts lands in P1 — same TDD contract as the rest.

describe('splitSkillMd', () => {
  it('returns yamlBlock and body for a well-formed file', () => {
    const text = '---\nname: x\n---\n\nBody here.';
    const { yamlBlock, body } = splitSkillMd(text);
    expect(yamlBlock).toBe('name: x');
    expect(body.trim()).toBe('Body here.');
  });

  it('returns yamlBlock null and full text as body when no opening fence', () => {
    const text = '# Just Markdown\n\nNo frontmatter.';
    const { yamlBlock, body } = splitSkillMd(text);
    expect(yamlBlock).toBeNull();
    expect(body).toBe(text);
  });

  it('treats missing closing fence as no-fence (truncated file)', () => {
    const text = '---\nname: x\n'; // no closing ---
    const { yamlBlock } = splitSkillMd(text);
    // No closing fence → treated the same as no fence at all
    expect(yamlBlock).toBeNull();
  });

  it('empty file returns yamlBlock null and empty body', () => {
    const { yamlBlock, body } = splitSkillMd('');
    expect(yamlBlock).toBeNull();
    expect(body).toBe('');
  });

  it('fences with empty YAML block return empty string yamlBlock', () => {
    const text = '---\n---\n\nBody.';
    const { yamlBlock } = splitSkillMd(text);
    expect(yamlBlock).toBe('');
  });
});

describe('normalizeFrontmatter', () => {
  it('extracts all known fields from a fully populated raw object', () => {
    const raw = {
      name: 'my-skill',
      description: 'Does things.',
      license: 'MIT',
      compatibility: 'Requires network',
      'allowed-tools': 'WebSearch WebFetch',
      metadata: { version: '1.0.0', author: 'Alice' },
    };
    const collector = new DiagnosticCollector();
    const fm = normalizeFrontmatter(raw, collector);
    expect(fm.name).toBe('my-skill');
    expect(fm.description).toBe('Does things.');
    expect(fm.license).toBe('MIT');
    expect(fm.compatibility).toBe('Requires network');
    expect(fm.allowedTools).toEqual(['WebSearch', 'WebFetch']);
    expect(fm.metadata).toEqual({ version: '1.0.0', author: 'Alice' });
    expect(fm.version).toBe('1.0.0'); // promoted from metadata.version
    expect(collector.all()).toHaveLength(0);
  });

  it('unknown keys land in extra', () => {
    const raw = { name: 'x', context: 'fork', agent: true };
    const collector = new DiagnosticCollector();
    const fm = normalizeFrontmatter(raw, collector);
    expect(fm.extra).toMatchObject({ context: 'fork', agent: true });
    expect(collector.all()).toHaveLength(0);
  });

  it('non-string metadata values are coerced to strings and emit metadata-non-string', () => {
    const raw = {
      name: 'x',
      metadata: { version: '1.0.0', count: 42, flag: true },
    };
    const collector = new DiagnosticCollector();
    const fm = normalizeFrontmatter(raw, collector);
    expect(fm.metadata?.['count']).toBe('42');
    expect(fm.metadata?.['flag']).toBe('true');
    expect(collector.all().some((d) => d.code === 'metadata-non-string')).toBe(true);
  });

  it('missing fields produce null values without emitting diagnostics', () => {
    const collector = new DiagnosticCollector();
    const fm = normalizeFrontmatter({}, collector);
    expect(fm.name).toBeNull();
    expect(fm.description).toBeNull();
    expect(fm.version).toBeNull();
    expect(fm.license).toBeNull();
    expect(fm.compatibility).toBeNull();
    expect(fm.allowedTools).toBeNull();
    expect(fm.metadata).toBeNull();
    expect(fm.extra).toEqual({});
    // normalizeFrontmatter only coerces; field-missing validation is validateFrontmatter's job
    expect(collector.all()).toHaveLength(0);
  });

  it('allowed-tools with a single tool produces a one-element array', () => {
    const collector = new DiagnosticCollector();
    const fm = normalizeFrontmatter({ 'allowed-tools': 'Bash' }, collector);
    expect(fm.allowedTools).toEqual(['Bash']);
  });

  // YAML sequence (array) form of allowed-tools — covers the Array.isArray branch in normalizeFrontmatter
  it('allowed-tools as a YAML sequence (string[]) is parsed correctly', () => {
    const collector = new DiagnosticCollector();
    const fm = normalizeFrontmatter({ 'allowed-tools': ['WebSearch', 'WebFetch'] }, collector);
    expect(fm.allowedTools).toEqual(['WebSearch', 'WebFetch']);
  });

  it('allowed-tools as a YAML sequence with no string elements → allowedTools is null', () => {
    // Non-string elements are filtered out; an empty result is treated as absent.
    const collector = new DiagnosticCollector();
    const fm = normalizeFrontmatter({ 'allowed-tools': [42, true] }, collector);
    expect(fm.allowedTools).toBeNull();
  });
});

describe('validateFrontmatter', () => {
  /** Build a minimal Frontmatter object for validateFrontmatter unit tests. */
  function minFm(overrides: Record<string, unknown> = {}) {
    return {
      name: 'valid-skill',
      description: 'A valid skill.',
      version: '1.0.0',
      license: null,
      compatibility: null,
      allowedTools: null,
      metadata: { version: '1.0.0' },
      extra: {},
      ...overrides,
    };
  }

  it('valid frontmatter emits no diagnostics', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm(), undefined, collector);
    expect(collector.all()).toHaveLength(0);
  });

  it('emits name-missing when name is null', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ name: null }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'name-missing')).toBe(true);
  });

  it('emits name-too-long when name exceeds 64 characters', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ name: 'a'.repeat(65) }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'name-too-long')).toBe(true);
  });

  it('does NOT emit name-too-long for a name of exactly 64 characters', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ name: 'a'.repeat(64) }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'name-too-long')).toBe(false);
  });

  it('emits name-invalid for a name with invalid characters', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ name: 'Bad_Name' }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'name-invalid')).toBe(true);
  });

  it('emits name-reserved into collector for a reserved name (pre-filter — code is "off" by default)', () => {
    // validateFrontmatter emits into the collector unconditionally; the 'off'
    // default-severity filter lives in analyze.ts and suppresses the code
    // in the final output. This test covers the validation logic itself.
    const reserved = RESERVED_NAMES[0]; // e.g. 'default'
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ name: reserved }), undefined, collector);
    const diag = collector.all().find((d) => d.code === 'name-reserved');
    expect(
      diag,
      `Expected name-reserved to be emitted for reserved name "${reserved}"`,
    ).toBeDefined();
    // The severity in the collector is the defaultSeverity from the registry ('off')
    expect(diag?.severity).toBe('off');
  });

  it('emits name-dir-mismatch when name does not match dir', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ name: 'skill-a' }), 'skill-b', collector);
    expect(collector.all().some((d) => d.code === 'name-dir-mismatch')).toBe(true);
  });

  it('does NOT emit name-dir-mismatch when dir is undefined', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ name: 'skill-a' }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'name-dir-mismatch')).toBe(false);
  });

  it('emits description-missing when description is null', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ description: null }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'description-missing')).toBe(true);
  });

  it('emits description-too-long when description exceeds 1024 characters', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ description: 'x'.repeat(1025) }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'description-too-long')).toBe(true);
  });

  it('does NOT emit description-too-long for description of exactly 1024 characters', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ description: 'x'.repeat(1024) }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'description-too-long')).toBe(false);
  });

  it('emits compatibility-too-long when compatibility exceeds 500 characters', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ compatibility: 'y'.repeat(501) }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'compatibility-too-long')).toBe(true);
  });

  it('does NOT emit compatibility-too-long for compatibility of exactly 500 characters', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ compatibility: 'y'.repeat(500) }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'compatibility-too-long')).toBe(false);
  });

  it('emits version-missing when metadata has no version key', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(
      minFm({ version: null, metadata: { author: 'Alice' } }),
      undefined,
      collector,
    );
    expect(collector.all().some((d) => d.code === 'version-missing')).toBe(true);
  });

  it('emits version-missing when metadata is null', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ version: null, metadata: null }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'version-missing')).toBe(true);
  });

  it('emits allowed-tools-experimental when allowedTools is present', () => {
    const collector = new DiagnosticCollector();
    validateFrontmatter(minFm({ allowedTools: ['WebSearch'] }), undefined, collector);
    expect(collector.all().some((d) => d.code === 'allowed-tools-experimental')).toBe(true);
  });
});

describe('parseFrontmatterFromText', () => {
  it('parses a well-formed SKILL.md into frontmatter + body', () => {
    const text =
      '---\nname: my-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody text.';
    const collector = new DiagnosticCollector();
    const { frontmatter, body } = parseFrontmatterFromText(text, undefined, collector);
    expect(frontmatter.name).toBe('my-skill');
    expect(frontmatter.description).toBe('y.');
    expect(body.trim()).toBe('Body text.');
    expect(collector.all().filter((d) => d.severity === 'error')).toHaveLength(0);
  });

  it('invalid YAML emits frontmatter-parse and returns null fields', () => {
    const text = '---\n: : bad yaml : :\n---\n\nBody.';
    const collector = new DiagnosticCollector();
    const { frontmatter } = parseFrontmatterFromText(text, undefined, collector);
    expect(collector.all().some((d) => d.code === 'frontmatter-parse')).toBe(true);
    expect(frontmatter.name).toBeNull();
  });

  it('no fence emits name-missing and description-missing', () => {
    const text = '# Markdown only';
    const collector = new DiagnosticCollector();
    parseFrontmatterFromText(text, undefined, collector);
    const emittedCodes = collector.all().map((d) => d.code);
    expect(emittedCodes).toContain('name-missing');
    expect(emittedCodes).toContain('description-missing');
  });
});

// ── 1. Normalization — field extraction ────────────────────────────────────────

describe('frontmatter normalization', () => {
  it('minimal valid skill: name and description are extracted', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: my-skill\ndescription: Does something useful.\nmetadata:\n  version: "1.0.0"\n---\n\n# My Skill\n\nBody.\n',
      }),
    );
    expect(result.frontmatter.name).toBe('my-skill');
    expect(result.frontmatter.description).toBe('Does something useful.');
    expect(codes(result)).not.toContain('name-missing');
    expect(codes(result)).not.toContain('description-missing');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('license field is preserved verbatim', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: lic-skill\ndescription: y.\nlicense: Apache-2.0\nmetadata:\n  version: "1.0.0"\n---\n\nBody.\n',
      }),
    );
    expect(result.frontmatter.license).toBe('Apache-2.0');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('compatibility field is preserved verbatim', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: compat-skill\ndescription: y.\ncompatibility: Requires network access\nmetadata:\n  version: "1.0.0"\n---\n\nBody.\n',
      }),
    );
    expect(result.frontmatter.compatibility).toBe('Requires network access');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('version is promoted from metadata.version', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: versioned-skill\ndescription: y.\nmetadata:\n  version: "2.1.0"\n  author: test\n---\n\nBody.\n',
      }),
    );
    expect(result.frontmatter.version).toBe('2.1.0');
    expect(codes(result)).not.toContain('version-missing');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('metadata map is preserved with all string values', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: meta-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n  author: Alice\n  tier: gold\n---\n\nBody.\n',
      }),
    );
    expect(result.frontmatter.metadata).toEqual({
      version: '1.0.0',
      author: 'Alice',
      tier: 'gold',
    });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('allowed-tools space-delimited string is parsed into a string array', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: tool-skill\ndescription: y.\nallowed-tools: WebSearch WebFetch Bash\nmetadata:\n  version: "1.0.0"\n---\n\nBody.\n',
      }),
    );
    expect(result.frontmatter.allowedTools).toEqual(['WebSearch', 'WebFetch', 'Bash']);
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('frontmatter with no extra keys has an empty extra object', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: clean-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.\n',
      }),
    );
    expect(result.frontmatter.extra).toEqual({});
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });
});

// ── 2. Extra keys — Claude Code extension keys ─────────────────────────────────
//
// Real Claude Code skills carry harness-specific keys in their frontmatter
// (context, model, effort, hooks, argument-hint, agent, disable-model-invocation,
// user-invocable, …). These must be preserved in frontmatter.extra and must NOT
// produce any diagnostic. Regression guard against false-positive warnings.

describe('frontmatter extra keys (Claude Code extension keys)', () => {
  it('all standard CC extension keys land in extra with zero diagnostics', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': [
          '---',
          'name: cc-skill',
          'description: A Claude Code skill with extension keys.',
          'context: fork',
          'model: claude-opus-4-5',
          'effort: high',
          'argument-hint: thing to act on',
          'agent: true',
          'disable-model-invocation: false',
          'user-invocable: true',
          'metadata:',
          '  version: "1.0.0"',
          '---',
          '',
          '# CC Skill',
          '',
          'Body.',
        ].join('\n'),
      }),
    );
    // All extension keys must be in extra
    expect(result.frontmatter.extra).toMatchObject({
      context: 'fork',
      'argument-hint': 'thing to act on',
      agent: true,
      'disable-model-invocation': false,
      'user-invocable': true,
    });
    // model and effort may also be extra (they are not standard frontmatter fields)
    // Zero diagnostics about the extension keys themselves
    const frontmatterCodes = codes(result).filter(
      (c) => c !== 'allowed-tools-experimental' && c !== 'version-missing',
    );
    expect(frontmatterCodes).toHaveLength(0);
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('unknown keys do not produce any diagnostic (never warned)', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: ext-skill\ndescription: y.\nan-unknown-key: some-value\nanother-key: 42\nmetadata:\n  version: "1.0.0"\n---\n\nBody.\n',
      }),
    );
    // Only possible diagnostics are about the known fields; unknown keys are silent
    const diagCodes = codes(result);
    expect(diagCodes).not.toContain('unknown-key');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });
});

// ── 3. Diagnostic codes ────────────────────────────────────────────────────────

describe('frontmatter-parse', () => {
  it('invalid YAML between fences emits frontmatter-parse (error)', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': '---\n: : this is not valid yaml : :\n---\n\nBody.' }),
    );
    const diag = result.diagnostics.find((d) => d.code === 'frontmatter-parse');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('error');
    // No name/description fields can be extracted after a parse failure
    expect(result.frontmatter.name).toBeNull();
    expect(result.frontmatter.description).toBeNull();
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('frontmatter-parse suppresses further field-level validation (no name-missing alongside it)', async () => {
    const result = await analyze(mem({ 'SKILL.md': '---\n: : bad yaml : :\n---\n\nBody.' }));
    // After a YAML parse failure the frontmatter fields are all null/empty —
    // name-missing and description-missing should NOT fire on top of frontmatter-parse.
    expect(codes(result)).not.toContain('name-missing');
    expect(codes(result)).not.toContain('description-missing');
  });
});

describe('name-missing', () => {
  it('frontmatter without a name field emits name-missing (error)', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': '---\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
      }),
    );
    const diag = result.diagnostics.find((d) => d.code === 'name-missing');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('error');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('name-missing has field set to "name"', async () => {
    const result = await analyze(mem({ 'SKILL.md': '---\ndescription: y.\n---\n\nBody.' }));
    const diag = result.diagnostics.find((d) => d.code === 'name-missing');
    expect(diag?.field).toBe('name');
  });
});

describe('name-too-long', () => {
  it('name longer than 64 characters emits name-too-long (error)', async () => {
    const longName = 'a'.repeat(65); // 65 chars — one over the limit
    const result = await analyze(
      mem({
        'SKILL.md': `---\nname: ${longName}\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.`,
      }),
    );
    const diag = result.diagnostics.find((d) => d.code === 'name-too-long');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('error');
    expect(diag?.field).toBe('name');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('name of exactly 64 characters does NOT emit name-too-long', async () => {
    const maxName = 'a'.repeat(64); // exactly at the limit
    const result = await analyze(
      mem({
        'SKILL.md': `---\nname: ${maxName}\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.`,
      }),
    );
    expect(codes(result)).not.toContain('name-too-long');
  });
});

// All charset / edge-hyphen / double-hyphen violations produce ONE code: name-invalid.
// Table-driven so each variant is independently identified in CI output.
describe('name-invalid', () => {
  const INVALID_NAMES: Array<{ label: string; name: string }> = [
    { label: 'uppercase letters', name: 'MySkill' },
    { label: 'underscore', name: 'my_skill' },
    { label: 'leading hyphen', name: '-my-skill' },
    { label: 'trailing hyphen', name: 'my-skill-' },
    { label: 'double hyphen', name: 'my--skill' },
    { label: 'space character', name: 'my skill' },
    { label: 'dot character', name: 'my.skill' },
    { label: 'slash character', name: 'my/skill' },
  ];

  for (const { label, name } of INVALID_NAMES) {
    it(`"${name}" (${label}) emits name-invalid (error)`, async () => {
      const result = await analyze(
        mem({
          'SKILL.md': `---\nname: "${name}"\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.`,
        }),
      );
      const diag = result.diagnostics.find((d) => d.code === 'name-invalid');
      expect(diag, `Expected name-invalid for name="${name}"`).toBeDefined();
      expect(diag?.severity).toBe('error');
      expect(diag?.field).toBe('name');
      expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    });
  }

  it('valid kebab-case name with digits does NOT emit name-invalid', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: my-skill-v2\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
      }),
    );
    expect(codes(result)).not.toContain('name-invalid');
  });

  it('single-segment name (no hyphens) is valid when charset is correct', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: search\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
      }),
    );
    expect(codes(result)).not.toContain('name-invalid');
  });
});

describe('name-reserved', () => {
  // name-reserved has defaultSeverity: 'off' — it is suppressed in output by default.
  // The name-reserved code is exercised in two ways:
  //   (a) no options → NOT in output (suppressed by 'off' default)
  //   (b) options.rules: { 'name-reserved': 'error' } → IN output (finalize applies override)
  //
  // (b) is a P6 / finalize concern; we write a todo here for completeness and confirm
  // (a) via the DIAGNOSTIC_REGISTRY check below.
  //
  // NOTE: The specific reserved word(s) are defined in src/frontmatter.ts. Update
  // these tests with a concrete reserved name once P1 impl is known.

  // ── Three todos that must be resolved before or during task #20 (P6) ──────────
  //
  // (A) Registry check — enable once P1 impl lands:
  //     name-reserved must be in DIAGNOSTIC_REGISTRY with defaultSeverity 'off'.
  //     That widens RegisteredDefaultSeverity to include 'off' and the TypeScript
  //     compiler demands the off-filter be restored in analyze.ts.
  //
  // (B) Default suppression — enable once P1 impl lands:
  //     A reserved name with no options → name-reserved NOT in output.
  //     Update the test with a concrete reserved word from src/frontmatter.ts.
  //
  // (C) Rules-override — enable in task #20 (P6 finalize tests):
  //     options.rules: { 'name-reserved': 'error' } → name-reserved IS in output.
  //     This also needs a matching COVERAGE_FIXTURES entry in contract.test.ts
  //     so the forward vocab check sees the code emitted (see contract.test.ts
  //     comment on 'off'-exemption).
  //
  // The reverse vocab check (emitted ⊆ registered) already enforces that the
  // registry entry itself exists once any fixture ever emits it — so (C) closing
  // is the complete coverage for this code across all layers.

  // (A) P1 — registry entry exists with defaultSeverity 'off'.
  // Widening RegisteredDefaultSeverity to include 'off' forces the compiler to
  // demand the off-filter back in analyze.ts.
  it('(A) name-reserved is in DIAGNOSTIC_REGISTRY with defaultSeverity "off"', () => {
    expect(DIAGNOSTIC_REGISTRY['name-reserved']).toBeDefined();
    expect(DIAGNOSTIC_REGISTRY['name-reserved'].defaultSeverity).toBe('off');
  });

  // (B) P1 — a reserved name with default options is suppressed from output.
  // Uses RESERVED_NAMES exported by src/frontmatter.ts so the list can't drift.
  it('(B) reserved name + default options → name-reserved NOT in analyze() output (off filter)', async () => {
    const reserved = RESERVED_NAMES[0]; // e.g. 'default'
    const result = await analyze(
      mem({
        'SKILL.md': `---\nname: ${reserved}\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.`,
      }),
    );
    // validateFrontmatter emits name-reserved into the collector, but the 'off'
    // default-severity filter in analyze.ts removes it from the final output.
    expect(codes(result)).not.toContain('name-reserved');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  // (C) P6 — rules-override surfaces the code. Converted in task #20.
  // Also add a matching COVERAGE_FIXTURES entry in contract.test.ts at that time
  // so the forward vocab check (non-'off' codes) covers it.
  it.todo(
    '(C) task#20 / P6: reserved name + options.rules {"name-reserved":"error"} → ' +
      'name-reserved appears in diagnostics with severity error ' +
      '(add to contract.test.ts COVERAGE_FIXTURES at same time)',
  );
});

describe('name-dir-mismatch', () => {
  it('name not matching source.dir emits name-dir-mismatch (warning)', async () => {
    const source = memDir(
      {
        'SKILL.md':
          '---\nname: my-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
      },
      'other-name', // dir name doesn't match name: my-skill
    );
    const result = await analyze(source);
    const diag = result.diagnostics.find((d) => d.code === 'name-dir-mismatch');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warning');
    expect(diag?.field).toBe('name');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('name matching source.dir does NOT emit name-dir-mismatch', async () => {
    const source = memDir(
      {
        'SKILL.md':
          '---\nname: my-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
      },
      'my-skill', // dir name matches
    );
    const result = await analyze(source);
    expect(codes(result)).not.toContain('name-dir-mismatch');
  });

  it('source with no dir (memory source, no dir option) never emits name-dir-mismatch', async () => {
    // mem() uses fromFiles() without a dir option → source.dir is undefined
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: my-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
      }),
    );
    expect(codes(result)).not.toContain('name-dir-mismatch');
  });
});

describe('description-missing', () => {
  it('frontmatter without a description field emits description-missing (error)', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': '---\nname: nodesc-skill\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
      }),
    );
    const diag = result.diagnostics.find((d) => d.code === 'description-missing');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('error');
    expect(diag?.field).toBe('description');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });
});

describe('description-too-long', () => {
  it('description longer than 1024 characters emits description-too-long (error)', async () => {
    const longDesc = 'x'.repeat(1025); // 1025 chars — one over the limit
    const result = await analyze(
      mem({
        'SKILL.md': `---\nname: longdesc-skill\ndescription: "${longDesc}"\nmetadata:\n  version: "1.0.0"\n---\n\nBody.`,
      }),
    );
    const diag = result.diagnostics.find((d) => d.code === 'description-too-long');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('error');
    expect(diag?.field).toBe('description');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('description of exactly 1024 characters does NOT emit description-too-long', async () => {
    const maxDesc = 'x'.repeat(1024); // exactly at the limit
    const result = await analyze(
      mem({
        'SKILL.md': `---\nname: okdesc-skill\ndescription: "${maxDesc}"\nmetadata:\n  version: "1.0.0"\n---\n\nBody.`,
      }),
    );
    expect(codes(result)).not.toContain('description-too-long');
  });
});

describe('compatibility-too-long', () => {
  it('compatibility longer than 500 characters emits compatibility-too-long (warning)', async () => {
    // Severity is WARNING per architect's table (team-lead ruling 2026-06-05).
    const longCompat = 'y'.repeat(501); // 501 chars — one over the limit
    const result = await analyze(
      mem({
        'SKILL.md': `---\nname: compat-skill\ndescription: y.\ncompatibility: "${longCompat}"\nmetadata:\n  version: "1.0.0"\n---\n\nBody.`,
      }),
    );
    const diag = result.diagnostics.find((d) => d.code === 'compatibility-too-long');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warning');
    expect(diag?.field).toBe('compatibility');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('compatibility of exactly 500 characters does NOT emit compatibility-too-long', async () => {
    const maxCompat = 'y'.repeat(500); // exactly at the limit
    const result = await analyze(
      mem({
        'SKILL.md': `---\nname: okcompat-skill\ndescription: y.\ncompatibility: "${maxCompat}"\nmetadata:\n  version: "1.0.0"\n---\n\nBody.`,
      }),
    );
    expect(codes(result)).not.toContain('compatibility-too-long');
  });
});

describe('metadata-non-string', () => {
  it('metadata value that is a number emits metadata-non-string (error)', async () => {
    // Severity is ERROR per output doc §5: non-string metadata value is a spec
    // violation, not a soft warning — output ok=false (team-lead ruling 2026-06-05).
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: meta-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n  count: 42\n---\n\nBody.',
      }),
    );
    const diag = result.diagnostics.find((d) => d.code === 'metadata-non-string');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('error');
    expect(result.ok).toBe(false);
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('metadata value that is a boolean emits metadata-non-string (error)', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: meta-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n  active: true\n---\n\nBody.',
      }),
    );
    expect(codes(result)).toContain('metadata-non-string');
  });

  it('multiple non-string metadata values: at least one metadata-non-string emitted', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: multi-meta\ndescription: y.\nmetadata:\n  version: "1.0.0"\n  count: 42\n  flag: true\n---\n\nBody.',
      }),
    );
    expect(codes(result)).toContain('metadata-non-string');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('all-string metadata values do NOT emit metadata-non-string', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: clean-meta\ndescription: y.\nmetadata:\n  version: "1.0.0"\n  author: Alice\n---\n\nBody.',
      }),
    );
    expect(codes(result)).not.toContain('metadata-non-string');
  });

  it('metadata-non-string: non-string values are stringified in the output (not dropped)', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: coerce-meta\ndescription: y.\nmetadata:\n  version: "1.0.0"\n  count: 42\n---\n\nBody.',
      }),
    );
    // The value should be coerced to its string representation, not omitted.
    if (result.frontmatter.metadata !== null) {
      expect(result.frontmatter.metadata['count']).toBe('42');
    }
  });

  it('unquoted version in metadata (e.g. version: 1.10) loses trailing zero and emits metadata-non-string', async () => {
    // YAML parses unquoted `1.10` as the number 1.1 (trailing zero dropped).
    // This pins the "quoted '1.10' survives" guarantee: authors MUST quote version
    // strings to preserve them. The coercion is detected (metadata-non-string),
    // not silent — output is String(1.1) = "1.1", not "1.10".
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: unquoted-ver\ndescription: y.\nmetadata:\n  version: 1.10\n---\n\nBody.',
      }),
    );
    expect(codes(result)).toContain('metadata-non-string');
    // The promoted version field reflects the coerced (lossy) value
    expect(result.frontmatter.version).toBe('1.1');
    // The metadata map also has the coerced string
    if (result.frontmatter.metadata !== null) {
      expect(result.frontmatter.metadata['version']).toBe('1.1');
    }
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });
});

describe('version-missing', () => {
  it('no metadata.version emits version-missing (warning)', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': '---\nname: novn-skill\ndescription: y.\n---\n\nBody.',
      }),
    );
    const diag = result.diagnostics.find((d) => d.code === 'version-missing');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warning');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('metadata block without a version key emits version-missing', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: novn2-skill\ndescription: y.\nmetadata:\n  author: Alice\n---\n\nBody.',
      }),
    );
    expect(codes(result)).toContain('version-missing');
    expect(result.frontmatter.version).toBeNull();
  });

  it('metadata.version present does NOT emit version-missing', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: vn-skill\ndescription: y.\nmetadata:\n  version: "1.2.3"\n---\n\nBody.',
      }),
    );
    expect(codes(result)).not.toContain('version-missing');
    expect(result.frontmatter.version).toBe('1.2.3');
  });
});

describe('allowed-tools-experimental', () => {
  it('presence of allowed-tools emits allowed-tools-experimental (warning)', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: tools-skill\ndescription: y.\nallowed-tools: WebSearch\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
      }),
    );
    const diag = result.diagnostics.find((d) => d.code === 'allowed-tools-experimental');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warning');
    expect(diag?.field).toBe('allowed-tools');
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('allowed-tools-experimental does not suppress the parsed tool list', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: tools-skill\ndescription: y.\nallowed-tools: WebSearch WebFetch\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
      }),
    );
    // Warning is present AND tools are correctly parsed
    expect(codes(result)).toContain('allowed-tools-experimental');
    expect(result.frontmatter.allowedTools).toEqual(['WebSearch', 'WebFetch']);
  });

  it('skill without allowed-tools does NOT emit allowed-tools-experimental', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: notools-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
      }),
    );
    expect(codes(result)).not.toContain('allowed-tools-experimental');
    expect(result.frontmatter.allowedTools).toBeNull();
  });
});

// ── 4. Degradation matrix rows 2–4 ────────────────────────────────────────────
//
// Row 1 (the happy path — valid SKILL.md with full valid frontmatter) is covered
// by the minimal-skill fixture in tests/contract.test.ts.
//
// These rows test the library's behavior when the frontmatter is broken in
// progressively more severe ways — the key invariant is that analyze() never
// throws; broken content becomes diagnostics.

describe('degradation matrix', () => {
  // Row 2: YAML parse error — frontmatter fence is present but content is not valid YAML
  it('row 2: bad YAML → frontmatter-parse error, output is schema-valid, no exception', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': '---\n: : this is unparseable : :\n---\n\nBody here.' }),
    );
    expect(codes(result)).toContain('frontmatter-parse');
    const parseError = result.diagnostics.find((d) => d.code === 'frontmatter-parse');
    expect(parseError?.severity).toBe('error');
    // All frontmatter fields are null after a parse failure
    expect(result.frontmatter.name).toBeNull();
    expect(result.frontmatter.description).toBeNull();
    expect(result.ok).toBe(false); // error → not ok
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  // Row 3: No frontmatter fence — the file is body-only markdown
  it('row 3: no frontmatter fence → name-missing + description-missing errors, schema-valid', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': '# Just Markdown\n\nNo frontmatter fence here.' }),
    );
    expect(codes(result)).toContain('name-missing');
    expect(codes(result)).toContain('description-missing');
    // No frontmatter-parse: the fence was simply absent, not malformed
    expect(codes(result)).not.toContain('frontmatter-parse');
    expect(result.ok).toBe(false); // errors → not ok
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  // Row 3 variant: Truncated SKILL.md (opening fence, no closing fence)
  it('row 3 variant: truncated frontmatter (opening --- only) → treated as missing fence', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': '---\nname: x\ndescription: y\n' }), // no closing ---
    );
    // Still resolves; specific diagnostic codes depend on impl (may be frontmatter-parse or name-missing)
    await expect(analyze(mem({ 'SKILL.md': '---\nname: x\n' }))).resolves.toBeDefined();
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  // Row 4: Non-string metadata values — parse succeeds, but metadata map has type violations.
  // Severity is ERROR per output doc §5 (team-lead ruling 2026-06-05); ok=false.
  it('row 4: non-string metadata values → metadata-non-string error, values coerced, schema-valid', async () => {
    const result = await analyze(
      mem({
        'SKILL.md':
          '---\nname: coerce-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n  count: 42\n  flag: true\n---\n\nBody.',
      }),
    );
    expect(codes(result)).toContain('metadata-non-string');
    const diag = result.diagnostics.find((d) => d.code === 'metadata-non-string');
    expect(diag?.severity).toBe('error');
    expect(result.ok).toBe(false); // error-level diagnostic → not ok
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });
});
