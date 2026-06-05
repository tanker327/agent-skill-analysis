/**
 * Pipeline stage ⑥: SKILL.md body analysis.
 *
 * Receives the body text produced by stage ③ (splitSkillMd) and computes:
 *   • lines      — total line count (text.split('\n').length, or 0 for empty)
 *   • headings   — ATX headings in document order (delegates to markdown.ts, F2)
 *   • bodyTokens — token count via the supplied tokenizer (consumed by analyze.ts
 *                  for tokens.body; also used for the body-too-long budget check)
 *
 * Budget diagnostics:
 *   • body-too-many-lines — emitted when lines > BODY_LINE_LIMIT (500)
 *   • body-too-long       — emitted when bodyTokens > BODY_TOKEN_LIMIT (4,000)
 *
 * Both limits are warnings — they don't force ok=false unless the consumer
 * promotes them via options.rules. The constants are exported so test fixtures
 * can assert exact boundary behaviour without hard-coding magic numbers.
 *
 * Never throws: malformed body content silently produces empty arrays.
 */
import type { DiagnosticCollector } from './diagnostics.js';
import { extractHeadings } from './markdown.js';
import type { Heading, Tokenizer } from './schema.js';
import { DEFAULT_TOKENIZER } from './tokenizer.js';

// ── Budget limits ───────────────────────────────────────────────────────────

/**
 * Approximate token budget (approx-chars-4 units) above which `body-too-long`
 * is emitted.
 *
 * Rationale: a skill costing 4,000 tokens at load consumes ~2% of a typical
 * 200k context window — a meaningful fraction that warrants an advisory warning.
 * The threshold is intentionally generous to avoid false positives on legitimately
 * detailed skills while still catching runaway SKILL.md files.
 *
 * Approved by team-lead 2026-06-05.
 */
export const BODY_TOKEN_LIMIT = 4_000;

/**
 * Line count above which `body-too-many-lines` is emitted.
 *
 * Aligns with Anthropic's published skill-authoring guidance ("keep SKILL.md
 * under 500 lines"). A structural limit independent of prose density: a 500-line
 * SKILL.md is almost certainly under-factored regardless of token cost.
 *
 * Approved by team-lead 2026-06-05.
 */
export const BODY_LINE_LIMIT = 500;

// ── Types ───────────────────────────────────────────────────────────────────

/** Result returned by `analyzeBody`. */
export interface BodyAnalysis {
  /** Total line count (text.split('\n').length, or 0 for empty text). */
  lines: number;
  /** ATX headings in document order (code-fence suppression applied). */
  headings: Heading[];
  /**
   * Token count of the body text (via the supplied tokenizer).
   * Surfaced separately so `analyze.ts` can assign it to `tokens.body`
   * without re-invoking the tokenizer a second time.
   */
  bodyTokens: number;
}

// ── Stage ⑥ ─────────────────────────────────────────────────────────────────

/**
 * Stage ⑥: analyze the SKILL.md body text.
 *
 * The `tokenizer` parameter defaults to `DEFAULT_TOKENIZER`; callers that
 * do not need custom tokenization (unit tests, internal callers without an
 * injected tokenizer) may call `analyzeBody(text, collector)` with two arguments.
 *
 * When `analyze()` injects a custom tokenizer via `options.tokenizer`, it passes
 * it here as the third argument so budget checks and `tokens.body` use the
 * same counting function.
 */
export function analyzeBody(
  text: string,
  collector: DiagnosticCollector,
  tokenizer: Tokenizer = DEFAULT_TOKENIZER,
): BodyAnalysis {
  if (text.length === 0) {
    return { lines: 0, headings: [], bodyTokens: 0 };
  }

  const lines = text.split('\n').length;
  const headings = extractHeadings(text);
  const bodyTokens = tokenizer.count(text);

  // Budget diagnostics — both are warning-severity in the default registry.
  // Override message at emit time so the exact counts appear in the output.
  if (lines > BODY_LINE_LIMIT) {
    collector.emit('body-too-many-lines', {
      message: `SKILL.md body has ${lines} lines; recommended maximum is ${BODY_LINE_LIMIT}.`,
    });
  }

  if (bodyTokens > BODY_TOKEN_LIMIT) {
    collector.emit('body-too-long', {
      message: `SKILL.md body is approximately ${bodyTokens} tokens; recommended maximum is ${BODY_TOKEN_LIMIT}.`,
    });
  }

  return { lines, headings, bodyTokens };
}
