/**
 * Pipeline stage ⑩: reference graph.
 *
 * Derives three reference sets and an orphan list from the body text and
 * the manifest produced by stage ⑨:
 *
 *   declared  — unique relative paths linked in the SKILL.md body
 *               (from scanMarkdown linkTargets), sorted ascending.
 *               declared = resolved ∪ broken.
 *
 *   resolved  — declared paths that exist in files[], sorted ascending.
 *
 *   broken    — declared paths that do NOT exist in files[], sorted ascending.
 *               Emits 'broken-ref' (warning) for each broken path.
 *
 *   orphans   — files not reachable from SKILL.md through any chain of
 *               references (SKILL.md, README, LICENSE excluded from
 *               candidates). Emits 'orphan-file' (warning) per orphan path.
 *
 * Transitive reachability (orphan check ONLY — declared/resolved/broken stay
 * direct-from-SKILL.md by design):
 *   BFS from the SKILL.md body through every referenced text file whose text
 *   was supplied in `fileTexts` — markdown docs AND source files alike, so
 *   SKILL.md → guide.md → a.py → b.py chains all connect. A candidate counts
 *   as referenced when ANY reachable file mentions it under an accepted
 *   spelling:
 *     • its root-relative path;
 *     • the path written relative to the mentioning file's own directory
 *       (markdown links, code-level relative paths), optionally './'-anchored;
 *     • the extensionless JS/TS import specifier ('scripts/utils' for
 *       scripts/utils.js — require()/import style), same variants, skipped
 *       when ambiguous;
 *     • its bare basename, when exactly one tree file owns that basename and
 *       it contains a '.' (ambiguity or extensionless names never match);
 *     • the `python -m` dotted module form for non-root .py files
 *       ('scripts/run_eval.py' ← 'scripts.run_eval'), and the relative-import
 *       form seen from the scanning file ('.utils', '..lib.x').
 *   Plus python package plumbing: a reachable module marks its ancestor
 *   packages' __init__.py reachable (imports execute them).
 *   Files that are not themselves reachable from SKILL.md are never scanned:
 *   an agent can only find files by following references from SKILL.md, so a
 *   mention inside an unreachable file must not silence a legitimate orphan
 *   warning.
 *
 * Reference detection per scanned markdown file uses three complementary
 * strategies (non-markdown text files use tier 3 only — running the markdown
 * scanner on source code would extract meaningless links/spans):
 *   1. Exact match in scanMarkdown linkTargets (explicit markdown links).
 *   2. Exact match in scanMarkdown inlineCode spans (backtick mentions).
 *   3. Path-boundary word match in the raw text — NOT bare substring.
 *
 * Path-boundary matching (R4 — short-path collision prevention):
 *   A file at 'references/guide.md' is matched by the pattern:
 *     (?<![A-Za-z0-9._/\-])references\/guide\.md(?![A-Za-z0-9._/\-])
 *   The negative lookbehind/lookahead use path-character set [A-Za-z0-9._/-]
 *   so that 'guide.md' (short) does NOT match within 'references/guide.md'
 *   (the '/' before 'guide' is a path char → lookbehind fails → no match).
 *
 * This module is pure (no I/O). All inputs are already-computed strings.
 */

import type { DiagnosticCollector } from './diagnostics.js';
import { scanMarkdown } from './markdown.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Paths always excluded from orphan candidates.
 * README and LICENSE paths are added dynamically from the docs stage results.
 */
const STATIC_ORPHAN_EXCLUSIONS = new Set(['SKILL.md']);

/**
 * Escape a string for use as a literal pattern in a RegExp.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Characters that can appear inside a file path reference.
 * Used in the negative lookaround to define path-character boundaries.
 * Including '/' prevents a short-path segment from matching within a longer path.
 */
const PATH_CHAR_CLASS = '[A-Za-z0-9._/\\-]';

/**
 * Determine whether `filePath` is referenced anywhere in the SKILL.md body.
 *
 * Three tiers (first match wins):
 *   1. linkTargets  — exact inclusion (from explicit markdown link syntax).
 *   2. inlineCode   — exact inclusion (backtick span content).
 *   3. raw body     — path-boundary match via regex (prevents short-path
 *                     collision, R4).
 */
