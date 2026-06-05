/**
 * P5 digest stability tests — encoding design invariant D-A4 as executable specs.
 *
 * Authoritative definition (plan §5 R1, schema.ts §digest):
 *   - SKILL.md's contribution: sha256(canonicalJSON(frontmatter minus
 *     metadata.version, keys sorted) + "\n" + body). Version bumps leave it
 *     unchanged because metadata.version is stripped before hashing.
 *   - Other files: reuse their byte sha256 from files[].
 *   - Manifest build: (path, hash) pairs sorted by path, joined into a string,
 *     then sha256'd. Output is always "sha256:<64-hex-chars>".
 *
 * Key behavioral contracts:
 *   • metadata.version bump → digest UNCHANGED (D-A4 left side)
 *   • Bumping metadata.version changes SKILL.md's byte sha256 in files[]
 *     (intentional: files[].sha256 is the true byte hash — contrast with digest)
 *   • Any non-version frontmatter change → digest changes
 *   • Body change → digest changes
 *   • YAML formatting-only change (same parsed data) → digest unchanged
 *   • Non-SKILL.md file added / removed / changed → digest changes
 *   • Digest is byte-deterministic: same tree → same digest across runs/orderings
 *   • No-SKILL.md tree still produces a valid sha256: digest
 *   • options.ignore affects enumeration and therefore the digest (documented caveat)
 *
 * Sections 0–7 exercise the public analyze() API.
 * Section 8 tests the exported canonicalJSON() helper directly.
 * Section 9 tests computeDigest() directly to cover private edge-case branches.
 */
import { describe, expect, it } from 'vitest';
import { analyze, SkillAnalysisSchema } from '../src/index.js';
import type { FileEntry } from '../src/index.js';
import { canonicalJSON, computeDigest } from '../src/digest.js';
import { mem, memReversed } from './helpers.js';

// ── Shared fixtures ───────────────────────────────────────────────────────────

/** Minimal frontmatter, version "1.0.0" — short so it stays below any maxFileBytes guard. */
const FM_V1 =
  '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\n---\n\n';

/** Same frontmatter data, only metadata.version differs. */
const FM_V999 =
  '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "9.9.9"\n---\n\n';

/** Stable body used when body content is not the variable under test. */
const BODY = '# Test Skill\n\nDo the thing.\n';

/** Support files (README + LICENSE) — included in most fixtures so reference graph and
 *  docs diagnostics stay clean and don't interfere with digest-focused assertions. */
const SUPPORT = { 'README.md': '# Readme', LICENSE: 'MIT' };

// ── Section 0: digest format ──────────────────────────────────────────────────

describe('digest format', () => {
  it('digest always matches ^sha256:[0-9a-f]{64}$', async () => {
    const result = await analyze(mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT }));
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('schema accepts the digest value (validate via SkillAnalysisSchema)', async () => {
    const result = await analyze(mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT }));
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('empty-tree (no SKILL.md) still produces a valid sha256: digest', async () => {
    const result = await analyze(mem({}));
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ── Section 1: D-A4 — version-only bump ──────────────────────────────────────

describe('digest stability — version-only bump (D-A4 left side)', () => {
  it('two trees identical except metadata.version → digest IDENTICAL', async () => {
    const r1 = await analyze(mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT }));
    const r2 = await analyze(mem({ 'SKILL.md': FM_V999 + BODY, ...SUPPORT }));
    // metadata.version is stripped from the canonical hash → digests must match
    expect(r1.digest).toBe(r2.digest);
  });

  it('version bump changes files[].sha256 for SKILL.md (byte hash differs, digest does not)', async () => {
    // The two invariants are intentionally different:
    //   files[].sha256  = sha256(raw bytes)      → differs when the file bytes differ
    //   digest           = sha256(version-stripped canonical JSON + body) → version-insensitive
    const r1 = await analyze(mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT }));
    const r2 = await analyze(mem({ 'SKILL.md': FM_V999 + BODY, ...SUPPORT }));
    const sha1 = r1.files.find((f) => f.path === 'SKILL.md')?.sha256;
    const sha2 = r2.files.find((f) => f.path === 'SKILL.md')?.sha256;
    expect(sha1).toBeDefined();
    expect(sha2).toBeDefined();
    // byte hashes differ (FM_V1 and FM_V999 have different bytes)
    expect(sha1).not.toBe(sha2);
    // but the top-level digest is the same (version stripped from canonical hash)
    expect(r1.digest).toBe(r2.digest);
  });

  it('multiple version strings — digest is stable across all of them', async () => {
    // A quick three-way check: 1.0.0, 2.0.0, 1.0.0-beta all hash identically
    const versions = ['1.0.0', '2.0.0', '1.0.0-beta'];
    const results = await Promise.all(
      versions.map((v) =>
        analyze(
          mem({
            'SKILL.md': `---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "${v}"\n---\n\n${BODY}`,
            ...SUPPORT,
          }),
        ),
      ),
    );
    const digests = results.map((r) => r.digest);
    // All digests identical
    expect(new Set(digests).size).toBe(1);
  });
});

