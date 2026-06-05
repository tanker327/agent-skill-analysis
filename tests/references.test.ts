/**
 * Unit and integration tests for P4 reference graph pipeline (stage ⑩).
 *
 * Stage ⑩ (flow §4) derives four sets from the SKILL.md body and the manifest:
 *
 *   declared  — unique relative paths linked in the body (from scanMarkdown
 *               linkTargets, relative-path filter, deduplicated, sorted asc).
 *               declared = resolved ∪ broken.
 *
 *   resolved  — declared paths that exist in files[], sorted asc.
 *
 *   broken    — declared paths NOT in files[], sorted asc.
 *               Emits 'broken-ref' (warning) per broken path.
 *
 *   orphans   — files present but not referenced anywhere in the body.
 *               SKILL.md, README, LICENSE excluded from orphan candidates.
 *               Emits 'orphan-file' (warning) per orphan path.
 *
 * Orphan detection uses three complementary tiers (first match = referenced):
 *   1. Exact match in markdown linkTargets (explicit links).
 *   2. Exact match in inlineCode spans (backtick-quoted paths).
 *   3. Path-boundary regex in raw body — prevents R4 short-path collision.
 *
 * R4 short-path collision (plan §4 R4):
 *   A short path like 'guide.md' must NOT match within 'references/guide.md'.
 *   The lookbehind uses [A-Za-z0-9._/-] so the '/' before 'guide' fails the
 *   lookbehind → no match. Similarly 'a.md' must not match within 'data.md'.
 *
 * Section 0: pure unit tests (analyzeReferences)
 * Section 1: integration tests via analyze()
 */
import { describe, expect, it } from 'vitest';
import { analyze, fromFiles, SkillAnalysisSchema } from '../src/index.js';
import { analyzeReferences } from '../src/references.js';
import { DiagnosticCollector } from '../src/diagnostics.js';
import { mem } from './helpers.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Minimal frontmatter prefix — keeps fixtures short and avoids P1 diagnostics. */
const FM =
  '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\n---\n\n';

/**
 * Thin wrapper: run analyzeReferences and return result + emitted codes.
 * Matches the current signature: (bodyText | null, allPaths: readonly string[], readmePath, licensePath, collector).
 */
function runReferences(
  bodyText: string | null,
  allPaths: string[],
  readmePath: string | null = null,
  licensePath: string | null = null,
) {
  const collector = new DiagnosticCollector();
  const result = analyzeReferences(bodyText, allPaths, readmePath, licensePath, collector);
  return { result, codes: collector.all().map((d) => d.code) };
}

// ── Section 0: pure unit tests ────────────────────────────────────────────────

describe('analyzeReferences — declared (markdown link targets)', () => {
  it('empty body → empty declared', () => {
    const { result } = runReferences('', []);
    expect(result.declared).toEqual([]);
  });

  it('body with no links → empty declared', () => {
    const { result } = runReferences('No links here. Just plain text.', []);
    expect(result.declared).toEqual([]);
  });

  it('markdown link → path appears in declared', () => {
    const { result } = runReferences('[guide](references/guide.md)', []);
    expect(result.declared).toContain('references/guide.md');
  });

  it('multiple distinct links → all appear in declared, sorted asc', () => {
    const body = '[b](references/b.md) and [a](references/a.md) and [c](scripts/c.py)';
    const { result } = runReferences(body, []);
    expect(result.declared).toEqual(['references/a.md', 'references/b.md', 'scripts/c.py']);
  });

  it('duplicate links → deduplicated in declared', () => {
    const body = '[a](references/guide.md) and [b](references/guide.md)';
    const { result } = runReferences(body, []);
    const count = result.declared.filter((p) => p === 'references/guide.md').length;
    expect(count).toBe(1);
  });

  it('empty link target [text]() is excluded from declared (length guard in isRelativePath)', () => {
    // [text]() produces an empty string link target in scanMarkdown.
    // isRelativePath's first guard (target.length === 0) catches it.
    const { result } = runReferences('[empty]()', []);
    expect(result.declared).not.toContain('');
    expect(result.declared).toHaveLength(0);
  });

  it('fragment-only refs (#section) are excluded from declared', () => {
    const { result } = runReferences('[sec](#section)', []);
    expect(result.declared).not.toContain('#section');
    expect(result.declared).toHaveLength(0);
  });

  it('http:// URLs are excluded from declared (URI scheme filter)', () => {
    const { result } = runReferences('[ext](https://example.com/doc.md)', []);
    expect(result.declared).not.toContain('https://example.com/doc.md');
    expect(result.declared).toHaveLength(0);
  });

  it('mailto: and data: URIs are excluded from declared', () => {
    const body = '[email](mailto:user@example.com) [data](data:text/plain,hi)';
    const { result } = runReferences(body, []);
    expect(result.declared).toHaveLength(0);
  });

  it('null bodyText → declared is empty', () => {
    const { result } = runReferences(null, []);
    expect(result.declared).toEqual([]);
  });
});

