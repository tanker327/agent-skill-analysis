/**
 * Pipeline stages ③–⑤: split SKILL.md → normalize frontmatter → validate.
 *
 * Hand-written best-effort parsing, NOT zod: the whole point is partial
 * extraction and custom diagnostic codes even when the frontmatter is broken.
 * Never throws on content — all broken content becomes diagnostics (R3).
 *
 * ③  splitSkillMd      — split on --- fences, extract YAML block + body text
 * ④  normalizeFrontmatter — extract known keys, promote version, split tools, collect extra
 * ⑤  validateFrontmatter  — emit diagnostic codes for every rule violation
 *
 * Main entry: parseFrontmatterFromText runs ③→④→⑤ in sequence.
 */
import { parse as parseYaml } from 'yaml';

import type { DiagnosticCollector } from './diagnostics.js';
import type { Frontmatter } from './schema.js';

// ── ③ Split ────────────────────────────────────────────────────────────────

/**
 * Opening `---` must be at position 0 (byte 0 of the file).
 * Closing `---` must appear on its own line.
 * Captures the YAML content between the fences in group 1.
 * Non-empty block: FENCE_RE (requires \n before closing ---).
 * Empty block (---\n---): handled by EMPTY_FENCE_RE separately.
 */
const FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/** Matches the degenerate `---\n---` (empty YAML block) case. */
const EMPTY_FENCE_RE = /^---\r?\n---(?:\r?\n|$)/;

export interface SplitResult {
  /**
   * Content between the `---` fences (may be empty string for `---\n---`),
   * or null when no valid fence pair is present.
   */
  yamlBlock: string | null;
  /**
   * Everything after the closing fence. If no fences were found this is the
   * entire input (the whole file is treated as body).
   */
  body: string;
}

/** Stage ③: split a SKILL.md string into its YAML block and body text. */
export function splitSkillMd(text: string): SplitResult {
  // Check empty-block case first (`---\n---`) — FENCE_RE requires a \n before
  // the closing fence and won't match when the YAML block has zero lines.
  const empty = EMPTY_FENCE_RE.exec(text);
  if (empty) return { yamlBlock: '', body: text.slice(empty[0].length) };
  const m = FENCE_RE.exec(text);
  if (!m) return { yamlBlock: null, body: text };
  /* v8 ignore next -- unreachable: group 1 is always defined when FENCE_RE matches; kept for noUncheckedIndexedAccess TS-strictness */
  return { yamlBlock: m[1] ?? '', body: text.slice(m[0].length) };
}

// ── JSON-safe projection ───────────────────────────────────────────────────

/**
 * Recursively project `value` into a JSON-serializable form, breaking any
 * cyclic references so that `canonicalJSON` and `JSON.stringify` never throw.
 *
 * Rules (normative — used by both frontmatter normalization and the digest stage):
 *   • Primitives (null, boolean, number, string) → passed through unchanged.
 *   • Objects and arrays → cloned recursively, depth-first, in sorted-key order
 *     for objects (same key order as canonicalJSON, so the definition is
 *     consistent end-to-end).
 *   • Cyclic reference (object/array already in the current ancestor path) →
 *     `null` at the point of revisit.
 *   • Non-cyclic structural sharing (same object reachable via two distinct
 *     non-cyclic paths) → cloned independently at each site (duplication is
 *     fine and deterministic).
 *   • Non-finite numbers (.inf / .nan from YAML) and -0 follow
 *     JSON.stringify semantics when serialized: Infinity→null, NaN→null, -0→0.
 *
 * `ancestors` tracks the objects/arrays on the current traversal path
 * (not all previously visited nodes), so non-cyclic shared anchors are
 * duplicated rather than collapsed.
 */
export function projectJsonSafe(value: unknown, ancestors: Set<object> = new Set()): unknown {
  // Primitives pass through unchanged.
  if (value === null || typeof value !== 'object') return value;

  // Cycle detected — this object/array is an ancestor of itself.
  if (ancestors.has(value)) return null;

  ancestors.add(value);

  let result: unknown;
  if (Array.isArray(value)) {
    // Preserve element order (arrays have no key sort).
    result = value.map((item) => projectJsonSafe(item, ancestors));
  } else {
    // Sorted-key order (matches canonicalJSON) — deterministic traversal.
    const obj = value as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      projected[k] = projectJsonSafe(obj[k], ancestors);
    }
    result = projected;
  }

  // Done with this node — remove from ancestor path so sibling subtrees
  // that reference the same object are cloned rather than collapsed.
  ancestors.delete(value);
  return result;
}

// ── ④ Normalize ────────────────────────────────────────────────────────────

/** The six known frontmatter keys (as they appear in YAML). */
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'allowed-tools',
  'metadata',
]);

/**
 * Return `v` as a string if it is a non-empty string; otherwise null.
 * Empty strings are treated as absent (both trigger *-missing diagnostics).
 */
function toStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Stage ④: normalize a raw YAML-parsed object into a typed Frontmatter.
 *
 * - Known keys are extracted and typed.
 * - metadata.version is hoisted to the top-level `version` field.
 * - allowed-tools is split on whitespace into `string[]`.
 * - Non-string metadata values are stringified and emitted as
 *   `metadata-non-string` diagnostics (the value is still included).
 * - Everything else lands in `extra` verbatim — NEVER warned about.
 */
export function normalizeFrontmatter(
  raw: Record<string, unknown>,
  collector: DiagnosticCollector,
): Frontmatter {
  // Collect unknown keys verbatim — §3.1 output doc: must not warn.
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = v;
  }

  // metadata: must be a plain object; each value must be string.
  let metadata: Record<string, string> | null = null;
  const rawMeta = raw['metadata'];
  if (
    rawMeta !== null &&
    rawMeta !== undefined &&
    typeof rawMeta === 'object' &&
    !Array.isArray(rawMeta)
  ) {
    metadata = {};
    for (const [k, v] of Object.entries(rawMeta as Record<string, unknown>)) {
      if (typeof v === 'string') {
        metadata[k] = v;
      } else {
        // Stringify and record: the value is preserved, the type violation is noted.
        // Objects and arrays are JSON-encoded so they round-trip — String() would
        // collapse an object to the useless "[object Object]". The reported type is
        // the real one (`array` is distinguished from `object`; `null` from `object`).
        // v is already JSON-safe here (projectJsonSafe ran at the parse boundary).
        const isStructured = typeof v === 'object' && v !== null;
        const coerced = isStructured ? JSON.stringify(v) : String(v);
        const actualType = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
        metadata[k] = coerced;
        collector.emit('metadata-non-string', {
          field: `metadata.${k}`,
          message: `metadata.${k} is not a string (got ${actualType}); stringified to "${coerced}".`,
        });
      }
    }
  }

  // version: hoisted from metadata.version, falling back to a top-level `version`
  // key (F8) when metadata.version is absent — an author who put `version:` at the
  // top level clearly declared one, so it must not trigger version-missing. The
  // top-level key still remains in `extra` verbatim (same as metadata.version stays
  // in metadata). Kept as a string ("1.10" must not become 1.1); a non-string
  // top-level version (e.g. the number 1.0) is ignored, matching metadata behavior.
  const version: string | null = metadata?.['version'] ?? toStringOrNull(raw['version']);

  // allowed-tools: split space-separated string into array (O1).
  // Also accept a YAML sequence for robustness.
  let allowedTools: string[] | null = null;
  const rawTools = raw['allowed-tools'];
  if (typeof rawTools === 'string') {
    const parts = rawTools.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) allowedTools = parts;
  } else if (Array.isArray(rawTools)) {
    const parts = rawTools.filter((t): t is string => typeof t === 'string');
    if (parts.length > 0) allowedTools = parts;
  }

  return {
    name: toStringOrNull(raw['name']),
    description: toStringOrNull(raw['description']),
    version,
    license: toStringOrNull(raw['license']),
    compatibility: toStringOrNull(raw['compatibility']),
    allowedTools,
    metadata,
    extra,
  };
}

// ── ⑤ Validate ────────────────────────────────────────────────────────────

/**
 * Allowed charset for skill names: lowercase letters, digits, hyphens.
 * Structural constraints (no leading/trailing hyphen, no double-hyphen)
 * are checked separately — all map to the single `name-invalid` code.
 */
const NAME_CHARSET_RE = /^[a-z0-9-]+$/;

/**
 * Names reserved for registry internal use (e.g. routing, placeholders).
 * Default severity is 'off': they appear in diagnostics only when the consumer
 * explicitly enables this code via options.rules['name-reserved'].
 */
/** Exported as an array so tests can index into it (e.g. RESERVED_NAMES[0]). */
export const RESERVED_NAMES: readonly string[] = [
  'default',
  'example',
  'demo',
  'test',
  'sample',
  'template',
];

/**
 * Stage ⑤: validate a normalized Frontmatter and emit all applicable
 * diagnostic codes. All validations are independent — multiple codes may
 * be emitted in one call.
 *
 * @param fm   Normalized frontmatter from stage ④.
 * @param dir  Skill root directory name (`source.dir`); null for memory sources.
 */
