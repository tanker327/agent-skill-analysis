/**
 * Hand-rolled markdown line scanner.
 *
 * Intentionally minimal — no dependency on remark/micromark/etc. Only the
 * features the analyzer needs are implemented; everything else is ignored.
 *
 * Features (in one `scanMarkdown` pass):
 *   • ATX headings (# … ######) with inline code-fence tracking (F2)
 *   • Link target extraction from [text](target) patterns
 *   • Inline code extraction from `...` and ``...`` backtick spans
 *
 * P4 (references.ts) consumes `linkTargets` + `inlineCode` for broken-ref
 * detection and orphan word-boundary matching. The API is designed now to
 * avoid churn at P4.
 *
 * Fence tracking rules (F2):
 *   - Opening fence: line starts with 3+ backticks (`) or 3+ tildes (~),
 *     with 0–3 optional leading spaces. Info string (language tag) may follow.
 *   - Closing fence: same character, equal or greater count, no trailing text.
 *   - Unclosed fence at EOF: everything after the opening line is treated as
 *     inside the fence (no headings/links/code extracted from those lines).
 *   - Nested fences of the same character are NOT supported (spec §4.5):
 *     the first closing marker ends the fence.
 */

import type { Heading } from './schema.js';

// ── Regex constants ─────────────────────────────────────────────────────────

/**
 * Opening code fence: 0–3 leading spaces, then 3+ backticks or tildes.
 * Captures (1) leading spaces, (2) fence character run.
 * Info string may follow after optional spaces — not captured.
 */
const FENCE_OPEN_RE = /^( {0,3})(```+|~~~+)\s*\S*\s*$/;

/**
 * ATX heading: `#` must be at column 0 (no leading spaces), 1–6 `#` chars,
 * one space, then heading text. Captures (1) the `#` run, (2) the raw text.
 *
 * Note: the CommonMark spec allows 0–3 leading spaces, but the test contract
 * for this library requires strict column-0 placement for simplicity.
 */
const HEADING_RE = /^(#{1,6}) (.+)/;

/**
 * Markdown link: [text](target). Captures (1) target.
 * Intentionally simple — handles common `[..](path)` patterns.
 * Does not handle nested brackets, which are rare in skill files.
 */
const LINK_RE = /\[(?:[^\]]*)\]\(([^)]+)\)/g;

/**
 * Inline code: double-backtick span `` `...` `` or single-backtick ` `...` `.
 * Double-backtick wins over single-backtick (longer match first) so that
 * `` `foo` `` doesn't split into two empty single-tick spans.
 * Group 1: content of a ``...`` span; group 2: content of a `...` span.
 */
const INLINE_CODE_RE = /``([^`]+)``|`([^`]+)`/g;

// ── Types ───────────────────────────────────────────────────────────────────

/** Result of a full `scanMarkdown` pass. */
export interface MarkdownScan {
  /** ATX headings in document order. */
  headings: Heading[];
  /**
   * Path targets from `[text](target)` patterns, in document order.
   * Includes all target strings — absolute URLs, fragment-only `#id`,
   * and relative paths. P4 references.ts filters to relative paths.
   */
  linkTargets: string[];
  /**
   * Content of backtick-quoted inline code spans (` `...` ` and ` ``...`` `),
   * in document order. P4 uses these for orphan word-boundary matching
   * and broken-ref path detection.
   */
  inlineCode: string[];
}

// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Type-safe capture-group accessor for regex matches.
 *
 * All mandatory-group accesses in this file use `group(m, i)` instead of
 * `m[i] ?? ''` at each call site. The `?? ''` fallback is structurally
 * unreachable — every call site is guarded by a not-null match check, and the
 * groups accessed are mandatory (non-optional) in their respective patterns.
 * One annotation here rather than one per call site; P4's reference extraction
 * will reuse the same helper.
 */
function group(m: RegExpExecArray, i: number): string {
  /* v8 ignore next -- ?? '' unreachable: called only after a successful match where group i is mandatory (noUncheckedIndexedAccess) */
  return m[i] ?? '';
}

/**
 * Strip trailing `#` sequences and whitespace from a raw ATX heading text.
 *
 * Spec §4.2: a sequence of `#` characters with an optional preceding space
 * at the end of the line is a closing sequence and is removed from the text.
 */
function stripHeadingTrail(raw: string): string {
  // Remove trailing whitespace + optional "# ... #" closing sequence.
  return raw
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+$/, '')
    .trim();
}

/**
 * Extract link targets from a single line (outside code fences).
 * Returns an empty array when no `[..](target)` patterns are present.
 */
function extractLinkTargets(line: string): string[] {
  const targets: string[] = [];
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(line)) !== null) {
    // Group 1 is ([^)]+) — a successful match is never empty, so push directly.
    targets.push(group(m, 1));
  }
  return targets;
}

/**
 * Extract inline code content from a single line (outside code fences).
 * Returns an empty array when no backtick spans are found.
 */
function extractInlineCode(line: string): string[] {
  const items: string[] = [];
  INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_RE.exec(line)) !== null) {
    // Group 1 = double-backtick content; group 2 = single-backtick content.
    // Both groups use [^`]+ so the '' fallback from group() signals "didn't match" —
    // whichever alternative matched is non-empty, so the || result always is too.
    items.push(group(m, 1) || group(m, 2));
  }
  return items;
}