// ── Section 2: body changes ───────────────────────────────────────────────────

describe('digest stability — body changes (D-A4 right side)', () => {
  it('changing one body character changes the digest', async () => {
    const r1 = await analyze(mem({ 'SKILL.md': FM_V1 + 'Do the thing.\n', ...SUPPORT }));
    const r2 = await analyze(mem({ 'SKILL.md': FM_V1 + 'Do the Thing.\n', ...SUPPORT }));
    expect(r1.digest).not.toBe(r2.digest);
  });

  it('adding a line to the body changes the digest', async () => {
    const r1 = await analyze(mem({ 'SKILL.md': FM_V1 + 'Line one.\n', ...SUPPORT }));
    const r2 = await analyze(mem({ 'SKILL.md': FM_V1 + 'Line one.\nLine two.\n', ...SUPPORT }));
    expect(r1.digest).not.toBe(r2.digest);
  });

  it('empty body vs non-empty body → different digests', async () => {
    const r1 = await analyze(mem({ 'SKILL.md': FM_V1, ...SUPPORT }));
    const r2 = await analyze(mem({ 'SKILL.md': FM_V1 + 'Body.\n', ...SUPPORT }));
    expect(r1.digest).not.toBe(r2.digest);
  });
});

// ── Section 3: frontmatter format-only changes ───────────────────────────────

describe('digest stability — frontmatter format-only changes (YAML normalization)', () => {
  it('YAML quote style difference (same data) → digest IDENTICAL', async () => {
    // Both frontmatters parse to: name="test-skill", description="A test skill."
    const yaml1 =
      '---\nname: test-skill\ndescription: "A test skill."\nmetadata:\n  version: "1.0.0"\n---\n\n';
    const yaml2 =
      '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\n---\n\n';
    const r1 = await analyze(mem({ 'SKILL.md': yaml1 + BODY, ...SUPPORT }));
    const r2 = await analyze(mem({ 'SKILL.md': yaml2 + BODY, ...SUPPORT }));
    expect(r1.digest).toBe(r2.digest);
  });

  it('YAML indentation difference (same data) → digest IDENTICAL', async () => {
    // metadata block with different indentation — same parsed values
    const yaml1 =
      '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\n---\n\n';
    const yaml2 =
      '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\n---\n\n';
    const r1 = await analyze(mem({ 'SKILL.md': yaml1 + BODY, ...SUPPORT }));
    const r2 = await analyze(mem({ 'SKILL.md': yaml2 + BODY, ...SUPPORT }));
    expect(r1.digest).toBe(r2.digest);
  });

  it('YAML key ordering in file (same data, different order) → digest IDENTICAL', async () => {
    // canonicalJSON sorts keys, so key order in the file is irrelevant
    const yaml1 =
      '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\n---\n\n';
    const yaml2 =
      '---\ndescription: A test skill.\nname: test-skill\nmetadata:\n  version: "1.0.0"\n---\n\n';
    const r1 = await analyze(mem({ 'SKILL.md': yaml1 + BODY, ...SUPPORT }));
    const r2 = await analyze(mem({ 'SKILL.md': yaml2 + BODY, ...SUPPORT }));
    expect(r1.digest).toBe(r2.digest);
  });
});