export function validateFrontmatter(
  fm: Frontmatter,
  dir: string | null | undefined,
  collector: DiagnosticCollector,
): void {
  // ── name ──
  if (fm.name === null) {
    collector.emit('name-missing', { field: 'name' });
  } else {
    if (fm.name.length > 64) {
      collector.emit('name-too-long', {
        field: 'name',
        message: `name is ${fm.name.length} characters; maximum is 64.`,
      });
    }

    // One code for charset + edge-hyphen + double-hyphen (plan P1 / team-lead note).
    const invalidStructure =
      !NAME_CHARSET_RE.test(fm.name) ||
      fm.name.startsWith('-') ||
      fm.name.endsWith('-') ||
      fm.name.includes('--');
    if (invalidStructure) {
      collector.emit('name-invalid', {
        field: 'name',
        message:
          'name must use only lowercase letters, digits, and hyphens; ' +
          'must not start or end with a hyphen or contain consecutive hyphens.',
      });
    }

    // Reserved name (default severity: 'off' — widens RegisteredDefaultSeverity).
    if (RESERVED_NAMES.includes(fm.name)) {
      collector.emit('name-reserved', {
        field: 'name',
        message: `"${fm.name}" is a reserved skill name.`,
      });
    }

    // Dir mismatch — skip when dir is null or undefined (memory sources, flow §6).
    if (dir != null && fm.name !== dir) {
      collector.emit('name-dir-mismatch', {
        field: 'name',
        message: `Frontmatter name "${fm.name}" does not match the skill folder name "${dir}".`,
      });
    }
  }

  // ── description ──
  if (fm.description === null) {
    collector.emit('description-missing', { field: 'description' });
  } else if (fm.description.length > 1024) {
    collector.emit('description-too-long', {
      field: 'description',
      message: `description is ${fm.description.length} characters; maximum is 1024.`,
    });
  }

  // ── compatibility ──
  if (fm.compatibility !== null && fm.compatibility.length > 500) {
    collector.emit('compatibility-too-long', {
      field: 'compatibility',
      message: `compatibility is ${fm.compatibility.length} characters; maximum is 500.`,
    });
  }

  // ── version ──
  if (fm.version === null) {
    collector.emit('version-missing');
  }

  // ── allowed-tools ──
  if (fm.allowedTools !== null) {
    collector.emit('allowed-tools-experimental', { field: 'allowed-tools' });
  }
}

// ── Main entry ─────────────────────────────────────────────────────────────

/**
 * Parse a SKILL.md string through stages ③ → ④ → ⑤.
 *
 * Returns:
 *   - `frontmatter`: normalized, validated frontmatter
 *   - `body`:        raw body text after the closing fence
 *                    (or the whole file if no fences were found)
 *
 * Diagnostics are accumulated into `collector`; this function never throws.
 */
export function parseFrontmatterFromText(
  text: string,
  dir: string | null | undefined,
  collector: DiagnosticCollector,
): { frontmatter: Frontmatter; body: string } {
  const { yamlBlock, body } = splitSkillMd(text);

  let raw: Record<string, unknown> = {};
  let parseErrored = false;

  if (yamlBlock !== null) {
    try {
      // Project through projectJsonSafe immediately after parsing to break any
      // cyclic YAML anchor references (e.g. `a: &x\n  b: *x`) before the raw
      // object reaches normalizeFrontmatter or frontmatter.extra — both of
      // which must be JSON-serializable. Non-cyclic shared anchors are cloned.
      // logLevel 'error': non-fatal YAML issues (unknown %directives, unresolved
      // !tags) default to logLevel 'warn', which side-effects process.emitWarning —
      // a content-triggered emission on the consumer's process. 'error' silences
      // warnings while parse errors still throw (only 'silent' suppresses those),
      // so the frontmatter-parse diagnostic path below is unchanged.
      const parsed = projectJsonSafe(parseYaml(yamlBlock, { logLevel: 'error' }) as unknown);
      if (
        parsed !== null &&
        parsed !== undefined &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        raw = parsed as Record<string, unknown>;
      }
      // null / scalar / array → treat as empty object; ④⑤ still run.
    } catch (err) {
      // yaml parse errors carry position info in err.message — include it.
      collector.emit('frontmatter-parse', {
        /* v8 ignore next -- unreachable in practice: yaml always throws Error instances; kept for never-throw robustness (zero-mock policy makes String(err) branch untestable by design) */
        message: `YAML frontmatter could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      });
      parseErrored = true;
    }
  }
  // No fences → raw stays {}; ⑤ emits name-missing, description-missing, etc.

  const frontmatter = normalizeFrontmatter(raw, collector);

  // Flow §6 ruling (B): skip ⑤ validation after a YAML parse failure.
  //
  // The deciding evidence is the structural contrast inside the §6 degradation
  // matrix: the "无 frontmatter" row explicitly lists "⑤产 name-missing /
  // description-missing", whereas the "frontmatter-parse" row deliberately does
  // not — it says only "④⑤尽力(具名字段多为 null)". If pile-on were intended
  // both rows would read the same. "Best-effort" here means "produce what is
  // meaningful given the failure": after a total parse failure every field is null
  // because of the parse error, so missing-field diagnostics carry zero signal
  // beyond the frontmatter-parse error already present (which is error-severity
  // and forces ok=false by itself). When there are no fences at all, fields are
  // null because the author never provided them — validation is meaningful.
  if (!parseErrored) {
    validateFrontmatter(frontmatter, dir, collector);
  }

  return { frontmatter, body };
}