/**
 * Extract ATX headings from a markdown text string.
 *
 * Convenience wrapper around `scanMarkdown` for callers that only need headings
 * (body.ts, tests). Code-fence suppression (F2) is applied; inline backtick
 * spans on a heading line do NOT suppress that heading.
 */
export function extractHeadings(text: string): Heading[] {
  return scanMarkdown(text).headings;
}

/**
 * Single-pass markdown scanner.
 *
 * Processes the text line-by-line, tracking code-fence state (F2) and
 * extracting headings, link targets, and inline code spans from non-fence lines.
 *
 * Never throws — malformed markdown produces empty arrays, not errors.
 */
export function scanMarkdown(text: string): MarkdownScan {
  const headings: Heading[] = [];
  const linkTargets: string[] = [];
  const inlineCode: string[] = [];

  if (text.length === 0) {
    return { headings, linkTargets, inlineCode };
  }

  // Split without -1 limit: trailing newline produces a harmless empty last line.
  const lines = text.split('\n');

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (const line of lines) {
    if (inFence) {
      // Look for a closing fence: same character, >= opening count, no trailing text.
      // Leading spaces allowed (spec §4.5: up to 3).
      const trimmed = line.trimStart();
      const leadingSpaces = line.length - trimmed.length;
      if (leadingSpaces <= 3) {
        // Check if this line is purely the closing fence character run.
        const closingRe = fenceChar === '`' ? /^(`{3,})\s*$/ : /^(~{3,})\s*$/;
        const cm = closingRe.exec(trimmed);
        if (cm !== null && group(cm, 1).length >= fenceLen) {
          inFence = false;
        }
      }
      // Whether closed or still open, skip this line for content extraction.
      continue;
    }

    // Not in fence — check for opening fence first (before heading scan).
    const fm = FENCE_OPEN_RE.exec(line);
    if (fm !== null) {
      const marker = group(fm, 2);
      // FENCE_OPEN_RE requires 3+ chars in group 2, so marker.length >= 3 always.
      inFence = true;
      fenceChar = marker.charAt(0); // charAt never returns undefined — no ?? needed
      fenceLen = marker.length;
      continue;
    }

    // ATX heading detection.
    const hm = HEADING_RE.exec(line);
    if (hm !== null) {
      // Group 1 = `#` run; group 2 = raw heading text (no leading-spaces group).
      const hashes = group(hm, 1);
      const rawText = group(hm, 2);
      const headingText = stripHeadingTrail(rawText);
      if (headingText.length > 0) {
        headings.push({ depth: hashes.length, text: headingText });
      }
    }

    // Link targets and inline code (from all non-fence lines, including headings).
    for (const t of extractLinkTargets(line)) linkTargets.push(t);
    for (const c of extractInlineCode(line)) inlineCode.push(c);
  }

  // Unclosed fence at EOF: F2 — the trailing content was already skipped above.

  return { headings, linkTargets, inlineCode };
}