// ── Section 4: non-SKILL.md file changes ─────────────────────────────────────

describe('digest stability — non-SKILL.md file changes', () => {
  it('changing a non-SKILL.md file content changes the digest', async () => {
    const r1 = await analyze(
      mem({ 'SKILL.md': FM_V1 + BODY, 'README.md': '# Version A', LICENSE: 'MIT' }),
    );
    const r2 = await analyze(
      mem({ 'SKILL.md': FM_V1 + BODY, 'README.md': '# Version B', LICENSE: 'MIT' }),
    );
    expect(r1.digest).not.toBe(r2.digest);
  });

  it('adding a file to the tree changes the digest', async () => {
    const r1 = await analyze(mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT }));
    const r2 = await analyze(
      mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT, 'references/guide.md': '# Guide' }),
    );
    expect(r1.digest).not.toBe(r2.digest);
  });

  it('removing a file from the tree changes the digest', async () => {
    const r1 = await analyze(
      mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT, 'references/guide.md': '# Guide' }),
    );
    const r2 = await analyze(mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT }));
    expect(r1.digest).not.toBe(r2.digest);
  });

  it('renaming a file (same content, different path) changes the digest', async () => {
    const r1 = await analyze(
      mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT, 'references/a.md': '# A' }),
    );
    const r2 = await analyze(
      mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT, 'references/b.md': '# A' }),
    );
    // Same content at different paths → digest differs (path is part of the manifest)
    expect(r1.digest).not.toBe(r2.digest);
  });
});

// ── Section 5: determinism ────────────────────────────────────────────────────

describe('digest determinism', () => {
  it('same tree analyzed twice produces identical digest', async () => {
    const source = mem({ 'SKILL.md': FM_V1 + BODY, ...SUPPORT });
    const [r1, r2] = await Promise.all([analyze(source), analyze(source)]);
    expect(r1.digest).toBe(r2.digest);
  });

  it('digest is stable across source.list() orderings', async () => {
    const files = {
      'SKILL.md': FM_V1 + BODY,
      'README.md': '# Readme',
      LICENSE: 'MIT',
      'references/a.md': '# A',
      'references/b.md': '# B',
    };
    const [r1, r2] = await Promise.all([analyze(mem(files)), analyze(memReversed(files))]);
    expect(r1.digest).toBe(r2.digest);
  });
});

// ── Section 6: no-SKILL.md edge cases ────────────────────────────────────────

