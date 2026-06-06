/**
 * Pipeline stage ⑩: reference graph.
 *
 * Derives three reference sets and an orphan list from the body text and
 * the manifest produced by stage ⑨:
 *
 *   declared  — unique relative paths linked in the SKILL.md body
 *               (from scanMarkdown linkTargets), sorted ascending.
 *               declared = resolved ∪ broken ∪ external.
 *
 *   resolved  — in-folder declared paths that exist in files[], sorted ascending.
 *
 *   broken    — in-folder declared paths that do NOT exist in files[], sorted
 *               ascending. Emits 'broken-ref' (warning) for each broken path.
 *
 *   external  — declared paths that escape the skill folder ('../sibling/...'),
 *               sorted ascending. Cannot be resolved within the single folder, so
 *               reported separately from broken (F7). Emits 'external-ref'.
 *
 *   orphans   — files not reachable from SKILL.md through any chain of
 *               references (SKILL.md, README, LICENSE, and root-level
 *               convention files like AGENTS.md excluded from candidates —
 *               agents read those by name, not by reference).
 *               Emits 'orphan-file' (warning) per orphan path.
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
 *   3. Path-boundary word match in the raw text — NOT bare substring. Also
 *      accepts a shell dynamic prefix ("$SCRIPT_DIR/utils.sh",
 *      "$(dirname "$0")/cleanup.sh") where the expansion's trailing '/'
 *      would otherwise fail the boundary; plain 'dir/' prefixes never match.
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
import { isRootReadme } from './docs.js';
import { scanMarkdown } from './markdown.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Paths always excluded from orphan candidates.
 * README and LICENSE paths are added dynamically from the docs stage results.
 */
const STATIC_ORPHAN_EXCLUSIONS = new Set(['SKILL.md']);

/**
 * Root-level convention files that agents read directly BY NAME (the
 * agents.md convention) — discoverable without a link from SKILL.md, so
 * never orphan candidates, same as README/LICENSE. Lowercased for
 * case-insensitive matching (mirrors README/LICENSE detection in docs.ts).
 * Root-level only: a nested docs/AGENTS.md is not the convention file.
 */
const CONVENTION_BASENAMES = new Set(['agents.md']);

/** True for a root-level convention file (read by name, never an orphan). */
function isConventionFile(p: string): boolean {
  return !p.includes('/') && CONVENTION_BASENAMES.has(p.toLowerCase());
}

/**
 * Root-level repo "community-health" / scaffolding documents (F3). When a skill
 * folder is also a repository root, these standard repo-management files appear
 * but are never meant to be referenced from SKILL.md — they document the project,
 * not the skill. They stay in files[] (and the digest) but are not orphan
 * candidates, so they don't drown the orphan signal. Root-level only, lowercased.
 */
const SCAFFOLDING_BASENAMES = new Set([
  'contributing.md',
  'contributing',
  'changelog.md',
  'changelog',
  'code_of_conduct.md',
  'security.md',
  'support.md',
  'sponsors.md',
  'governance.md',
  'authors',
  'authors.md',
  'notice',
  'notice.md',
  'maintainers.md',
]);

/** True for a root-level repo scaffolding doc (never an orphan, F3). */
function isScaffoldingFile(p: string): boolean {
  return !p.includes('/') && SCAFFOLDING_BASENAMES.has(p.toLowerCase());
}

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
 * Shell scripts and skill docs anchor paths with runtime/templated prefixes:
 *   source "$SCRIPT_DIR/utils.sh"
 *   trap "$(dirname "$0")/cleanup.sh" EXIT
 *   "${DIR}/x.sh"
 *   `{baseDir}/scripts/find-sessions.sh --all`   (F16: brace-template prefix)
 * The '/' after the expansion is a path char, so the plain boundary regex
 * rejects these spellings. This alternative lookbehind accepts a form preceded
 * by `<dynamic expansion>/` — a `$VAR`/`${VAR}` expansion, a `$(...)`
 * substitution's closing paren, OR a `{...}` template placeholder's closing
 * brace (F16). (JS lookbehind is variable-length, so the `$VAR` alternative is
 * expressible — unlike in PCRE.)
 */
