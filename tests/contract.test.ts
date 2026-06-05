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
  SkillAnalysisSchema,
  DIAGNOSTIC_REGISTRY,
  ANALYZER_VERSION,
} from '../src/index.js';
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
 * Each entry must cover every code it "promises" to emit.
 *
 * P0: baseline skeleton fixtures
 * P1: frontmatter-chain fixtures (bad YAML, no frontmatter, etc.) — see frontmatter.test.ts
 *     for the full P1 fixture suite; entries here cover only the codes needed for the
 *     cross-cutting vocabulary meta-test.
 */
const COVERAGE_FIXTURES: Array<{ label: string; files: Record<string, string> }> = [
  // P0 baseline
  { label: 'minimal-skill', files: MINIMAL_SKILL_FILES },
  { label: 'full-skill', files: FULL_SKILL_FILES },
  { label: 'empty-tree (→ no-skill-md)', files: EMPTY_TREE_FILES },
  // These two stay as schema-conformance / never-throw fixtures at P0.
  // Labels will grow to include code promises (e.g. "→ frontmatter-parse") once
  // those codes are registered in P1 and emitted by these trees.
  { label: 'bad-yaml', files: BAD_YAML_FILES },
  { label: 'no-frontmatter', files: NO_FRONTMATTER_FILES },
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
  for (const { label, files } of COVERAGE_FIXTURES) {
    it(`${label} → output passes SkillAnalysisSchema.parse()`, async () => {
      const result = await analyze(mem(files));
      // parse() throws ZodError on mismatch — message describes the failing field
      expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    });
  }
});

// ── 4. Diagnostic vocabulary coverage ─────────────────────────────────────────

describe('diagnostic vocabulary', () => {
  it('registered ⊆ emitted AND emitted ⊆ registered (symmetric vocabulary check)', async () => {
    const emitted = new Set<string>();
    for (const { files } of COVERAGE_FIXTURES) {
      const result = await analyze(mem(files));
      for (const d of result.diagnostics) {
        emitted.add(d.code);
      }
    }

    const registeredCodes = Object.keys(DIAGNOSTIC_REGISTRY);

    // Forward: every registered code must be emitted by at least one fixture.
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
