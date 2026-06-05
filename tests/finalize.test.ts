/**
 * P6 tests for the finalize stage — options.rules severity-override matrix.
 *
 * Each test calls analyze() with options.rules and asserts the resulting
 * diagnostics array and ok flag. The finalize stage applies overrides AFTER
 * all pipeline stages have run; ok is computed from the post-override
 * diagnostic set, never the pre-override set.
 *
 * These tests fail until src/finalize.ts (or equivalent in analyze.ts) applies
 * options.rules during P6 impl (task #19).
 */
import { describe, expect, it } from 'vitest';
import { analyze, SkillAnalysisSchema } from '../src/index.js';
import { mem } from './helpers.js';

// ── Shared test fixtures ────────────────────────────────────────────────────
//
// Each fixture is designed to emit EXACTLY the diagnostics described in its
// comment so that override tests see clean, predictable output.

/**
 * Well-formed skill with ONLY version-missing (warning).
 * README + LICENSE present so no readme-missing / license-missing.
 * Default: ok = true (one warning, no errors).
 */
const ONLY_VERSION_WARNING = {
  'SKILL.md': '---\nname: my-skill\ndescription: A test skill.\n---\n\nBody.',
  'README.md': '# Readme',
  LICENSE: 'MIT License',
};

/**
 * Skill with description only — name field absent.
 * Emits ONLY name-missing (error). metadata.version present → no version-missing.
 * README + LICENSE present → no readme-missing / license-missing.
 * Default: ok = false (one error).
 */
const ONLY_NAME_ERROR = {
  'SKILL.md': '---\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
  'README.md': '# Readme',
  LICENSE: 'MIT License',
};

/**
 * Well-formed skill with a reserved name ("default").
 * name-reserved has defaultSeverity 'off' → NOT in output by default.
 * README + LICENSE present → no readme-missing / license-missing.
 * Default: ok = true, diagnostics = [].
 */
const RESERVED_NAME = {
  'SKILL.md':
    '---\nname: default\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.',
  'README.md': '# Readme',
  LICENSE: 'MIT License',
};

// ── Helper ────────────────────────────────────────────────────────────────────

function codes(result: { diagnostics: { code: string }[] }): string[] {
  return result.diagnostics.map((d) => d.code);
}

// ── 1. warning → error ────────────────────────────────────────────────────────

describe('warning → error override', () => {
  it('severity in output is promoted to "error"', async () => {
    const result = await analyze(mem(ONLY_VERSION_WARNING), {
      rules: { 'version-missing': 'error' },
    });
    const diag = result.diagnostics.find((d) => d.code === 'version-missing');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('error');
  });

  it('diagnostic remains in output (not removed)', async () => {
    const result = await analyze(mem(ONLY_VERSION_WARNING), {
      rules: { 'version-missing': 'error' },
    });
    expect(codes(result)).toContain('version-missing');
  });

  it('ok flips from true to false', async () => {
    const baseline = await analyze(mem(ONLY_VERSION_WARNING));
    expect(baseline.ok).toBe(true); // sanity-check the fixture

    const result = await analyze(mem(ONLY_VERSION_WARNING), {
      rules: { 'version-missing': 'error' },
    });
    expect(result.ok).toBe(false);
  });
});

// ── 2. error → warning ───────────────────────────────────────────────────────

describe('error → warning override', () => {
  it('severity in output is demoted to "warning"', async () => {
    const result = await analyze(mem(ONLY_NAME_ERROR), {
      rules: { 'name-missing': 'warning' },
    });
    const diag = result.diagnostics.find((d) => d.code === 'name-missing');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warning');
  });

  it('diagnostic remains in output (not removed)', async () => {
    const result = await analyze(mem(ONLY_NAME_ERROR), {
      rules: { 'name-missing': 'warning' },
    });
    expect(codes(result)).toContain('name-missing');
  });

  it('ok flips from false to true', async () => {
    const baseline = await analyze(mem(ONLY_NAME_ERROR));
    expect(baseline.ok).toBe(false); // sanity-check the fixture

    const result = await analyze(mem(ONLY_NAME_ERROR), {
      rules: { 'name-missing': 'warning' },
    });
    expect(result.ok).toBe(true);
  });
});

// ── 3. error → off ───────────────────────────────────────────────────────────

describe('error → off override', () => {
  it('removes the diagnostic from output entirely', async () => {
    const result = await analyze(mem(ONLY_NAME_ERROR), {
      rules: { 'name-missing': 'off' },
    });
    expect(codes(result)).not.toContain('name-missing');
  });

  it('ok flips from false to true when the only error is suppressed', async () => {
    const baseline = await analyze(mem(ONLY_NAME_ERROR));
    expect(baseline.ok).toBe(false); // sanity-check the fixture

    const result = await analyze(mem(ONLY_NAME_ERROR), {
      rules: { 'name-missing': 'off' },
    });
    expect(result.ok).toBe(true);
  });
});