describe('analyzeReferences — resolved and broken', () => {
  it('declared path that exists in files → resolved, not broken', () => {
    const body = '[guide](references/guide.md)';
    const { result } = runReferences(body, ['SKILL.md', 'references/guide.md']);
    expect(result.resolved).toContain('references/guide.md');
    expect(result.broken).not.toContain('references/guide.md');
  });

  it('declared path not in files → broken, not resolved', () => {
    const body = '[missing](references/missing.md)';
    const { result } = runReferences(body, ['SKILL.md']);
    expect(result.broken).toContain('references/missing.md');
    expect(result.resolved).not.toContain('references/missing.md');
  });

  it('declared = resolved ∪ broken (disjoint, complete)', () => {
    const body = '[exists](references/guide.md) [gone](references/gone.md)';
    const { result } = runReferences(body, ['SKILL.md', 'references/guide.md']);
    const declaredSorted = [...result.declared].sort();
    const unionSorted = [...result.resolved, ...result.broken].sort();
    expect(declaredSorted).toEqual(unionSorted);
  });

  it('broken-ref emitted once per broken path', () => {
    const body = '[a](missing/a.md) [b](missing/b.md)';
    const { codes } = runReferences(body, ['SKILL.md']);
    expect(codes.filter((c) => c === 'broken-ref')).toHaveLength(2);
  });

  it('no broken-ref emitted when all declared paths are resolved', () => {
    const body = '[guide](references/guide.md)';
    const { codes } = runReferences(body, ['SKILL.md', 'references/guide.md']);
    expect(codes).not.toContain('broken-ref');
  });

  it('resolved and broken are sorted ascending', () => {
    const body = '[b](references/b.md) [a](references/a.md) [x](missing/x.md) [c](missing/c.md)';
    const { result } = runReferences(body, ['SKILL.md', 'references/a.md', 'references/b.md']);
    expect(result.resolved).toEqual([...result.resolved].sort());
    expect(result.broken).toEqual([...result.broken].sort());
  });
});

describe('analyzeReferences — orphans', () => {
  it('unreferenced file → appears in orphans', () => {
    const { result } = runReferences('Body with no links.', [
      'SKILL.md',
      'references/unreferenced.md',
    ]);
    expect(result.orphans).toContain('references/unreferenced.md');
  });

  it('orphan-file emitted once per orphan', () => {
    const { codes } = runReferences('No links.', [
      'SKILL.md',
      'references/a.md',
      'references/b.md',
    ]);
    expect(codes.filter((c) => c === 'orphan-file')).toHaveLength(2);
  });

  it('file explicitly linked → NOT an orphan (tier-1: linkTargets)', () => {
    const body = '[guide](references/guide.md)';
    const { result } = runReferences(body, ['SKILL.md', 'references/guide.md']);
    expect(result.orphans).not.toContain('references/guide.md');
  });

  it('file in backtick inline-code → NOT an orphan (tier-2: inlineCode)', () => {
    const body = 'See `references/guide.md` for details.';
    const { result } = runReferences(body, ['SKILL.md', 'references/guide.md']);
    // Backtick mention counts as referenced → not an orphan
    expect(result.orphans).not.toContain('references/guide.md');
  });

  it('file mentioned at word boundary in raw body → NOT an orphan (tier-3: regex)', () => {
    // Plain mention in prose (not a link or backtick) — path appears at word boundary
    const body = 'This skill uses references/guide.md for lookup.';
    const { result } = runReferences(body, ['SKILL.md', 'references/guide.md']);
    expect(result.orphans).not.toContain('references/guide.md');
  });

  it('SKILL.md is never an orphan', () => {
    const { result } = runReferences('Body.', ['SKILL.md']);
    expect(result.orphans).not.toContain('SKILL.md');
  });

  it('README path is excluded from orphan candidates', () => {
    const { result } = runReferences('Body.', ['SKILL.md', 'README.md'], 'README.md', null);
    expect(result.orphans).not.toContain('README.md');
  });

  it('LICENSE path is excluded from orphan candidates', () => {
    const { result } = runReferences('Body.', ['SKILL.md', 'LICENSE'], null, 'LICENSE');
    expect(result.orphans).not.toContain('LICENSE');
  });

  it('orphans are sorted ascending', () => {
    const { result } = runReferences('Body.', [
      'SKILL.md',
      'scripts/c.py',
      'references/a.md',
      'assets/b.png',
    ]);
    expect(result.orphans).toEqual([...result.orphans].sort());
  });
});

