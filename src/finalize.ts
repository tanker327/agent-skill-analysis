/**
 * Pipeline stage ⑪: finalize — apply options.rules severity overrides,
 * compute ok, sort diagnostics.
 *
 * Severity is policy, not mechanism (plan §3): stages emit raw diagnostics
 * with library-default severities; finalize is the single point where
 * consumer options.rules overrides are applied and ok is computed.
 *
 * Override semantics:
 *   'off'     → diagnostic is DELETED from output (never included)
 *   'error'   → re-label severity to 'error'  (may flip ok to false)
 *   'warning' → re-label severity to 'warning' (never flips ok to false)
 *   (absent)  → use the library-default severity from DIAGNOSTIC_REGISTRY
 *
 * Default severity 'off' (currently: name-reserved) means suppressed unless
 * a consumer rule explicitly sets it to 'error' or 'warning'. Once enabled
 * via rules, it behaves identically to any other diagnostic.
 *
 * ok = true iff no error-severity diagnostics remain after all overrides.
 */

import { compareDiagnostics } from './diagnostics.js';
import type { RawDiagnostic } from './diagnostics.js';
import type { Diagnostic, RuleOverride } from './schema.js';

/**
 * Apply consumer rules overrides to raw diagnostics and produce the final
 * output diagnostics array and `ok` boolean.
 *
 * @param rawDiagnostics  Emissions from DiagnosticCollector.all() — emission order.
 * @param rules           Consumer severity overrides from options.rules (may be undefined).
 * @returns               Sorted diagnostics and the `ok` flag.
 */
export function finalizeDiagnostics(
  rawDiagnostics: readonly RawDiagnostic[],
  rules: Record<string, RuleOverride> | undefined,
): { diagnostics: Diagnostic[]; ok: boolean } {
  const diagnostics: Diagnostic[] = [];

  for (const raw of rawDiagnostics) {
    // Consumer rule wins; fall back to library-default severity.
    const override = rules?.[raw.code] as RuleOverride | undefined;
    const effective = override !== undefined ? override : raw.severity;

    // 'off' (by default or by consumer rule) → delete from output entirely.
    if (effective === 'off') continue;

    // TypeScript narrows `effective` to 'error' | 'warning' past this point.
    const diag: Diagnostic = {
      code: raw.code,
      severity: effective,
      message: raw.message,
    };
    if (raw.field !== undefined) diag.field = raw.field;
    if (raw.hint !== undefined) diag.hint = raw.hint;
    diagnostics.push(diag);
  }

  // Sort by (severity, code, field) — deterministic output ordering.
  diagnostics.sort(compareDiagnostics);

  // ok = no error-severity diagnostics remain after all overrides.
  const ok = !diagnostics.some((d) => d.severity === 'error');

  return { diagnostics, ok };
}