// ── 4. off → error / warning (name-reserved) ─────────────────────────────────

describe('off → error override (name-reserved)', () => {
  it('name-reserved is absent from output by default (baseline)', async () => {
    const result = await analyze(mem(RESERVED_NAME));
    expect(codes(result)).not.toContain('name-reserved');
    expect(result.ok).toBe(true);
  });

  it('surfaces name-reserved in output with severity "error"', async () => {
    const result = await analyze(mem(RESERVED_NAME), {
      rules: { 'name-reserved': 'error' },
    });
    const diag = result.diagnostics.find((d) => d.code === 'name-reserved');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('error');
  });

  it('ok flips from true to false when name-reserved is overridden to error', async () => {
    const result = await analyze(mem(RESERVED_NAME), {
      rules: { 'name-reserved': 'error' },
    });
    expect(result.ok).toBe(false);
  });

  it('off → warning: surfaces name-reserved as warning, ok stays true', async () => {
    const result = await analyze(mem(RESERVED_NAME), {
      rules: { 'name-reserved': 'warning' },
    });
    const diag = result.diagnostics.find((d) => d.code === 'name-reserved');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warning');
    expect(result.ok).toBe(true);
  });
});

// ── 5. ok computed AFTER overrides ────────────────────────────────────────────

describe('ok is computed after overrides, not before', () => {
  it('warning promoted to error: ok=false even though pre-override ok was true', async () => {
    // Without override: version-missing is a warning → ok=true.
    // With override: version-missing becomes error → ok must be false.
    // A naive implementation that computes ok before applying overrides would
    // return ok=true here — this test catches that regression.
    const source = mem(ONLY_VERSION_WARNING);
    const withoutOverride = await analyze(source);
    const withOverride = await analyze(source, { rules: { 'version-missing': 'error' } });
    expect(withoutOverride.ok).toBe(true);
    expect(withOverride.ok).toBe(false);
  });

  it('multiple overrides applied together before ok is computed', async () => {
    // Skill: name-missing (error) + version-missing (warning) → baseline ok=false.
    // Override both to 'warning' → all warnings → ok=true.
    const source = mem({
      'SKILL.md': '---\ndescription: A skill.\n---\n\nBody.',
      'README.md': '# R',
      LICENSE: 'MIT',
    });
    const baseline = await analyze(source);
    expect(baseline.ok).toBe(false);

    const result = await analyze(source, {
      rules: { 'name-missing': 'warning', 'version-missing': 'warning' },
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics.find((d) => d.code === 'name-missing')?.severity).toBe('warning');
    expect(result.diagnostics.find((d) => d.code === 'version-missing')?.severity).toBe('warning');
  });

  it('error suppressed to off: ok=true even though pre-override ok was false', async () => {
    const source = mem(ONLY_NAME_ERROR);
    const withoutOverride = await analyze(source);
    const withOverride = await analyze(source, { rules: { 'name-missing': 'off' } });
    expect(withoutOverride.ok).toBe(false);
    expect(withOverride.ok).toBe(true);
  });
});

// ── 6. Unknown rule keys ──────────────────────────────────────────────────────

describe('unknown rule keys', () => {
  it('unknown code in rules → analyze() does not throw', async () => {
    await expect(
      analyze(mem(ONLY_VERSION_WARNING), { rules: { 'totally-unknown-code': 'error' } }),
    ).resolves.toBeDefined();
  });

  it('unknown code in rules → output is identical to no-rules baseline', async () => {
    // Unknown keys should be silently ignored — they change nothing.
    const source = mem(ONLY_VERSION_WARNING);
    const baseline = await analyze(source);
    const withFake = await analyze(source, { rules: { 'totally-unknown-code': 'error' } });
    expect(JSON.stringify(withFake)).toBe(JSON.stringify(baseline));
  });
});

// ── 7. Schema conformance under overrides ─────────────────────────────────────

describe('schema conformance under overrides', () => {
  it('output with warning→error override passes SkillAnalysisSchema', async () => {
    const result = await analyze(mem(ONLY_VERSION_WARNING), {
      rules: { 'version-missing': 'error' },
    });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('output with error→warning override passes SkillAnalysisSchema', async () => {
    const result = await analyze(mem(ONLY_NAME_ERROR), {
      rules: { 'name-missing': 'warning' },
    });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('output with off→error override (name-reserved) passes SkillAnalysisSchema', async () => {
    const result = await analyze(mem(RESERVED_NAME), {
      rules: { 'name-reserved': 'error' },
    });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });
});