describe('analyzeReferences — R4 short-path collision prevention', () => {
  /**
   * R4: path-boundary matching prevents 'a.md' (short) from matching inside
   * 'data.md' (longer). The '.' before 'md' is a path char, but the 'dat'
   * before 'a.md' means the lookbehind [A-Za-z0-9._/-] fires on 't' → no match.
   *
   * Similarly, 'guide.md' must NOT match within 'references/guide.md' because
   * the '/' before 'guide' is in the path-char class → lookbehind fires → no match.
   */
  it('a.md does NOT match within data.md — a.md is an orphan', () => {
    // body links only to data.md; a.md exists but must remain orphan
    const body = '[data](data.md)';
    const { result } = runReferences(body, ['SKILL.md', 'a.md', 'data.md']);
    expect(result.orphans).toContain('a.md');
    expect(result.orphans).not.toContain('data.md');
  });

  it('short-name in backtick does NOT match longer path — orphan stays', () => {
    // body has `a.md` in backticks; references/a.md is a different path
    const body = 'Use `a.md` from root.';
    const { result } = runReferences(body, ['SKILL.md', 'a.md', 'references/a.md']);
    // a.md (root) should be referenced via inlineCode tier
    expect(result.orphans).not.toContain('a.md');
    // references/a.md has a different path — not mentioned anywhere → orphan
    expect(result.orphans).toContain('references/a.md');
  });

  it('guide.md does NOT match within references/guide.md — longer path is orphan', () => {
    // body mentions only "guide.md" at word boundary (tier-3), not references/guide.md
    const body = 'See guide.md for details.';
    const { result } = runReferences(body, ['SKILL.md', 'references/guide.md']);
    // 'references/guide.md' has '/' before 'guide' — lookbehind fires → not matched
    expect(result.orphans).toContain('references/guide.md');
  });
});

describe('analyzeReferences — null bodyText (SKILL.md absent)', () => {
  it('null body → declared/resolved/broken are empty', () => {
    const { result } = runReferences(null, ['SKILL.md', 'references/guide.md']);
    expect(result.declared).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.broken).toEqual([]);
  });

  it('null body → all non-excluded files become orphans', () => {
    const { result } = runReferences(null, ['SKILL.md', 'references/guide.md'], null, null);
    // SKILL.md excluded; references/guide.md is orphan
    expect(result.orphans).toContain('references/guide.md');
    expect(result.orphans).not.toContain('SKILL.md');
  });
});

// ── Section 1: integration tests via analyze() ────────────────────────────────

