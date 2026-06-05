/**
 * Pluggable token counter.
 *
 * The `Tokenizer` interface is defined in schema.ts (the output contract); this
 * module exports only the default implementation. Consumers inject their own
 * tokenizer via `AnalyzeOptions.tokenizer` (e.g. js-tiktoken for accurate
 * cl100k_base counts); the default is kept dependency-free.
 *
 * Default: "approx-chars-4" — Math.ceil(charCount / 4).
 *
 *   Rationale: common English prose + code averages ~4 UTF-16 code units per
 *   BPE token across GPT/Claude families. Math.ceil gives a slight conservative
 *   overestimate (better to warn early than miss a budget violation).
 *
 * R2: `tokens.tokenizer` in the output equals `tokenizer.name`, so counts from
 * different implementations are not directly comparable; the name makes it
 * explicit which approximation was used.
 */
import type { Tokenizer } from './schema.js';

/**
 * Default token counter: ≈ chars / 4 (rounds up).
 *
 * Injected into `analyze()` when `options.tokenizer` is absent.
 * Name surfaces as `tokens.tokenizer` in the output (R2).
 *
 * Naming convention matches DEFAULT_IGNORE in analyze.ts — module-level
 * singleton constants use SCREAMING_SNAKE_CASE.
 */
export const DEFAULT_TOKENIZER: Tokenizer = {
  name: 'approx-chars-4',
  count: (text: string): number => Math.ceil(text.length / 4),
};
