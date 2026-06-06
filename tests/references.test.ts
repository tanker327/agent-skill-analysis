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
  docTexts: ReadonlyMap<string, string> = new Map(),
  skillDir: string | null = null,
) {
  const collector = new DiagnosticCollector();
  const result = analyzeReferences(
    bodyText,
    allPaths,
    readmePath,
    licensePath,
    collector,
    docTexts,
    skillDir,
  );
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

  it('a directory reference resolves, not broken, when the directory exists (F10)', () => {
    // [templates/](templates/) points at a real directory — no file path equals
    // 'templates/', but the dir exists in the tree, so it must resolve.
    const body = 'Init from [templates/](templates/).';
    const { result, codes } = runReferences(body, [
      'SKILL.md',
      'templates/a.md',
      'templates/b.yaml',
    ]);
    expect(result.resolved).toContain('templates/');
    expect(result.broken).toEqual([]);
    expect(codes).not.toContain('broken-ref');
  });

  it('a nested directory reference resolves (F10)', () => {
    const body = '[pack](bold-template-pack/templates/)';
    const { result } = runReferences(body, [
      'SKILL.md',
      'bold-template-pack/templates/x/preview.md',
    ]);
    expect(result.resolved).toContain('bold-template-pack/templates/');
    expect(result.broken).toEqual([]);
  });

  it('a reference to a NON-existent directory is still broken (F10 boundary)', () => {
    const body = '[gone](missing-dir/)';
    const { result } = runReferences(body, ['SKILL.md', 'templates/a.md']);
    expect(result.broken).toContain('missing-dir/');
  });

  it('a ./-prefixed link to an existing file resolves, not broken (F12)', () => {
    // [x](./references/a.md) must resolve identically to references/a.md.
    const body = '[a](./references/a.md) and [b](./scripts/b.py)';
    const { result, codes } = runReferences(body, [
      'SKILL.md',
      'references/a.md',
      'scripts/b.py',
    ]);
    expect(result.resolved).toEqual(['./references/a.md', './scripts/b.py']);
    expect(result.broken).toEqual([]);
    expect(codes).not.toContain('broken-ref');
  });

  it('a ./-prefixed directory link resolves (F12 + F10)', () => {
    const body = '[ex](./examples/case/)';
    const { result } = runReferences(body, ['SKILL.md', 'examples/case/notes.md']);
    expect(result.resolved).toEqual(['./examples/case/']);
    expect(result.broken).toEqual([]);
  });

  it('an anchor link file.md#section resolves when the file exists (F13)', () => {
    // The #fragment names a heading, not a path — strip it before resolving.
    const body =
      'See [step 1](references/workflow.md#step-1) and [step 2](references/workflow.md#step-2).';
    const { result, codes } = runReferences(body, ['SKILL.md', 'references/workflow.md']);
    expect(result.broken).toEqual([]);
    expect(result.resolved).toContain('references/workflow.md#step-1');
    expect(result.resolved).toContain('references/workflow.md#step-2');
    expect(codes).not.toContain('broken-ref');
  });

  it('an anchor link to a NON-existent file is still broken (F13 boundary)', () => {
    const body = '[x](references/gone.md#top)';
    const { result } = runReferences(body, ['SKILL.md', 'references/workflow.md']);
    expect(result.broken).toContain('references/gone.md#top');
  });

  it('a link target that normalizes to empty (".") is broken, not resolved (F12 boundary)', () => {
    // '.' / './' normalize to '' — they name no file or directory, so they cannot
    // resolve. Guards the norm === '' branch.
    const body = '[self](.) and [more](./)';
    const { result } = runReferences(body, ['SKILL.md', 'guide.md']);
    expect(result.resolved).toEqual([]);
    expect(result.broken).toContain('.');
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

describe('analyzeReferences — external references (F7)', () => {
  it('a ../sibling reference that exists out-of-folder is external, NOT broken', () => {
    // The hallmark F7 case: SKILL.md links to a sibling skill via `../`. The
    // analyzer cannot see outside its folder, so this is out-of-scope, not a
    // broken (author-error) link.
    const body = 'Prereq: [shared](../lark-shared/SKILL.md).';
    const { result, codes } = runReferences(body, ['SKILL.md']);
    expect(result.external).toEqual(['../lark-shared/SKILL.md']);
    expect(result.broken).toEqual([]);
    expect(codes).toContain('external-ref');
    expect(codes).not.toContain('broken-ref');
  });

  it('declared = resolved ∪ broken ∪ external (complete, disjoint)', () => {
    const body =
      '[ok](references/guide.md) [gone](references/gone.md) [sib](../other/SKILL.md)';
    const { result } = runReferences(body, ['SKILL.md', 'references/guide.md']);
    expect([...result.declared].sort()).toEqual(
      [...result.resolved, ...result.broken, ...result.external].sort(),
    );
    expect(result.external).toEqual(['../other/SKILL.md']);
  });

  it('a .. path that normalizes back inside the folder is NOT external, and resolves (F12)', () => {
    // 'references/../guide.md' normalizes to 'guide.md' — it does not escape the
    // folder (not external) and, since F12 added `.`/`..` normalization to the
    // resolve check, it now correctly RESOLVES to the existing guide.md.
    const body = '[g](references/../guide.md)';
    const { result } = runReferences(body, ['SKILL.md', 'guide.md']);
    expect(result.external).toEqual([]);
    expect(result.broken).toEqual([]);
    expect(result.resolved).toContain('references/../guide.md');
  });

  it('normalizes "." and empty path segments when deciding external vs internal', () => {
    // A messy in-folder spelling with './' and '//' must normalize (dropping the
    // '.' and '' segments) without escaping the folder → not external.
    const body = '[x](.//refs/../keep.md)';
    const { result } = runReferences(body, ['SKILL.md', 'keep.md']);
    expect(result.external).toEqual([]);
  });

  it('a doubly-escaping ../../ reference is external (stacked .. normalization)', () => {
    // '../../shared/x.md' climbs two levels above root — the '..' segments stack
    // (cannot cancel), so it still escapes and is reported as external.
    const body = '[x](../../shared/x.md)';
    const { result } = runReferences(body, ['SKILL.md']);
    expect(result.external).toEqual(['../../shared/x.md']);
  });

  it('external is sorted ascending and emits one external-ref per path', () => {
    const body = '[b](../z/b.md) [a](../a/a.md)';
    const { result, codes } = runReferences(body, ['SKILL.md']);
    expect(result.external).toEqual(['../a/a.md', '../z/b.md']);
    expect(codes.filter((c) => c === 'external-ref')).toHaveLength(2);
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

  it('root-level AGENTS.md is never an orphan (convention file, read by name)', () => {
    // The agents.md convention: agents discover this file by name, like a
    // README — SKILL.md does not have to link it. Case-insensitive.
    for (const name of ['AGENTS.md', 'agents.md']) {
      const { result } = runReferences('Body with no links.', ['SKILL.md', name]);
      expect(result.orphans).toEqual([]);
    }
  });

  it('a NESTED AGENTS.md is still an orphan candidate — only the root file is the convention', () => {
    const { result } = runReferences('Body with no links.', ['SKILL.md', 'docs/AGENTS.md']);
    expect(result.orphans).toEqual(['docs/AGENTS.md']);
  });

  it('AGENTS.md stays excluded when SKILL.md is absent (null body)', () => {
    const { result } = runReferences(null, ['SKILL.md', 'AGENTS.md', 'notes.md']);
    expect(result.orphans).toEqual(['notes.md']);
  });

  it('root-level repo scaffolding docs are not orphans (CONTRIBUTING.md etc., F3)', () => {
    // Community-health files document the project, not the skill, and appear when a
    // skill folder is a repo root — they must not be flagged as orphans.
    for (const name of [
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'CODE_OF_CONDUCT.md',
      'SECURITY.md',
      'SPONSORS.md',
    ]) {
      const { result } = runReferences('Body with no links.', ['SKILL.md', name]);
      expect(result.orphans).toEqual([]);
    }
  });

  it('a NESTED scaffolding doc is still an orphan candidate — only the root file is excluded (F3)', () => {
    const { result } = runReferences('Body with no links.', ['SKILL.md', 'docs/CONTRIBUTING.md']);
    expect(result.orphans).toEqual(['docs/CONTRIBUTING.md']);
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

describe('analyzeReferences — transitive reachability (orphan check only)', () => {
  const docs = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it('SKILL.md → guide.md → script.py: script is NOT an orphan (doc-relative link)', () => {
    const { result } = runReferences(
      'See [guide](references/guide.md).',
      ['SKILL.md', 'references/guide.md', 'scripts/run.py'],
      null,
      null,
      docs({ 'references/guide.md': 'Run [the script](../scripts/run.py) first.' }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('mentions in reachable docs work root-relative too', () => {
    const { result } = runReferences(
      'See [guide](references/guide.md).',
      ['SKILL.md', 'references/guide.md', 'scripts/run.py'],
      null,
      null,
      docs({ 'references/guide.md': 'Run `scripts/run.py` first.' }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('chain depth 3: SKILL.md → a.md → b.md → c.py', () => {
    const { result } = runReferences(
      '[a](docs/a.md)',
      ['SKILL.md', 'docs/a.md', 'docs/b.md', 'scripts/c.py'],
      null,
      null,
      docs({
        'docs/a.md': 'Continue in [b](b.md).',
        // Doc-relative tier-3 raw mention (no trailing path-char after the path).
        'docs/b.md': 'Finally run ../scripts/c.py before anything else.',
      }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('a mention inside an UNREACHABLE doc does not rescue an orphan', () => {
    const { result } = runReferences(
      'No links here.',
      ['SKILL.md', 'notes.md', 'scripts/x.py'],
      null,
      null,
      docs({ 'notes.md': 'Uses scripts/x.py heavily.' }),
    );
    // notes.md is never referenced from SKILL.md → its content must not count.
    expect(result.orphans).toEqual(['notes.md', 'scripts/x.py']);
  });

  it('cyclic doc references terminate and resolve the whole cycle', () => {
    const { result } = runReferences(
      '[a](a.md)',
      ['SKILL.md', 'a.md', 'b.md', 'scripts/c.py'],
      null,
      null,
      docs({
        'a.md': 'See [b](b.md).',
        'b.md': 'Back to [a](a.md), then run `scripts/c.py`.',
      }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('declared/resolved/broken stay direct-from-SKILL.md: sub-doc links never join them', () => {
    const { result, codes } = runReferences(
      '[guide](references/guide.md)',
      ['SKILL.md', 'references/guide.md', 'scripts/run.py'],
      null,
      null,
      docs({ 'references/guide.md': '[run](../scripts/run.py) and [dead](../missing.md)' }),
    );
    expect(result.declared).toEqual(['references/guide.md']);
    expect(result.resolved).toEqual(['references/guide.md']);
    // The dead link inside guide.md is NOT a broken-ref — that lint stays SKILL.md-only.
    expect(result.broken).toEqual([]);
    expect(codes).not.toContain('broken-ref');
  });

  it('R4 boundary matching applies inside reachable docs too', () => {
    const { result } = runReferences(
      '[guide](docs/guide.md)',
      ['SKILL.md', 'docs/guide.md', 'a.md', 'data.md'],
      null,
      null,
      // 'data.md' mentioned; bare 'a.md' must not match inside it.
      docs({ 'docs/guide.md': 'See ../data.md for the table.' }),
    );
    expect(result.orphans).toEqual(['a.md']);
    expect(result.orphans).not.toContain('data.md');
  });
});

describe('analyzeReferences — R4 short-path collision prevention', () => {
  /**
   * R4: path-boundary matching prevents 'a.md' (short) from matching inside
   * 'data.md' (longer). The '.' before 'md' is a path char, but the 'dat'
   * before 'a.md' means the lookbehind [A-Za-z0-9._/-] fires on 't' → no match.
   *
   * Bare-basename mentions ('guide.md' for 'references/guide.md') DO count —
   * but only when exactly one tree file owns that basename and it contains a
   * '.'; ambiguity or extensionless names keep the orphan warning (never guess).
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

  it('bare unique basename DOES match its only owner — references/guide.md resolved', () => {
    // Exactly one tree file is named guide.md → the bare mention counts.
    const body = 'See guide.md for details.';
    const { result } = runReferences(body, ['SKILL.md', 'references/guide.md']);
    expect(result.orphans).not.toContain('references/guide.md');
  });

  it('ambiguous basename does NOT match — both owners stay orphans', () => {
    // Two files share the basename guide.md → a bare mention is ambiguous and
    // must rescue neither (the R4 spirit: never guess).
    const body = 'See `guide.md` for details.';
    const { result } = runReferences(body, ['SKILL.md', 'docs/guide.md', 'references/guide.md']);
    expect(result.orphans).toEqual(['docs/guide.md', 'references/guide.md']);
  });

  it('extensionless unique basename does NOT match prose words', () => {
    // scripts/run has the unique basename 'run' — but bare extensionless names
    // are excluded from basename matching: 'run' in prose must not count.
    const body = 'Now run the tool.';
    const { result } = runReferences(body, ['SKILL.md', 'scripts/run']);
    expect(result.orphans).toContain('scripts/run');
  });
});

describe('analyzeReferences — python module form', () => {
  it('python -m dotted form matches the .py file', () => {
    const body = 'Aggregate with `python -m scripts.aggregate_benchmark` afterwards.';
    const { result } = runReferences(body, ['SKILL.md', 'scripts/aggregate_benchmark.py']);
    expect(result.orphans).toEqual([]);
  });

  it('dotted form works in raw text and nested dirs', () => {
    const body = 'Run python -m tools.eval.runner to start';
    const { result } = runReferences(body, ['SKILL.md', 'tools/eval/runner.py']);
    expect(result.orphans).toEqual([]);
  });

  it('root-level .py files get NO module form — a bare word never matches', () => {
    // run.py at root would have module form 'run'; that must not exist,
    // otherwise the word 'run' in prose silences the orphan warning.
    const body = 'Now run the tool.';
    const { result } = runReferences(body, ['SKILL.md', 'run.py']);
    expect(result.orphans).toContain('run.py');
  });

  it('module form does not apply to non-python files', () => {
    // 'data/set' is not how data/set.json would be mentioned — no dotted form.
    const body = 'Uses data.set internally.';
    const { result } = runReferences(body, ['SKILL.md', 'data/set.json']);
    expect(result.orphans).toContain('data/set.json');
  });
});

describe('analyzeReferences — code-file chains (the reference graph crosses source files)', () => {
  const docs = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it('md → a.py → b.py → c.py: the whole import chain connects', () => {
    const { result } = runReferences(
      'Run `scripts/a.py` to start.',
      ['SKILL.md', 'scripts/a.py', 'scripts/b.py', 'scripts/c.py'],
      null,
      null,
      docs({
        'scripts/a.py': 'from scripts.b import main\n', // absolute dotted import
        'scripts/b.py': 'from .c import helper\n', // relative import
        'scripts/c.py': 'def helper(): pass\n',
      }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('a reachable script rescues a data file it opens by name', () => {
    const { result } = runReferences(
      'Use `eval-viewer/generate_review.py` to render results.',
      ['SKILL.md', 'eval-viewer/generate_review.py', 'eval-viewer/viewer.html'],
      null,
      null,
      docs({
        'eval-viewer/generate_review.py': 'template_path = Path(__file__).parent / "viewer.html"\n',
      }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('a reachable python module marks its ancestor __init__.py reachable', () => {
    const { result } = runReferences(
      'Run `pkg/sub/mod.py` directly.',
      ['SKILL.md', 'pkg/__init__.py', 'pkg/sub/__init__.py', 'pkg/sub/mod.py'],
      null,
      null,
      docs({ 'pkg/sub/mod.py': 'print(1)\n' }),
    );
    // Importing pkg.sub.mod executes both __init__.py files — package plumbing.
    expect(result.orphans).toEqual([]);
  });

  it('absolute import of a sibling package via sys.path resolves (F2: from validators import X)', () => {
    // The docx-skill bug: `python scripts/office/pack.py` puts scripts/office on
    // sys.path, so `from validators import X` reaches scripts/office/validators/.
    // The only spelling present is the bare package name `validators` — neither the
    // path nor a relative-import dot — so pythonSysPathImportForm must produce it.
    const { result } = runReferences(
      'Pack with `scripts/office/pack.py`.',
      [
        'SKILL.md',
        'scripts/office/pack.py',
        'scripts/office/validators/__init__.py',
        'scripts/office/validators/base.py',
      ],
      null,
      null,
      docs({
        'scripts/office/pack.py': 'from validators import DOCXValidator\n',
        'scripts/office/validators/__init__.py': 'from .base import DOCXValidator\n',
        'scripts/office/validators/base.py': 'class DOCXValidator: pass\n',
      }),
    );
    // validators/__init__.py (via `from validators`) AND base.py (via the init's
    // `.base` re-export) are both reachable — no false orphans.
    expect(result.orphans).toEqual([]);
  });

  it('absolute import of a sibling MODULE via sys.path resolves (F2: from helpers import x)', () => {
    const { result } = runReferences(
      'Run `scripts/office/pack.py`.',
      ['SKILL.md', 'scripts/office/pack.py', 'scripts/office/helpers.py'],
      null,
      null,
      docs({ 'scripts/office/pack.py': 'from helpers import merge\n' }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('a root-level source file does not import its own root package __init__ (F2 guard)', () => {
    // Scanning a root-level source file (dir = '') against a root '__init__.py'
    // candidate exercises the empty-module-path guard in pythonSysPathImportForm:
    // the form would be the doc's own package, which it cannot import — so the
    // root __init__.py is not rescued and stays an orphan.
    const { result } = runReferences(
      'Run `app.py`.',
      ['SKILL.md', 'app.py', '__init__.py'],
      null,
      null,
      docs({ 'app.py': 'print("hi")\n' }),
    );
    expect(result.orphans).toContain('__init__.py');
  });

  it('a bare sys.path form does NOT rescue a file OUTSIDE the importing dir (F2 guard)', () => {
    // lib/x.py is NOT under scripts/office, so `from x import` in pack.py must not
    // reach it (it would require '..' — not importable through this sys.path root).
    const { result } = runReferences(
      'Run `scripts/office/pack.py`.',
      ['SKILL.md', 'scripts/office/pack.py', 'lib/x.py'],
      null,
      null,
      docs({ 'scripts/office/pack.py': 'from x import thing\n' }),
    );
    expect(result.orphans).toEqual(['lib/x.py']);
  });

  it('parent-level relative import (..lib.x) connects across packages', () => {
    // Python semantics: in pkg/sub/main.py, '.' is the current package
    // (pkg.sub) and each extra dot goes one level up — '..lib.helpers'
    // denotes pkg/lib/helpers.py (NOT root-level lib/).
    const { result } = runReferences(
      'Run `pkg/sub/main.py` to start.',
      ['SKILL.md', 'pkg/lib/helpers.py', 'pkg/sub/main.py'],
      null,
      null,
      // '..lib.helpers' is the only spelling present: not the path, not the
      // basename in path-char context… the form itself must do the matching.
      docs({ 'pkg/sub/main.py': 'from ..lib.helpers import go\n' }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('__init__.py re-exports keep the chain going (rescue THROUGH the init)', () => {
    const { result } = runReferences(
      'Run `scripts/cli.py` now.',
      ['SKILL.md', 'scripts/__init__.py', 'scripts/cli.py', 'scripts/util_fns.py'],
      null,
      null,
      docs({
        'scripts/cli.py': 'print(1)\n', // mentions nothing itself
        // The package init (reachable via the ancestor rule) re-exports —
        // util_fns is only discoverable by scanning the init's content.
        'scripts/__init__.py': 'from .util_fns import *\n',
      }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('js require chain connects', () => {
    const { result } = runReferences(
      'Start with `lib/a.js`.',
      ['SKILL.md', 'lib/a.js', 'lib/b.js'],
      null,
      null,
      docs({ 'lib/a.js': "const b = require('./b');\n" }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('shell chain connects: md → run.sh → sourced helper → python', () => {
    const { result } = runReferences(
      'Start everything with `scripts/run.sh`.',
      ['SKILL.md', 'scripts/run.sh', 'scripts/helper.sh', 'tools/job.py'],
      null,
      null,
      docs({
        'scripts/run.sh': '#!/bin/bash\nsource ./helper.sh\npython -m tools.job\n',
        'scripts/helper.sh': 'echo helper\n',
      }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('shell $VAR-prefixed paths match: "$SCRIPT_DIR/utils.sh" and "$(dirname "$0")/x"', () => {
    const { result } = runReferences(
      'Run `scripts/run.sh` first.',
      ['SKILL.md', 'scripts/run.sh', 'scripts/utils.sh', 'scripts/cleanup.sh'],
      null,
      null,
      docs({
        'scripts/run.sh':
          '#!/bin/bash\n' +
          'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n' +
          'source "$SCRIPT_DIR/utils.sh"\n' +
          'trap "$(dirname "$0")/cleanup.sh" EXIT\n',
      }),
    );
    expect(result.orphans).toEqual([]);
  });

  it('absolute deploy-mount path /mnt/skills/<skill>/scripts/x.py rescues the script (F19)', () => {
    // A skill referencing its own script only by the absolute mount path must not
    // orphan that script. Matched via the skillDir-anchored `/<dir>/<path>` form.
    const { result } = runReferences(
      'Run `python /mnt/skills/public/data-analysis/scripts/analyze.py --input f.csv`.',
      ['SKILL.md', 'scripts/analyze.py'],
      null,
      null,
      new Map(),
      'data-analysis',
    );
    expect(result.orphans).toEqual([]);
  });

  it('absolute-mount matching needs the exact skill dir; a different dir stays orphan (F19 guard)', () => {
    const { result } = runReferences(
      'Run `python /mnt/skills/public/OTHER-skill/scripts/analyze.py`.',
      ['SKILL.md', 'scripts/analyze.py'],
      null,
      null,
      new Map(),
      'data-analysis',
    );
    expect(result.orphans).toEqual(['scripts/analyze.py']);
  });

  it('brace-template prefix `{baseDir}/scripts/x.sh args` rescues the script (F16)', () => {
    // A doc that references a script via a templated path prefix with trailing CLI
    // args — the path must still be recognized, so the script is not a false orphan.
    const { result } = runReferences(
      'Run `{baseDir}/scripts/find-sessions.sh -S "$SOCKET"` to locate sessions.',
      ['SKILL.md', 'scripts/find-sessions.sh'],
    );
    expect(result.orphans).toEqual([]);
  });

  it('dynamic-prefix matching does not weaken R4: plain dir/ prefixes still never match', () => {
    const { result } = runReferences(
      'Run `scripts/run.sh` first.',
      ['SKILL.md', 'scripts/run.sh', 'utils.sh'],
      null,
      null,
      // 'other/utils.sh' mentions a DIFFERENT utils.sh — the root-level file
      // must stay an orphan ('other' is not a dynamic expansion).
      docs({ 'scripts/run.sh': 'echo see other/utils.sh for details\n' }),
    );
    expect(result.orphans).toEqual(['utils.sh']);
  });

  it('an UNREACHABLE script does not rescue its imports', () => {
    const { result } = runReferences(
      'No file mentions here.',
      ['SKILL.md', 'scripts/a.py', 'scripts/b.py'],
      null,
      null,
      docs({ 'scripts/a.py': 'from scripts.b import x\n' }),
    );
    expect(result.orphans).toEqual(['scripts/a.py', 'scripts/b.py']);
  });

  it('__init__.py of an untouched sibling package stays an orphan', () => {
    const { result } = runReferences(
      'Run `scripts/run.py` now.',
      ['SKILL.md', 'other/__init__.py', 'scripts/run.py'],
      null,
      null,
      docs({ 'scripts/run.py': 'print(1)\n' }),
    );
    // other/ has no reachable module — its __init__.py is not plumbing for anything.
    expect(result.orphans).toEqual(['other/__init__.py']);
  });
});

describe('analyzeReferences — JS/TS import specifier form', () => {
  it("require('./scripts/utils') matches scripts/utils.js", () => {
    const body = "Load helpers with `require('./scripts/utils')` first.";
    const { result } = runReferences(body, ['SKILL.md', 'scripts/utils.js']);
    expect(result.orphans).toEqual([]);
  });

  it('extensionless specifier in raw text matches a .ts file', () => {
    const body = "```js\nimport { run } from 'lib/runner';\n```";
    const { result } = runReferences(body, ['SKILL.md', 'lib/runner.ts']);
    expect(result.orphans).toEqual([]);
  });

  it('ambiguous specifier (utils.js + utils.ts) rescues neither', () => {
    const body = "See `require('./scripts/utils')` for helpers.";
    const { result } = runReferences(body, ['SKILL.md', 'scripts/utils.js', 'scripts/utils.ts']);
    expect(result.orphans).toEqual(['scripts/utils.js', 'scripts/utils.ts']);
  });

  it('specifier shadowed by a real extensionless file never matches the JS file', () => {
    // A real file named scripts/utils exists — the mention belongs to it.
    const body = 'Uses `scripts/utils` directly.';
    const { result } = runReferences(body, ['SKILL.md', 'scripts/utils', 'scripts/utils.js']);
    expect(result.orphans).toEqual(['scripts/utils.js']);
  });

  it('root-level JS files get NO specifier form — a bare word never matches', () => {
    // index.js at root would have specifier 'index' — too loose for prose.
    const body = 'See the index for details.';
    const { result } = runReferences(body, ['SKILL.md', 'index.js']);
    expect(result.orphans).toContain('index.js');
  });
});

describe('analyzeReferences — ./-anchored spellings', () => {
  it('./-anchored full path matches from SKILL.md', () => {
    const body = 'Run `./scripts/run.py` to start.';
    const { result } = runReferences(body, ['SKILL.md', 'scripts/run.py']);
    expect(result.orphans).toEqual([]);
  });

  it('./-anchored same-dir mention works inside a reachable sub-doc', () => {
    const { result } = runReferences(
      '[guide](references/guide.md)',
      ['SKILL.md', 'references/guide.md', 'references/data.csv'],
      null,
      null,
      new Map([['references/guide.md', 'Columns are described in `./data.csv` rows.']]),
    );
    expect(result.orphans).toEqual([]);
  });

  it("'./scripts/x' inside a sub-doc is doc-relative — it does NOT match a root file", () => {
    const { result } = runReferences(
      '[guide](docs/guide.md)',
      ['SKILL.md', 'docs/guide.md', 'scripts/x.py'],
      null,
      null,
      // './scripts/x.py' written in docs/guide.md denotes docs/scripts/x.py,
      // which does not exist — the root scripts/x.py must stay an orphan.
      new Map([['docs/guide.md', 'Run `./scripts/x.py` now.']]),
    );
    expect(result.orphans).toEqual(['scripts/x.py']);
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

  it('transitive chain: SKILL.md → guide.md → scripts, only the unmentioned script orphans', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Read [the guide](references/guide.md) first.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'references/guide.md': 'Run [run](../scripts/run.py), then `../scripts/utils.py`.',
        'scripts/run.py': 'print(1)',
        'scripts/utils.py': 'print(2)',
        'scripts/lone.py': 'print(3)',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    expect(result.references.orphans).toEqual(['scripts/lone.py']);
    // The contract arrays stay direct-from-SKILL.md.
    expect(result.references.declared).toEqual(['references/guide.md']);
    expect(result.diagnostics.filter((d) => d.code === 'orphan-file')).toHaveLength(1);
  });

  it('code chain via analyze(): md → a.py → b.py → c.py plus __init__.py all connect', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Run `scripts/a.py` to start.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'scripts/__init__.py': '',
        'scripts/a.py': 'from scripts.b import main\n',
        'scripts/b.py': 'from .c import helper\n',
        'scripts/c.py': 'def helper(): pass\n',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    expect(result.references.orphans).toEqual([]);
    expect(result.diagnostics.filter((d) => d.code === 'orphan-file')).toEqual([]);
  });

  it('a binary .md file resolves but is never scanned for onward references', async () => {
    const result = await analyze(
      fromFiles({
        'SKILL.md': FM + 'See [bin](bin.md) for the blob.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'bin.md': new Uint8Array([0x00, 0x9f, 0x92, 0x96]), // null byte → isText: false
        'scripts/x.py': 'print(1)',
      }),
    );
    // bin.md is referenced (resolved, not orphan) but unscannable —
    // a mention it might contain cannot rescue scripts/x.py.
    expect(result.references.resolved).toContain('bin.md');
    expect(result.references.orphans).toEqual(['scripts/x.py']);
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
