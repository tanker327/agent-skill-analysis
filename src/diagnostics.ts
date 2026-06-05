/**
 * Diagnostic code registry + emission collector.
 *
 * Severity is policy, not mechanism: pipeline stages emit codes with the
 * library-default severity recorded here; `finalize` (P6) applies consumer
 * `options.rules` overrides and computes `ok` afterwards.
 *
 * The registry grows phase by phase — a code is registered in the same commit
 * as the stage that emits it, so the "every registered code is exercised by a
 * fixture" meta-test never has dead entries. The full target list lives in the
 * plan doc (global_ignore/skl-skill-analysis-plan.md) and the P0 plan file.
 *
 * A default severity of "off" means: registered and emittable, but suppressed
 * unless a consumer enables it via options.rules (reserved for name-reserved,
 * P1). The output severity enum stays two-valued ("error" | "warning").
 */
import type { Diagnostic, Severity } from './schema.js';

export type DefaultSeverity = Severity | 'off';

export interface DiagnosticSpec {
  defaultSeverity: DefaultSeverity;
  /** Default human message; emit() may override with a more specific one. */
  message: string;
  hint?: string;
}

export const DIAGNOSTIC_REGISTRY = {
  'no-skill-md': {
    defaultSeverity: 'error',
    message: 'No SKILL.md found at the skill root.',
    hint: 'Every skill needs a SKILL.md file at the root of its folder.',
  },
} as const satisfies Record<string, DiagnosticSpec>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_REGISTRY;

/**
 * Union of default severities actually present in the registry. Deliberately
 * derived rather than `DefaultSeverity`: the moment a default-"off" code is
 * registered (name-reserved, P1), 'off' enters this union and every place
 * that assigns a raw severity into an output `Diagnostic` stops typechecking
 * until an 'off' filter is introduced — the compiler enforces phase
 * discipline instead of us shipping dead branches ahead of their phase.
 */
export type RegisteredDefaultSeverity =
  (typeof DIAGNOSTIC_REGISTRY)[DiagnosticCode]['defaultSeverity'];

/**
 * A diagnostic as emitted by a stage — severity may still be a suppressed
 * default until finalize resolves policy.
 */
export interface RawDiagnostic {
  code: DiagnosticCode;
  severity: RegisteredDefaultSeverity;
  field?: string;
  message: string;
  hint?: string;
}

/** Accumulates stage emissions. Stages never decide final severity. */
export class DiagnosticCollector {
  private readonly items: RawDiagnostic[] = [];

  emit(
    code: DiagnosticCode,
    overrides?: { field?: string; message?: string; hint?: string },
  ): void {
    // No annotation: the literal entry type (not DiagnosticSpec) must flow
    // through so RawDiagnostic.severity stays the registry-derived union.
    const spec = DIAGNOSTIC_REGISTRY[code];
    const item: RawDiagnostic = {
      code,
      severity: spec.defaultSeverity,
      message: overrides?.message ?? spec.message,
    };
    if (overrides?.field !== undefined) item.field = overrides.field;
    const hint = overrides?.hint ?? spec.hint;
    if (hint !== undefined) item.hint = hint;
    this.items.push(item);
  }

  /** Raw emissions in emission order (finalize applies policy + sorting). */
  all(): readonly RawDiagnostic[] {
    return this.items;
  }
}

/**
 * Fixed output ordering for diagnostics: (severity, code, field).
 * "error" < "warning" falls out of plain string comparison.
 */
export function compareDiagnostics(
  a: Pick<Diagnostic, 'severity' | 'code' | 'field'>,
  b: Pick<Diagnostic, 'severity' | 'code' | 'field'>,
): number {
  if (a.severity !== b.severity) return a.severity < b.severity ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const af = a.field ?? '';
  const bf = b.field ?? '';
  return af < bf ? -1 : af > bf ? 1 : 0;
}
