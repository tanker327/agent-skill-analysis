/**
 * Contract meta-tests — cross-cutting invariants that must never regress.
 *
 * Five-pack (plan §4 + testing.md + team-lead addition):
 *   1. Determinism A: same tree analyzed twice → byte-identical JSON.stringify output
 *   2. Determinism B: source.list() returns in different order → still identical output
 *   3. Schema conformance: every fixture output passes SkillAnalysisSchema.parse()
 *   4. Diagnostic vocabulary: every code in DIAGNOSTIC_REGISTRY is emitted by ≥1 fixture
 *   5. Version sync: ANALYZER_VERSION matches package.json version (drift guard)
 *
 * Plus: never-throw invariant — bad content always becomes diagnostics, never an exception.
 *
 * All imports go through the public surface (src/index.ts / src/node.ts) so these
 * tests exercise the same API that consumers use.
 *
 * MAINTENANCE: When a new diagnostic code is added to src/diagnostics.ts, add or
 * extend a fixture in COVERAGE_FIXTURES so the vocabulary meta-test continues to pass.
 * The test will fail at CI telling you exactly which codes are missing.
 */
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json';
import {
  analyze,
  fromFiles,
  SkillAnalysisSchema,
  DIAGNOSTIC_REGISTRY,
  ANALYZER_VERSION,
  type SkillSource,
} from '../src/index.js';
import { BODY_TOKEN_LIMIT, BODY_LINE_LIMIT } from '../src/body.js';
import { mem, memReversed } from './helpers.js';

// ── Shared fixture definitions ─────────────────────────────────────────────────
//
// Every entry in COVERAGE_FIXTURES is:
//   • run through analyze() in the schema-conformance loop
//   • used to collect emitted diagnostic codes for the vocabulary check
//
// "label" appears in test names so failures identify the fixture.
// Add one entry for each new diagnostic code introduced in each phase.

/** Minimal valid skill — clean frontmatter + body, no diagnostics expected. */
const MINIMAL_SKILL_FILES = {
  'SKILL.md':
    '---\nname: test-skill\ndescription: A minimal test skill used by contract meta-tests.\n---\n\n# Test Skill\n\nDo the thing.\n',
};

/** Full-featured skill: README, LICENSE, references, scripts, assets. */
const FULL_SKILL_FILES = {
  'SKILL.md': [
    '---',
    'name: full-skill',
    'description: A full-featured skill used by contract meta-tests.',
    'version: "1.0.0"',
    'compatibility: Requires network access',
    'allowed-tools: WebSearch WebFetch',
    'metadata:',
    '  version: "1.0.0"',
    '  author: test',
    '---',
    '',
    '# Full Skill',
    '',
    'See references/guide.md for details.',
    '',
    '## Steps',
    '',
    '1. Do step one.',
    '2. Do step two.',
  ].join('\n'),
  'README.md': '# Full Skill\n\nThis is the readme.',
  LICENSE: 'MIT License\n\nCopyright (c) 2026 test\n\nPermission is hereby granted...',
  'references/guide.md': '# Guide\n\nReference content.',
  'scripts/run.py': 'print("hello")',
};

/** Empty tree — no files at all. Must emit: no-skill-md */
const EMPTY_TREE_FILES: Record<string, string> = {};

/**
 * SKILL.md with invalid YAML frontmatter.
 * Kept as a schema-conformance / never-throw fixture.
 * Will emit frontmatter-parse once that code is registered in P1.
 */
const BAD_YAML_FILES = {
  'SKILL.md': '---\n: : this is invalid yaml : :\n---\n\nBody content.',
};

/**
 * SKILL.md with no frontmatter fence at all.
 * Kept as a schema-conformance / never-throw fixture.
 * Will emit name-missing + description-missing once those codes are registered in P1.
 */
const NO_FRONTMATTER_FILES = {
  'SKILL.md': '# Just Markdown\n\nNo frontmatter fence here.',
};

/**
 * Fixtures used for schema conformance + diagnostic vocabulary coverage.
 *
 * Expand this array as each phase adds new diagnostic codes.
 * Each entry must cover every code it "promises" to emit (shown in the label
 * as "→ code1, code2"). The symmetric vocab test enforces both directions:
 *   forward:  every registered non-'off' code is emitted by ≥1 fixture
 *   reverse:  every emitted code exists in DIAGNOSTIC_REGISTRY
 *
 * Most fixtures use `files` (passed through mem()). Fixtures that need a
 * dir-bearing source set `source` directly — the loops use `f.source ?? mem(f.files)`.
 *
 * P0: no-skill-md
 * P1: frontmatter-parse, name-missing, description-missing, name-too-long,
 *     name-invalid, name-dir-mismatch, description-too-long, compatibility-too-long,
 *     metadata-non-string, version-missing, allowed-tools-experimental
 *     (name-reserved is 'off'-exempt — covered via rules-override in P6 task #20)
 * P2: body-too-long (> 4000 tokens at approx-chars-4 → > 16000 chars),
 *     body-too-many-lines (> 500 lines)
 *     Fixtures inline-compute the body sizes from the settled thresholds;
 *     refactor to import BODY_TOKEN_LIMIT/BODY_LINE_LIMIT from src/body.ts
 *     once that module exists (avoids breaking 20 passing tests during TDD).
 */