const DYNAMIC_PREFIX_LOOKBEHIND = String.raw`(?<=(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\)|\})/)`;

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
  const escaped = escapeRegex(filePath);
  const tail = `(?!${PATH_CHAR_CLASS})`;
  if (new RegExp(`(?<!${PATH_CHAR_CLASS})${escaped}${tail}`).test(bodyText)) return true;

  // Tier 3b: the same form behind a shell dynamic prefix ("$SCRIPT_DIR/x.sh",
  // "$(dirname "$0")/x.sh") — the '/' after the expansion would otherwise
  // fail the R4 lookbehind. Plain 'dir/x.sh' prefixes still never match.
  return new RegExp(`${DYNAMIC_PREFIX_LOOKBEHIND}${escaped}${tail}`).test(bodyText);
}

/**
 * Collapse '.' and '..' segments in a relative POSIX path. A leading '..' that
 * cannot be cancelled is preserved, so a path that climbs above the root keeps
 * its leading '..' — that is how `escapesRoot` detects a folder escape.
 *   'references/../guide.md' → 'guide.md'   (stays in-folder)
 *   '../lark-shared/SKILL.md' → '../lark-shared/SKILL.md'  (escapes)
 */
function normalizeRelPosix(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      const top = out[out.length - 1];
      if (out.length > 0 && top !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

/**
 * True when a declared relative reference escapes the skill folder (F7): after
 * normalization it still begins with a '..' segment, so the target lives outside
 * the analyzed folder and cannot be resolved here (it is not a broken link).
 */
function escapesRoot(target: string): boolean {
  const norm = normalizeRelPosix(target);
  return norm === '..' || norm.startsWith('../');
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

/**
 * The ABSOLUTE-import spelling of a .py candidate when the scanning file's own
 * directory is on sys.path (F2). Running `python scripts/office/pack.py` puts
 * `scripts/office` on sys.path[0], so `pack.py` reaches a sibling package with a
 * bare absolute import: `from validators import X` → scripts/office/validators/.
 *
 *   pythonSysPathImportForm('scripts/office', 'scripts/office/validators/__init__.py')
 *     → 'validators'              (package: the trailing __init__ is dropped)
 *   pythonSysPathImportForm('scripts/office', 'scripts/office/util.py')
 *     → 'util'                    (module)
 *
 * Null for: non-.py candidates; candidates not at/under `fromDir` (would need
 * '..' — not importable through this sys.path root); and the scanning file's own
 * package __init__ (empty module path). The bare/dotted form is matched by the
 * tier-3 path-boundary regex, so it only fires on an exact word-boundary hit
 * (`from validators import`), never as a loose substring.
 */
function pythonSysPathImportForm(fromDir: string, p: string): string | null {
  if (!p.endsWith('.py')) return null;
  const rel = relativeFromDir(fromDir, p.slice(0, -'.py'.length));
  if (rel === '' || rel.startsWith('..')) return null;
  const segs = rel.split('/');
  // Package import: `from pkg import x` references pkg/__init__.py via the bare
  // package path, so drop the trailing '__init__' segment.
  if (segs[segs.length - 1] === '__init__') segs.pop();
  if (segs.length === 0) return null;
  return segs.join('.');
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
  /** declared paths that escape the skill folder (`../sibling/...`); sorted ascending (F7). */
  external: string[];
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
  // Convention files (AGENTS.md) are read by name, not by reference — excluded.
  // Root-level repo scaffolding (CONTRIBUTING.md, CHANGELOG.md, …) documents the
  // project, not the skill — excluded from orphan candidates (F3).
  // Localized READMEs (README.en.md, …) are documentation, never orphans — the
  // single detected README is already in `excluded`; this covers the variants (F4).
  const orphanCandidates = allPaths.filter(
    (p) => !excluded.has(p) && !isConventionFile(p) && !isScaffoldingFile(p) && !isRootReadme(p),
  );

  // When SKILL.md is absent there is no body to scan.
  // All non-excluded paths are orphans; declared/resolved/broken stay empty.
  if (bodyText === null) {
    const orphans = [...orphanCandidates].sort();
    for (const p of orphans) {
      collector.emit('orphan-file', { field: p });
    }
    return { declared: [], resolved: [], broken: [], external: [], orphans };
  }

  const scan = scanMarkdown(bodyText);

  // declared = unique relative link-target paths from the body, sorted.
  const declared = [...new Set(scan.linkTargets.filter(isRelativePath))].sort();

  // External references escape the skill folder (`../sibling/...`) and cannot be
  // resolved here (F7) — they are out-of-scope, not broken links. Split them off
  // before the resolved/broken decision so they never land in `broken`.
  const external = declared.filter(escapesRoot);
  const internal = declared.filter((p) => !escapesRoot(p));

  // Directory prefixes present in the tree, so a link to a DIRECTORY
  // ('[templates](templates/)') resolves instead of being reported broken (F10):
  // `templates/` is no file path, but it IS a real directory the link points at.
  const dirSet = new Set<string>();
  for (const fp of allPaths) {
    for (let d = dirnamePosix(fp); d !== ''; d = dirnamePosix(d)) dirSet.add(d);
  }
  // A declared path resolves when — after stripping any `#fragment` (F13) and
  // normalizing `./`/`../`/`.` segments (F12) — it names a file in the tree OR a
  // directory in it (F10). normalizeRelPosix drops a trailing slash, so a dir link
  // 'templates/' normalizes to 'templates' and matches dirSet. This mirrors the
  // normalization the reachability/orphan pass already applies, so resolved/broken
  // and orphans no longer disagree on the same link.
  const resolvesInTree = (p: string): boolean => {
    const hash = p.indexOf('#');
    const norm = normalizeRelPosix(hash === -1 ? p : p.slice(0, hash));
    if (norm === '') return false;
    return allPathsSet.has(norm) || dirSet.has(norm);
  };

  // resolved / broken split the in-folder references against the full path set.
  const resolved = internal.filter(resolvesInTree);
  const broken = internal.filter((p) => !resolvesInTree(p));

  // Emit broken-ref for missing in-folder paths and external-ref for escapes.
  for (const p of broken) {
    collector.emit('broken-ref', { field: p });
  }
  for (const p of external) {
    collector.emit('external-ref', { field: p });
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
  const isMarkdownPath = (path: string): boolean => path.toLowerCase().endsWith('.md');
  const scanFor = (path: string, text: string): ReturnType<typeof scanMarkdown> =>
    isMarkdownPath(path) ? scanMarkdown(text) : EMPTY_SCAN;

  // `isMarkdown` gates the bare sys.path absolute-import form (F2): it may only
  // fire when scanning source code, never markdown prose, where a bare module
  // word like 'run' would collide with ordinary English.
  const scannedDocs: {
    dir: string;
    scan: ReturnType<typeof scanMarkdown>;
    text: string;
    isMarkdown: boolean;
  }[] = [{ dir: '', scan, text: bodyText, isMarkdown: true }];
  const enqueued = new Set(['SKILL.md']);
  const referenced = new Set<string>();

  /** A referenced file with available text joins the worklist exactly once. */
  const enqueue = (path: string): void => {
    const text = fileTexts.get(path);
    if (text === undefined || enqueued.has(path)) return;
    enqueued.add(path);
    scannedDocs.push({
      dir: dirnamePosix(path),
      scan: scanFor(path, text),
      text,
      isMarkdown: isMarkdownPath(path),
    });
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
      // Absolute import via the scanning file's own dir on sys.path (F2):
      // 'from validators import X' in scripts/office/pack.py → scripts/office/validators/.
      // Source files only — a bare module word must never match markdown prose.
      if (!doc.isMarkdown) {
        const pySys = pythonSysPathImportForm(doc.dir, p);
        if (pySys !== null) forms.add(pySys);
      }
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

  return { declared, resolved, broken, external, orphans };
}
