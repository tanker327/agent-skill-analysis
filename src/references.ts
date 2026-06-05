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
 *   orphans   — files present in the manifest but not referenced anywhere in
 *               the body (SKILL.md, README, LICENSE excluded from candidates).
 *               Emits 'orphan-file' (warning) for each orphan path.
 *
 * Reference detection (for orphan check) uses three complementary strategies:
 *   1. Exact match in scanMarkdown linkTargets (explicit markdown links).
 *   2. Exact match in scanMarkdown inlineCode spans (backtick mentions).
 *   3. Path-boundary word match in the raw body text — NOT bare substring.
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
 */
export function analyzeReferences(
  bodyText: string | null,
  allPaths: readonly string[],
  readmePath: string | null,
  licensePath: string | null,
  collector: DiagnosticCollector,
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

  // orphans = non-excluded paths not referenced anywhere in the body.
  const orphans = orphanCandidates
    .filter((p) => !isReferenced(p, scan.linkTargets, scan.inlineCode, bodyText))
    .sort();

  // Emit orphan-file diagnostic for every orphan.
  for (const p of orphans) {
    collector.emit('orphan-file', { field: p });
  }

  return { declared, resolved, broken, orphans };
}