const COVERAGE_FIXTURES: Array<{
  label: string;
  files: Record<string, string>;
  /** Optional override source — used when a dir-bearing SkillSource is required. */
  source?: SkillSource;
}> = [
  // ── P0 baseline ────────────────────────────────────────────────────────────
  // minimal-skill has no metadata block → emits version-missing
  { label: 'minimal-skill (→ version-missing)', files: MINIMAL_SKILL_FILES },
  // full-skill has allowed-tools → emits allowed-tools-experimental
  { label: 'full-skill (→ allowed-tools-experimental)', files: FULL_SKILL_FILES },
  { label: 'empty-tree (→ no-skill-md)', files: EMPTY_TREE_FILES },

  // ── P1 frontmatter-chain ───────────────────────────────────────────────────
  { label: 'bad-yaml (→ frontmatter-parse)', files: BAD_YAML_FILES },
  { label: 'no-frontmatter (→ name-missing, description-missing)', files: NO_FRONTMATTER_FILES },

  // name-too-long: name exceeds 64 characters
  {
    label: 'long-name (→ name-too-long)',
    files: {
      'SKILL.md': `---\nname: ${'a'.repeat(65)}\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\nBody.`,
    },
  },
  // name-invalid: charset violation (underscore is not allowed)
  {
    label: 'invalid-name (→ name-invalid)',
    files: {
      'SKILL.md': '---\nname: bad_name\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\nBody.',
    },
  },
  // name-dir-mismatch: skill name doesn't match the source dir basename.
  // Uses fromFiles with { dir } so source.dir is set.
  {
    label: 'dir-mismatch (→ name-dir-mismatch)',
    files: {},
    source: fromFiles(
      {
        'SKILL.md':
          '---\nname: skill-a\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\nBody.',
      },
      { dir: 'skill-b' },
    ),
  },
  // description-too-long: description exceeds 1024 characters
  {
    label: 'long-description (→ description-too-long)',
    files: {
      'SKILL.md': `---\nname: longdesc\ndescription: "${'x'.repeat(1025)}"\nmetadata:\n  version: "1.0.0"\n---\nBody.`,
    },
  },
  // compatibility-too-long: compatibility exceeds 500 characters — severity WARNING (soft limit
  // on free text; settled per architect's approved registry table, confirmed by team-lead).
  {
    label: 'long-compatibility (→ compatibility-too-long)',
    files: {
      'SKILL.md': `---\nname: longcompat\ndescription: y.\ncompatibility: "${'y'.repeat(501)}"\nmetadata:\n  version: "1.0.0"\n---\nBody.`,
    },
  },
  // metadata-non-string: a metadata value is not a string — severity ERROR per output doc §5
  // (non-string value is a spec violation; values are stringified in output, ok=false).
  {
    label: 'non-string-metadata (→ metadata-non-string)',
    files: {
      'SKILL.md':
        '---\nname: meta-skill\ndescription: y.\nmetadata:\n  version: "1.0.0"\n  count: 42\n---\nBody.',
    },
  },

  // ── P2 body budget ─────────────────────────────────────────────────────────
  // body-too-long: approx-chars-4 counts Math.ceil(chars / 4) tokens, so
  // BODY_TOKEN_LIMIT * 4 + 1 chars → BODY_TOKEN_LIMIT + 1 tokens → triggers.
  {
    label: 'long-token-body (→ body-too-long)',
    files: {
      'SKILL.md':
        '---\nname: longbody\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\n' +
        'x'.repeat(BODY_TOKEN_LIMIT * 4 + 1),
    },
  },
  // body-too-many-lines: Array(BODY_LINE_LIMIT + 2) gives BODY_LINE_LIMIT + 2 lines
  // (split('\n').length) — strictly greater than BODY_LINE_LIMIT → triggers.
  {
    label: 'many-lines-body (→ body-too-many-lines)',
    files: {
      'SKILL.md':
        '---\nname: manylines\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\n' +
        Array(BODY_LINE_LIMIT + 2)
          .fill('x')
          .join('\n'),
    },
  },
];

// ── 1 & 2. Determinism ─────────────────────────────────────────────────────────