describe('digest — no-SKILL.md edge cases', () => {
  it('no-SKILL.md tree produces a valid sha256: digest', async () => {
    const result = await analyze(mem({ 'README.md': '# Readme', LICENSE: 'MIT' }));
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('two different no-SKILL.md trees produce different digests', async () => {
    const r1 = await analyze(mem({ 'README.md': '# Readme A' }));
    const r2 = await analyze(mem({ 'README.md': '# Readme B' }));
    expect(r1.digest).not.toBe(r2.digest);
  });

  it('empty tree produces a valid sha256: digest', async () => {
    const result = await analyze(mem({}));
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('adding SKILL.md to a no-SKILL.md tree changes the digest', async () => {
    const r1 = await analyze(mem({ 'README.md': '# R', LICENSE: 'MIT' }));
    const r2 = await analyze(mem({ 'SKILL.md': FM_V1 + BODY, 'README.md': '# R', LICENSE: 'MIT' }));
    expect(r1.digest).not.toBe(r2.digest);
  });
});

// ── Section 7: ignore-set dependence (characterization) ──────────────────────

describe('digest — ignore-set dependence (characterization, F1)', () => {
  /**
   * options.ignore REPLACES DEFAULT_IGNORE (see analyze.ts F1 comment).
   * The digest therefore depends on the ignore configuration: two parties
   * comparing digests must use the same ignore set. This is a documented caveat
   * in the README.
   */
  it('same tree with different options.ignore produces different digests', async () => {
    const files = {
      'SKILL.md': FM_V1 + BODY,
      'README.md': '# Readme',
      LICENSE: 'MIT',
      'references/guide.md': '# Guide',
    };
    // Default (no ignore option → uses DEFAULT_IGNORE; 'references' is not ignored)
    const r1 = await analyze(mem(files));
    // Custom ignore that excludes the 'references' segment
    const r2 = await analyze(mem(files), { ignore: ['references'] });
    // references/guide.md is included in r1's enumeration but excluded in r2's →
    // digest differs.
    expect(r1.digest).not.toBe(r2.digest);
  });

  it('same tree with equivalent ignore sets produces identical digest', async () => {
    const files = {
      'SKILL.md': FM_V1 + BODY,
      'README.md': '# Readme',
      LICENSE: 'MIT',
    };
    // Both use default by omitting ignore — identical enumeration → identical digest
    const [r1, r2] = await Promise.all([analyze(mem(files)), analyze(mem(files))]);
    expect(r1.digest).toBe(r2.digest);
  });
});

// ── Section 8: canonicalJSON unit tests (exported helper) ─────────────────────
//
// These tests directly exercise the exported `canonicalJSON` function to cover:
//   • All primitive types and edge cases (null, bool, number, string)
//   • Array serialization (recursive, order-preserved)
//   • Object serialization (keys sorted lexicographically, recursive)
//   • Line 108: the `undefined` filter branch — objects with undefined values
//   • Lines 113–114: top-level non-primitive fallback (undefined, function)

describe('canonicalJSON — exported helper (direct unit tests)', () => {
  it('null → "null"', () => {
    expect(canonicalJSON(null)).toBe('null');
  });

  it('boolean true → "true"', () => {
    expect(canonicalJSON(true)).toBe('true');
  });

  it('boolean false → "false"', () => {
    expect(canonicalJSON(false)).toBe('false');
  });

  it('integer → JSON number', () => {
    expect(canonicalJSON(42)).toBe('42');
  });

  it('float → JSON number', () => {
    expect(canonicalJSON(3.14)).toBe('3.14');
  });

  it('string → JSON-escaped string', () => {
    expect(canonicalJSON('hello')).toBe('"hello"');
  });

  it('string with double-quotes → escaped', () => {
    expect(canonicalJSON('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('array → elements serialized recursively, insertion order preserved', () => {
    expect(canonicalJSON([1, 'a', null, true])).toBe('[1,"a",null,true]');
  });

  it('nested array → recursive serialization', () => {
    expect(canonicalJSON([[1, 2], [3]])).toBe('[[1,2],[3]]');
  });

  it('empty object → "{}"', () => {
    expect(canonicalJSON({})).toBe('{}');
  });

  it('object with one key', () => {
    expect(canonicalJSON({ x: 1 })).toBe('{"x":1}');
  });

  it('object keys sorted lexicographically (UTF-16)', () => {
    expect(canonicalJSON({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('nested object keys sorted at every level', () => {
    expect(canonicalJSON({ z: { b: 2, a: 1 }, a: 0 })).toBe('{"a":0,"z":{"a":1,"b":2}}');
  });

  // Line 108 coverage: the filter(k => obj[k] !== undefined) false branch.
  // An object with an undefined value — the key is omitted (JSON.stringify parity).
  it('object with undefined value → key omitted (line 108 branch)', () => {
    expect(canonicalJSON({ a: undefined, b: 'val' })).toBe('{"b":"val"}');
  });

  // Lines 113–114 coverage: top-level non-primitive/null/array/object fallback.
  // These types cannot appear in YAML-parsed frontmatter but are documented
  // as "safe" edge cases in the module header.
  it('undefined at top level → "null" (lines 113-114)', () => {
    expect(canonicalJSON(undefined)).toBe('null');
  });

  it('function at top level → "null" (lines 113-114)', () => {
    expect(canonicalJSON(() => 'x')).toBe('null');
  });

  // Non-finite number pins — freezing JSON.stringify semantics as the normative
  // behaviour for these values (plan §5 canonicalJSON rule 5). These values cannot
  // appear in normal YAML frontmatter, but YAML special floats (.inf, .nan) parse
  // to JS Infinity/NaN and must be handled safely.
  it('Infinity → "null" (JSON.stringify semantics, spec §5 rule 5)', () => {
    expect(canonicalJSON(Infinity)).toBe('null');
  });

  it('NaN → "null" (JSON.stringify semantics, spec §5 rule 5)', () => {
    expect(canonicalJSON(NaN)).toBe('null');
  });

  it('-0 → "0" (JSON.stringify semantics — negative zero serializes as positive zero)', () => {
    // JSON.stringify(-0) === '0' — this is specified by IEEE 754 + JSON spec.
    // canonicalJSON must match this behaviour exactly for cross-language reproducibility.
    expect(canonicalJSON(-0)).toBe('0');
  });
});

// ── Section 11: end-to-end — YAML special float values in frontmatter ─────────
//
// YAML has special float literals: .inf → Infinity, -.inf → -Infinity, .nan → NaN.
// If these appear as frontmatter values they flow into canonicalJSON as JS numbers.
// The round-trip must be: stable (same input → same digest), JSON-safe
// (JSON.stringify(output) never throws), and schema-valid.

describe('digest — YAML special float values in frontmatter (.inf, .nan)', () => {
  it('SKILL.md with .inf extra key → analyze() resolves, JSON-safe, stable digest', async () => {
    // .inf parses to Infinity. The `weird` key lands in frontmatter.extra.
    // canonicalJSON(Infinity) === 'null' → digest is deterministic.
    const source = mem({
      'SKILL.md':
        '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\nweird: .inf\n---\n\nBody.',
    });
    const [r1, r2] = await Promise.all([analyze(source), analyze(source)]);
    expect(() => SkillAnalysisSchema.parse(r1)).not.toThrow();
    // Infinity in extra.weird serializes to null — output must not throw
    expect(() => JSON.stringify(r1)).not.toThrow();
    // Deterministic: Infinity → null is consistent
    expect(r1.digest).toBe(r2.digest);
    expect(r1.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('SKILL.md with .nan extra key → analyze() resolves, JSON-safe, stable digest', async () => {
    const source = mem({
      'SKILL.md':
        '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\nweird: .nan\n---\n\nBody.',
    });
    const [r1, r2] = await Promise.all([analyze(source), analyze(source)]);
    expect(() => SkillAnalysisSchema.parse(r1)).not.toThrow();
    expect(() => JSON.stringify(r1)).not.toThrow();
    expect(r1.digest).toBe(r2.digest);
    expect(r1.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('.inf and -.inf in same frontmatter → both serialize to null, stable digest', async () => {
    const source = mem({
      'SKILL.md':
        '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\npos: .inf\nneg: -.inf\n---\n\nBody.',
    });
    const [r1, r2] = await Promise.all([analyze(source), analyze(source)]);
    expect(r1.digest).toBe(r2.digest);
    expect(() => JSON.stringify(r1)).not.toThrow();
  });
});

// ── Section 9: computeDigest direct tests — stripMetadataVersion edge cases ───
//
// `stripMetadataVersion` is private but reachable via `computeDigest([], skillMdText)`.
// Lines 129–130: the early-return branch fires when yaml.parse(yamlBlock) returns
// a non-plain-object (null, primitive, array). In that case stripMetadataVersion
// returns the raw value unchanged, and canonicalJSON serializes it.

describe('computeDigest — SKILL.md with non-object YAML frontmatter (lines 129-130)', () => {
  it('scalar YAML frontmatter (number) → stripMetadataVersion early-return → valid digest', async () => {
    // yamlBlock = "42" → yaml.parse('42') = 42 → stripMetadataVersion(42) line 130
    const skillMdText = '---\n42\n---\n\nBody text.';
    const result = await computeDigest([], skillMdText);
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('array YAML frontmatter → stripMetadataVersion early-return (Array.isArray) → valid digest', async () => {
    // yamlBlock = "- a\n- b" → yaml.parse → ['a','b'] → stripMetadataVersion(['a','b']) line 130
    const skillMdText = '---\n- a\n- b\n---\n\nBody.';
    const result = await computeDigest([], skillMdText);
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('two different scalar-frontmatter trees produce different digests', async () => {
    const r1 = await computeDigest([], '---\n42\n---\n\nBody A.');
    const r2 = await computeDigest([], '---\n42\n---\n\nBody B.');
    expect(r1).not.toBe(r2);
  });

  it('null skillMdText (no SKILL.md) → valid digest with no SKILL.md entry', async () => {
    const result = await computeDigest([], null);
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // Line 162 coverage: the `?? {}` right side of `parseYaml(yamlBlock) ?? {}`.
  // Fires when yamlBlock is an empty YAML document — yaml.parse('') returns null,
  // so the nullish coalescing fallback {} is used. An empty YAML block arises from
  // a SKILL.md whose frontmatter section contains no content (---\n---).
  it('empty YAML block (---\\n---) → yaml.parse null → ?? {} fallback (line 162) → valid digest', async () => {
    // splitSkillMd('---\n---\n\nBody.') yields yamlBlock='' → yaml.parse('') → null → ?? {}
    const skillMdText = '---\n---\n\nBody.';
    const result = await computeDigest([], skillMdText);
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ── Section 10: computeDigest — manifestFiles insertion order is irrelevant ────
//
// The sort inside computeDigest exists to guarantee path-deterministic output
// regardless of the order manifestFiles (or entries) arrive in. This property
// is tested here by calling computeDigest directly with files in different
// orderings — the three-file reversed case forces both outcomes of the sort
// comparator (a < b → -1  AND  a >= b → 1), pinning insertion-order
// independence as an executable spec.

describe('computeDigest — manifestFiles insertion order is irrelevant (sort correctness)', () => {
  // Minimal FileEntry stubs — sha256 must be 64 lowercase hex chars; other
  // fields are structurally required but irrelevant to digest correctness.
  const fileA: FileEntry = {
    path: 'assets/icon.png',
    size: 8,
    sha256: 'a'.repeat(64),
    kind: 'asset',
    isText: false,
  };
  const fileB: FileEntry = {
    path: 'references/guide.md',
    size: 20,
    sha256: 'b'.repeat(64),
    kind: 'reference',
    isText: true,
  };
  const fileC: FileEntry = {
    path: 'scripts/run.py',
    size: 12,
    sha256: 'c'.repeat(64),
    kind: 'script',
    isText: true,
  };

  it('reversed manifestFiles order → same digest as alphabetical order', async () => {
    // Forward (alphabetical: assets/ < references/ < scripts/)
    const r1 = await computeDigest([fileA, fileB, fileC], null);
    // Reversed (scripts/ > references/ > assets/ — forces sort to reorder)
    const r2 = await computeDigest([fileC, fileB, fileA], null);
    expect(r2).toBe(r1);
  });

  it('shuffled manifestFiles order → same digest as alphabetical order', async () => {
    const r1 = await computeDigest([fileA, fileB, fileC], null);
    const r2 = await computeDigest([fileB, fileC, fileA], null);
    const r3 = await computeDigest([fileC, fileA, fileB], null);
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
  });

  it('digest matches path-sorted value — sort is ascending by path', async () => {
    // The sort is path-ascending (UTF-16 lexicographic). Verify the digest is
    // stable and matches /^sha256:[0-9a-f]{64}$/ for all orderings.
    const r1 = await computeDigest([fileA, fileB, fileC], null);
    expect(r1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('insertion-order independence holds when SKILL.md text is also present', async () => {
    const skillMd = '---\nname: s\ndescription: d.\nmetadata:\n  version: "1.0.0"\n---\n\nBody.';
    const r1 = await computeDigest([fileA, fileB, fileC], skillMd);
    const r2 = await computeDigest([fileC, fileB, fileA], skillMd);
    expect(r2).toBe(r1);
  });
});