describe('references — integration (analyze)', () => {
  it('full skill: link to existing file → resolved, not broken or orphan', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'See [guide](references/guide.md) for details.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'references/guide.md': '# Guide',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    expect(result.references.resolved).toContain('references/guide.md');
    expect(result.references.broken).not.toContain('references/guide.md');
    expect(result.references.orphans).not.toContain('references/guide.md');
  });

  it('link to non-existent file → broken + broken-ref diagnostic', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'See [guide](references/missing.md) for details.',
        'README.md': '# R',
        LICENSE: 'MIT',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    expect(result.references.broken).toContain('references/missing.md');
    expect(result.references.resolved).not.toContain('references/missing.md');
    const diag = result.diagnostics.find((d) => d.code === 'broken-ref');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warning');
    expect(diag?.field).toBe('references/missing.md');
  });

  it('file exists but not referenced anywhere → orphan + orphan-file diagnostic', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body with no links.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'references/guide.md': '# Guide',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    expect(result.references.orphans).toContain('references/guide.md');
    const diag = result.diagnostics.find((d) => d.code === 'orphan-file');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warning');
    expect(diag?.field).toBe('references/guide.md');
  });

  it('R4: body mentions data.md — a.md is an orphan (no substring collision)', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'See [data.md](data.md) for raw data.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'a.md': '# A',
        'data.md': '# Data',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    // data.md is referenced explicitly → resolved
    expect(result.references.resolved).toContain('data.md');
    // a.md not referenced → orphan (R4: 'a.md' substring inside 'data.md' does NOT count)
    expect(result.references.orphans).toContain('a.md');
  });

  it('backtick mention prevents orphan even without explicit link', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Use `references/guide.md` to learn more.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'references/guide.md': '# Guide',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    // Mentioned in backtick → not orphan
    expect(result.references.orphans).not.toContain('references/guide.md');
    // Backtick mention is NOT in declared (declared is link targets only)
    expect(result.references.declared).not.toContain('references/guide.md');
  });

  it('glob-style link is treated as a broken-ref (known false positive — documented behavior)', async () => {
    // Glob patterns in markdown links are not real file paths — they land in declared+broken.
    // This is a known limitation documented in the README (F3).
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'See [all scripts](scripts/*.py) for examples.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'scripts/run.py': 'pass',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    // 'scripts/*.py' declared (link target), not in files[] → broken
    expect(result.references.declared).toContain('scripts/*.py');
    expect(result.references.broken).toContain('scripts/*.py');
    // broken-ref emitted (warning — F3 high false-positive is known)
    expect(result.diagnostics.some((d) => d.code === 'broken-ref')).toBe(true);
  });

  it('README and LICENSE are never orphans even if not explicitly linked', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body with no links to any files.',
        'README.md': '# Readme',
        LICENSE: 'MIT License',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    expect(result.references.orphans).not.toContain('README.md');
    expect(result.references.orphans).not.toContain('LICENSE');
  });

  it('SKILL.md is never an orphan', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# R',
        LICENSE: 'MIT',
      }),
    );
    expect(result.references.orphans).not.toContain('SKILL.md');
  });

  // ── Over-limit files and the reference universe ──────────────────────────────
  // Team-lead ruling (P4 gate): over-limit files exist in the tree — they are
  // just unhashed. They remain in the resolution universe for declared/resolved
  // and in the orphan-candidate set. They must NOT become broken-ref simply
  // because they are absent from files[].

  it('over-limit file referenced in body → resolved (not broken), absent from files[], file-too-large emitted', async () => {
    // references/large.md exceeds maxFileBytes → absent from files[], but it EXISTS
    // in the skill tree. A body link to it must resolve (tree presence), not break.
    const source = fromFiles({
      'SKILL.md': FM + 'See [guide](references/large.md) for details.',
      'README.md': '# R',
      LICENSE: 'MIT',
      'references/large.md': 'x'.repeat(300), // 300 bytes > 200 limit
    });
    const result = await analyze(source, { maxFileBytes: 200 });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    // Absent from manifest (unhashed)
    expect(result.files.find((f) => f.path === 'references/large.md')).toBeUndefined();
    // Declared (body links to it) and RESOLVED (exists in tree) — not broken
    expect(result.references.declared).toContain('references/large.md');
    expect(result.references.resolved).toContain('references/large.md');
    expect(result.references.broken).not.toContain('references/large.md');
    // file-too-large emitted (F4 never-silent)
    expect(result.diagnostics.find((d) => d.code === 'file-too-large')).toBeDefined();
  });

  it('over-limit file NOT referenced in body → orphan candidate, absent from files[], file-too-large emitted', async () => {
    // references/large.md exceeds maxFileBytes and is not linked from body.
    // It still exists in the tree → orphan (not referenced), not absent from universe.
    const source = fromFiles({
      'SKILL.md': FM + 'Body with no file references.',
      'README.md': '# R',
      LICENSE: 'MIT',
      'references/large.md': 'x'.repeat(300), // 300 bytes > 200 limit
    });
    const result = await analyze(source, { maxFileBytes: 200 });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    // Absent from manifest (unhashed)
    expect(result.files.find((f) => f.path === 'references/large.md')).toBeUndefined();
    // Not referenced → orphan
    expect(result.references.orphans).toContain('references/large.md');
    // file-too-large emitted
    expect(result.diagnostics.find((d) => d.code === 'file-too-large')).toBeDefined();
  });

  it('all reference arrays are sorted ascending', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'See [b](references/b.md) and [a](missing/a.md) and [c](references/c.md).',
        'README.md': '# R',
        LICENSE: 'MIT',
        'references/b.md': '# B',
        'references/c.md': '# C',
        'references/unreferenced.md': '# U',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    expect(result.references.declared).toEqual([...result.references.declared].sort());
    expect(result.references.resolved).toEqual([...result.references.resolved].sort());
    expect(result.references.broken).toEqual([...result.references.broken].sort());
    expect(result.references.orphans).toEqual([...result.references.orphans].sort());
  });
});