describe('determinism', () => {
  it('same tree analyzed twice produces byte-identical JSON', async () => {
    const source = mem(MINIMAL_SKILL_FILES);
    const [r1, r2] = await Promise.all([analyze(source), analyze(source)]);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('reversed source.list() order produces identical output', async () => {
    // Multiple files so there is an actual ordering difference to shake out.
    const files = {
      'SKILL.md':
        '---\nname: ordering-skill\ndescription: Ordering test skill for determinism check.\n---\n\n# Ordering\n\nBody.\n',
      'README.md': '# Ordering Skill',
      'references/a.md': 'Reference A content.',
      'references/b.md': 'Reference B content.',
    };
    const [r1, r2] = await Promise.all([analyze(mem(files)), analyze(memReversed(files))]);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ── 3. Schema conformance ──────────────────────────────────────────────────────

describe('schema conformance', () => {
  for (const f of COVERAGE_FIXTURES) {
    it(`${f.label} → output passes SkillAnalysisSchema.parse()`, async () => {
      // Use f.source when provided (e.g. dir-bearing source for name-dir-mismatch);
      // otherwise fall back to the mem() helper.
      const result = await analyze(f.source ?? mem(f.files));
      // parse() throws ZodError on mismatch — message describes the failing field
      expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    });
  }
});

// ── 4. Diagnostic vocabulary coverage ─────────────────────────────────────────

describe('diagnostic vocabulary', () => {
  it('registered ⊆ emitted AND emitted ⊆ registered (symmetric vocabulary check)', async () => {
    const emitted = new Set<string>();
    for (const f of COVERAGE_FIXTURES) {
      const result = await analyze(f.source ?? mem(f.files));
      for (const d of result.diagnostics) {
        emitted.add(d.code);
      }
    }

    // Codes with defaultSeverity 'off' are suppressed from output by default;
    // the only way to surface them is via options.rules override (a finalize / P6
    // concern).  Exempt them from the forward direction so the vocab test stays
    // green at P1 when name-reserved registers with 'off' — it won't appear in
    // any fixture's output until finalize.ts lands in P6 and task #20 adds the
    // rules-override fixture to this COVERAGE_FIXTURES list.
    // The reverse direction is NOT exempted: if a fixture somehow emits an 'off'
    // code it must still exist in DIAGNOSTIC_REGISTRY (catches typos and forward-
    // of-phase promises equally).
    const registeredCodes = Object.entries(DIAGNOSTIC_REGISTRY)
      .filter(([, spec]) => spec.defaultSeverity !== 'off')
      .map(([code]) => code);

    // Forward: every registered (non-off) code must be emitted by at least one fixture.
    // Fails when a code is added to the registry without a corresponding fixture.
    const uncovered = registeredCodes.filter((code) => !emitted.has(code));
    if (uncovered.length > 0) {
      expect.fail(
        `These diagnostic codes are in DIAGNOSTIC_REGISTRY but not emitted by any fixture:\n` +
          uncovered.map((c) => `  • ${c}`).join('\n') +
          `\n\nAdd a fixture to COVERAGE_FIXTURES in tests/contract.test.ts that triggers each code.`,
      );
    }

    // Reverse: every code emitted by a fixture must exist in DIAGNOSTIC_REGISTRY.
    // Fails when a fixture emits a code that was never registered — catches
    // forward-of-phase placeholder labels and misspelled code strings.
    const unregistered = [...emitted].filter((code) => !(code in DIAGNOSTIC_REGISTRY));
    if (unregistered.length > 0) {
      expect.fail(
        `These codes were emitted by fixtures but are NOT in DIAGNOSTIC_REGISTRY:\n` +
          unregistered.map((c) => `  • ${c}`).join('\n') +
          `\n\nRegister the code in src/diagnostics.ts or remove the fixture that emits it.`,
      );
    }
  });
});

// ── 5. Version sync ────────────────────────────────────────────────────────────

describe('version sync', () => {
  it('ANALYZER_VERSION matches package.json version', () => {
    // Guards against ANALYZER_VERSION drifting from the npm package version.
    // If this fails, the constant in src/ was not updated when the package was bumped
    // (or vice versa). Fix: wire ANALYZER_VERSION to read from package.json at build time,
    // or ensure both are updated in the same commit.
    expect(ANALYZER_VERSION).toBe(packageJson.version);
  });
});

// ── Never-throw ────────────────────────────────────────────────────────────────

describe('never-throw', () => {
  const BAD_CONTENT_CASES: Array<{ label: string; files: Record<string, string> }> = [
    { label: 'empty tree', files: {} },
    { label: 'invalid YAML', files: { 'SKILL.md': '---\n: : invalid\n---\nBody' } },
    { label: 'no frontmatter fence', files: { 'SKILL.md': '# Only markdown' } },
    { label: 'empty SKILL.md', files: { 'SKILL.md': '' } },
    {
      label: 'truncated frontmatter fence (no closing ---)',
      files: { 'SKILL.md': '---\nname: x\n' },
    },
    {
      label: 'metadata with non-string values',
      files: {
        'SKILL.md': '---\nname: x\ndescription: y\nmetadata:\n  count: 42\n  flag: true\n---\nBody',
      },
    },
  ];

  for (const { label, files } of BAD_CONTENT_CASES) {
    it(`analyze() resolves (never rejects) for: ${label}`, async () => {
      await expect(analyze(mem(files))).resolves.toBeDefined();
    });
  }
});