function isReferenced(
  filePath: string,
  linkTargets: readonly string[],
  inlineCode: readonly string[],
  bodyText: string,
): boolean {
  // Tier 1: explicit markdown link
  if (linkTargets.includes(filePath)) return true;

  // Tier 2: backtick inline code span
  if (inlineCode.includes(filePath)) return true;

  // Tier 3: path-boundary match in raw body text (R4 short-path collision guard)
  // The lookbehind/lookahead use PATH_CHAR_CLASS so that a short path like
  // 'guide.md' cannot match inside 'references/guide.md' (the '/' separating
  // them is a path char, so the lookbehind fails).
  const re = new RegExp(`(?<!${PATH_CHAR_CLASS})${escapeRegex(filePath)}(?!${PATH_CHAR_CLASS})`);
  return re.test(bodyText);
}

/** POSIX dirname on a root-relative path: '' for root-level files. */
function dirnamePosix(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** POSIX basename: the final path segment. */
function basenamePosix(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/**
 * The `python -m` dotted module spelling of a .py path:
 * 'scripts/aggregate_benchmark.py' → 'scripts.aggregate_benchmark'.
 * Null for non-.py files AND for root-level scripts ('run.py' → bare 'run'
 * would match the plain English word in prose — far too loose).
 */
function pythonModuleForm(p: string): string | null {
  if (!p.endsWith('.py') || !p.includes('/')) return null;
  return p.slice(0, -'.py'.length).split('/').join('.');
}

/**
 * The relative-import spelling of a .py candidate as written from a file in
 * `fromDir`: scripts/utils.py seen from scripts/ → '.utils';
 * lib/x.py seen from scripts/ → '..lib.x' (one extra leading dot per '../').
 * Null for non-.py candidates.
 */
function pythonRelativeImportForm(fromDir: string, p: string): string | null {
  if (!p.endsWith('.py')) return null;
  const rel = relativeFromDir(fromDir, p.slice(0, -'.py'.length));
  const segs = rel.split('/');
  let ups = 0;
  while (ups < segs.length && segs[ups] === '..') ups++;
  return '.'.repeat(ups + 1) + segs.slice(ups).join('.');
}

/** Extensions whose files are imported by extensionless specifier in JS/TS. */
const JS_EXTENSION_RE = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$/;

/**
 * The extensionless import-specifier spelling of a JS/TS path:
 * 'scripts/utils.js' → 'scripts/utils' (as in `require('./scripts/utils')`).
 * Null for non-JS/TS files and for root-level files ('index' would match
 * plain prose words). Path-shaped — callers add doc-relative/'./' variants.
 */
function jsSpecifierForm(p: string): string | null {
  if (!p.includes('/') || !JS_EXTENSION_RE.test(p)) return null;
  return p.replace(JS_EXTENSION_RE, '');
}

/**
 * The path of `to` (root-relative) as written relative to `fromDir`
 * ('' = skill root). Pure string math on already-normalized POSIX paths:
 * relativeFromDir('references', 'scripts/run.py') → '../scripts/run.py'
 * relativeFromDir('references', 'references/a.md') → 'a.md'
 */
function relativeFromDir(fromDir: string, to: string): string {
  if (fromDir === '') return to;
  const fromParts = fromDir.split('/');
  const toParts = to.split('/');
  let common = 0;
  while (common < fromParts.length && fromParts[common] === toParts[common]) common++;
  const ups = fromParts.length - common;
  return [...Array<string>(ups).fill('..'), ...toParts.slice(common)].join('/');
}

/**
 * Return true when a link target string looks like a relative file path.
 *
 * Excludes:
 *   - Fragment-only refs  (#section)
 *   - Any URI scheme      (http://, https://, mailto:, data:, etc.)
 *   - Empty strings
 *
 * Note: absolute paths (/usr/...) pass this filter and will land in `broken`
 * (they won't match any file in the manifest). That is acceptable.
 */
function isRelativePath(target: string): boolean {
  /* v8 ignore next -- defensive guard: extractLinkTargets already filters empty targets (markdown.ts) */
  if (target.length === 0) return false;
  if (target.startsWith('#')) return false;
  // URI scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"  (RFC 3986 §3.1)
  return !/^[A-Za-z][A-Za-z0-9+\-.]*:/.test(target);
}

// ── Public types ──────────────────────────────────────────────────────────────

/** Result returned by `analyzeReferences`, consumed by `analyze.ts`. */
export interface ReferencesResult {
  /** Unique relative paths declared (linked) in the body; sorted ascending. */
  declared: string[];
  /** declared paths that exist in the skill tree; sorted ascending. */
  resolved: string[];
  /** declared paths that do NOT exist in the skill tree; sorted ascending. */
  broken: string[];
  /** Skill-tree paths that are unreferenced (SKILL.md/README/LICENSE excluded). */
  orphans: string[];
}

// ── Stage ⑩ ───────────────────────────────────────────────────────────────────

/**
 * Stage ⑩: compute the reference graph.
 *
 * Pure function — no I/O. Operates on already-computed path lists and body text.
 *
 * `allPaths` is the full post-ignore sorted path list from stage ① — it INCLUDES
 * over-limit files that were excluded from the manifest. Using the full set here
 * keeps the semantics correct:
 *   - A body link to an over-limit file → resolved (the file exists in the tree)
 *   - An unreferenced over-limit file   → orphan candidate as usual
 *   - Over-limit files remain absent from files[] and size (file-too-large handles them)
 *
 * @param bodyText    SKILL.md body text; null when SKILL.md is absent.
 * @param allPaths    Full post-ignore path list from stage ① (sorted ascending).
 * @param readmePath  Detected README path (from docs stage) or null.
 * @param licensePath Detected LICENSE path (from docs stage) or null.
 * @param collector   Receives 'broken-ref' and 'orphan-file' diagnostics.
 * @param fileTexts   Decoded text of scannable files, keyed by root-relative
 *                    path (analyze.ts supplies every in-manifest text file —
 *                    markdown, source code, html, …; SKILL.md itself is
 *                    `bodyText`). Only files in this map that are reachable
 *                    from SKILL.md are scanned for the transitive orphan
 *                    check — keeps this stage pure (no IO).
 */
export function analyzeReferences(
  bodyText: string | null,
  allPaths: readonly string[],
  readmePath: string | null,
  licensePath: string | null,
  collector: DiagnosticCollector,
  fileTexts: ReadonlyMap<string, string> = new Map(),
): ReferencesResult {
  // Build the exclusion set for orphan candidates.
  const excluded = new Set(STATIC_ORPHAN_EXCLUSIONS);
  if (readmePath !== null) excluded.add(readmePath);
  if (licensePath !== null) excluded.add(licensePath);

  // Full path set — includes over-limit files so resolved/broken are correct.
  const allPathsSet = new Set(allPaths);

  // Non-excluded paths are orphan candidates regardless of manifest filtering.
  const orphanCandidates = allPaths.filter((p) => !excluded.has(p));

  // When SKILL.md is absent there is no body to scan.
  // All non-excluded paths are orphans; declared/resolved/broken stay empty.
  if (bodyText === null) {
    const orphans = [...orphanCandidates].sort();
    for (const p of orphans) {
      collector.emit('orphan-file', { field: p });
    }
    return { declared: [], resolved: [], broken: [], orphans };
  }

  const scan = scanMarkdown(bodyText);

  // declared = unique relative link-target paths from the body, sorted.
  const declared = [...new Set(scan.linkTargets.filter(isRelativePath))].sort();

  // resolved / broken split against the full post-ignore path set.
  const resolved = declared.filter((p) => allPathsSet.has(p));
  const broken = declared.filter((p) => !allPathsSet.has(p));

  // Emit broken-ref diagnostic for every broken path.
  for (const p of broken) {
    collector.emit('broken-ref', { field: p });
  }

  // ── Transitive reachability (orphan check only) ────────────────────────────
  // BFS from SKILL.md through every referenced text file — markdown docs AND
  // source files (SKILL.md → guide.md → a.py → b.py chains all connect).
  // `scannedDocs` is the worklist; for-of visits entries appended during
  // iteration. Each scanned file checks every tree path under its accepted
  // spellings (see below). A referenced file with text in fileTexts joins the
  // worklist exactly once (`enqueued`). Deterministic: allPaths is sorted,
  // reachability is order-independent, and fileTexts is lookup-only.

  // Spellings per path come in two kinds:
  //
  // Path-shaped (each also matched doc-relative and './'-anchored per doc):
  //   • the root-relative path itself;
  //   • the extensionless JS/TS import specifier ('scripts/utils' for
  //     scripts/utils.js, as written in require()/import) — skipped when two
  //     files share it (utils.js + utils.ts) or a real file owns that exact
  //     path (never guess).
  // Location-independent:
  //   • the bare basename — ONLY when no other tree file shares it (ambiguity
  //     keeps the warning) and it contains a '.' (an extensionless unique
  //     basename like 'run' would match plain prose words);
  //   • the `python -m` dotted module form for non-root .py files.
  const basenameCounts = new Map<string, number>();
  const specifierCounts = new Map<string, number>();
  for (const p of allPaths) {
    const b = basenamePosix(p);
    basenameCounts.set(b, (basenameCounts.get(b) ?? 0) + 1);
    const s = jsSpecifierForm(p);
    if (s !== null) specifierCounts.set(s, (specifierCounts.get(s) ?? 0) + 1);
  }
  const pathShapedForms = new Map<string, readonly string[]>();
  const fixedForms = new Map<string, readonly string[]>();
  for (const p of allPaths) {
    const shaped = [p];
    const spec = jsSpecifierForm(p);
    if (spec !== null && specifierCounts.get(spec) === 1 && !allPathsSet.has(spec)) {
      shaped.push(spec);
    }
    pathShapedForms.set(p, shaped);

    const fixed: string[] = [];
    const base = basenamePosix(p);
    if (base !== p && base.includes('.') && basenameCounts.get(base) === 1) fixed.push(base);
    const moduleForm = pythonModuleForm(p);
    if (moduleForm !== null) fixed.push(moduleForm);
    fixedForms.set(p, fixed);
  }

  // Markdown files get the full three-tier scan; other text files (source
  // code, html, …) match on raw text only — running the markdown scanner on
  // python source would extract meaningless "links" and code spans.
  const EMPTY_SCAN: ReturnType<typeof scanMarkdown> = {
    headings: [],
    linkTargets: [],
    inlineCode: [],
  };
  const scanFor = (path: string, text: string): ReturnType<typeof scanMarkdown> =>
    path.toLowerCase().endsWith('.md') ? scanMarkdown(text) : EMPTY_SCAN;

  const scannedDocs: { dir: string; scan: ReturnType<typeof scanMarkdown>; text: string }[] = [
    { dir: '', scan, text: bodyText },
  ];
  const enqueued = new Set(['SKILL.md']);
  const referenced = new Set<string>();

  /** A referenced file with available text joins the worklist exactly once. */
  const enqueue = (path: string): void => {
    const text = fileTexts.get(path);
    if (text === undefined || enqueued.has(path)) return;
    enqueued.add(path);
    scannedDocs.push({ dir: dirnamePosix(path), scan: scanFor(path, text), text });
  };

  /**
   * Python package plumbing: importing a module executes every __init__.py on
   * its package path, so a reachable module makes its ancestor packages'
   * __init__.py reachable (and scannable — they often re-export submodules).
   */
  const markPythonPackageInits = (p: string): void => {
    if (!p.endsWith('.py')) return;
    for (let dir = dirnamePosix(p); dir !== ''; dir = dirnamePosix(dir)) {
      const init = `${dir}/__init__.py`;
      if (allPathsSet.has(init) && !referenced.has(init)) {
        referenced.add(init);
        enqueue(init);
      }
    }
  };

  for (const doc of scannedDocs) {
    for (const p of allPaths) {
      // Already known referenced → skip. (Invariant: referencing and enqueuing
      // happen together below, so a referenced doc is always already enqueued —
      // skipping here never strands a doc that still needs its first scan.)
      if (referenced.has(p)) continue;
      const forms = new Set<string>(fixedForms.get(p));
      /* v8 ignore next -- unreachable: pathShapedForms is built over the same allPaths (total map); the ?? [] only satisfies Map's undefined-returning get() typing */
      for (const f of pathShapedForms.get(p) ?? []) {
        forms.add(f); // root-relative spelling
        const rel = relativeFromDir(doc.dir, f);
        forms.add(rel); // doc-relative spelling
        // Explicit same-dir anchor ('./scripts/utils', './guide.md') — only
        // valid for the doc-relative form; '../' spellings need no anchor.
        if (!rel.startsWith('../')) forms.add(`./${rel}`);
      }
      // Python relative-import spelling ('from .utils import x') — relative to
      // the scanning file's own package directory.
      const pyRel = pythonRelativeImportForm(doc.dir, p);
      if (pyRel !== null) forms.add(pyRel);
      let hit = false;
      for (const form of forms) {
        if (isReferenced(form, doc.scan.linkTargets, doc.scan.inlineCode, doc.text)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      referenced.add(p);
      markPythonPackageInits(p);
      enqueue(p);
    }
  }

  // orphans = non-excluded paths not referenced from any reachable doc.
  const orphans = orphanCandidates.filter((p) => !referenced.has(p)).sort();

  // Emit orphan-file diagnostic for every orphan.
  for (const p of orphans) {
    collector.emit('orphan-file', { field: p });
  }

  return { declared, resolved, broken, orphans };
}
