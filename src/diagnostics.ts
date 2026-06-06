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
  // ── P0 · enumerate ──
  'no-skill-md': {
    defaultSeverity: 'error',
    message: 'No SKILL.md found at the skill root.',
    hint: 'Every skill needs a SKILL.md file at the root of its folder.',
  },

  // ── P1 · frontmatter parse (stage ③) ──
  'frontmatter-parse': {
    defaultSeverity: 'error',
    message: 'SKILL.md frontmatter is not valid YAML.',
    hint: 'Fix the YAML between the opening and closing --- fences.',
  },

  // ── P1 · frontmatter validation (stage ⑤) ──
  'name-missing': {
    defaultSeverity: 'error',
    message: 'Frontmatter is missing the required "name" field.',
  },
  'name-too-long': {
    defaultSeverity: 'error',
    message: 'Frontmatter "name" exceeds the 64-character limit.',
  },
  'name-invalid': {
    defaultSeverity: 'error',
    message:
      'Frontmatter "name" must be lowercase letters, digits, and hyphens — no leading, trailing, or consecutive hyphens.',
  },
  'name-reserved': {
    // Suppressed by default; consumers opt in via options.rules.
    defaultSeverity: 'off',
    message: 'Frontmatter "name" is a reserved word.',
    hint: 'Choose a different skill name.',
  },
  'name-dir-mismatch': {
    // Skipped entirely when the source has no directory name (dir = null).
    defaultSeverity: 'warning',
    message: 'Frontmatter "name" does not match the skill folder name.',
    hint: 'Rename the folder or the skill so they match.',
  },
  'description-missing': {
    defaultSeverity: 'error',
    message: 'Frontmatter is missing the required "description" field.',
  },
  'description-too-long': {
    defaultSeverity: 'error',
    message: 'Frontmatter "description" exceeds the 1024-character limit.',
  },
  'compatibility-too-long': {
    // Soft limit on a free-text field, not a spec violation → warning.
    defaultSeverity: 'warning',
    message: 'Frontmatter "compatibility" exceeds the 500-character limit.',
  },
  'metadata-non-string': {
    defaultSeverity: 'error',
    message: 'Frontmatter "metadata" values must be strings.',
    hint: 'Quote the value in YAML; the analyzer stringified it best-effort.',
  },
  'version-missing': {
    defaultSeverity: 'warning',
    message: 'Frontmatter "metadata.version" is not set.',
    hint: 'Add metadata.version so consumers can track releases.',
  },
  'allowed-tools-experimental': {
    defaultSeverity: 'warning',
    message: 'allowed-tools is experimental and support varies across agents.',
  },

  // ── P2 · body analysis (stage ⑥) — soft advisory budgets, not spec violations ──
  'body-too-long': {
    defaultSeverity: 'warning',
    message: 'SKILL.md body exceeds the recommended token budget.',
    hint: 'Move detail into references/ files that agents load on demand (progressive disclosure).',
  },
  'body-too-many-lines': {
    defaultSeverity: 'warning',
    message: 'SKILL.md body exceeds the recommended line count.',
    hint: 'Move detail into references/ files that agents load on demand (progressive disclosure).',
  },

  // ── P3 · README / LICENSE detection (stages ⑦⑧) — soft advisory, file-level ──
  'readme-missing': {
    defaultSeverity: 'warning',
    message: 'No README found in the skill folder.',
    hint: 'Add a README.md to make the skill page readable.',
  },
  'license-missing': {
    defaultSeverity: 'warning',
    message: 'No license declaration or LICENSE file found.',
    hint: 'Add a LICENSE file or set frontmatter.license.',
  },
  'license-file-missing': {
    defaultSeverity: 'warning',
    message: 'Frontmatter declares a license but no LICENSE file was found.',
    hint: 'Add a LICENSE file to match the frontmatter.license declaration.',
  },

  // ── P4 · manifest + reference graph (stages ⑨⑩) ──
  'broken-ref': {
    // Link-target parsing has known false positives (example paths in prose) → warning only (F3).
    defaultSeverity: 'warning',
    message: 'Referenced path does not exist in the skill.',
    hint: 'Fix the path or remove the reference from SKILL.md.',
  },
  'orphan-file': {
    defaultSeverity: 'warning',
    message: 'File is not reachable from SKILL.md through any chain of references.',
    hint: 'Reference it from SKILL.md (directly, or via a reachable doc or script) or remove it to keep the skill lean.',
  },
  'file-too-large': {
    // F4: over-limit files are skipped from hashing, but NEVER silently.
    defaultSeverity: 'warning',
    message: 'File exceeds the maxFileBytes limit and was excluded from the manifest.',
    hint: 'Raise options.maxFileBytes or shrink the file.',
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
    const hint = overrides?.hint ?? ('hint' in spec ? spec.hint : undefined);
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
