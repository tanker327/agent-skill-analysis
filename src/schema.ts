/**
 * The output contract — single source of truth for the `SkillAnalysis` shape.
 *
 * All TypeScript types are derived via `z.infer`; never hand-write a duplicate.
 * zod is used ONLY here (output contract + AnalyzeOptions entry validation) —
 * frontmatter validation is hand-written best-effort code with custom
 * diagnostic codes (see src/frontmatter.ts, P1).
 *
 * In production, `SkillAnalysisSchema` is never parsed — conformance is
 * enforced by tests. The only production-path parse is `AnalyzeOptionsSchema`
 * at the `analyze()` entry.
 *
 * Design source: global_ignore/skl-skill-analysis-output.md §2, amended by the
 * plan decision table (R2 tokens.tokenizer, R5 files[].isText, R6 specVersion
 * date label, R7 schemaVersion "1.0.0", O1 allowedTools string[], O2 no raw,
 * O3 headings depth+text only, O4 tokens exclude readme/license).
 */
import { z } from 'zod';

// ── Deterministic constants (never computed — no clock, no env) ──

/** Semver of the SkillAnalysis JSON shape itself (R7: real semver). */
export const SCHEMA_VERSION = '1.0.0';

/** Semver of this library; kept in lockstep with package.json "version". */
export const ANALYZER_VERSION = '1.0.0';

/** Agent Skills spec snapshot this analyzer targets (R6: date label — the spec has no version number). */
export const SPEC_VERSION = 'agentskills-2025-12';

// ── Building blocks ──

export const SeveritySchema = z.enum(['error', 'warning']);

export const DiagnosticSchema = z.strictObject({
  /** Neutral stable id (no E_/W_ prefixes), e.g. "readme-missing". */
  code: z.string(),
  /** Library default, overridable by consumers via options.rules. */
  severity: SeveritySchema,
  /** Offending frontmatter field or file path, when applicable. */
  field: z.string().optional(),
  message: z.string(),
  hint: z.string().optional(),
});

export const HeadingSchema = z.strictObject({
  depth: z.number().int().min(1).max(6),
  text: z.string(),
});

export const FileKindSchema = z.enum([
  'instructions',
  'reference',
  'asset',
  'script',
  'readme',
  'license',
  'other',
]);

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const FileEntrySchema = z.strictObject({
  /** Relative POSIX path from the skill root. */
  path: z.string(),
  /** Bytes. */
  size: z.number().int().nonnegative(),
  /** True byte hash of the file (SKILL.md included verbatim — contrast with `digest`). */
  sha256: sha256Hex,
  kind: FileKindSchema,
  /** R5: whether the file decoded as UTF-8 text. */
  isText: z.boolean(),
});

export const FrontmatterSchema = z.strictObject({
  name: z.string().nullable(),
  description: z.string().nullable(),
  /** metadata.version hoisted; kept as string ("1.10" must survive). */
  version: z.string().nullable(),
  /** Declared raw value (SPDX id or free text). */
  license: z.string().nullable(),
  compatibility: z.string().nullable(),
  /** O1: parsed from the space-separated string; join is lossy (collapsed whitespace). */
  allowedTools: z.array(z.string()).nullable(),
  /** The whole metadata map (including version). */
  metadata: z.record(z.string(), z.string()).nullable(),
  /** All non-standard keys, preserved verbatim — never warned about. */
  extra: z.record(z.string(), z.unknown()),
});

// ── The contract ──

export const SkillAnalysisSchema = z.strictObject({
  // meta (deterministic constants + convenience boolean)
  schemaVersion: z.literal(SCHEMA_VERSION),
  analyzerVersion: z.string(),
  specVersion: z.string(),
  /** True iff no error-severity diagnostics remain after options.rules overrides. */
  ok: z.boolean(),

  // identity
  /** Skill root directory name (disk source); null for memory sources. */
  dir: z.string().nullable(),
  frontmatter: FrontmatterSchema,

  // instructions (SKILL.md body); null when SKILL.md is missing (plus a no-skill-md diagnostic)
  body: z
    .strictObject({
      text: z.string(),
      lines: z.number().int().nonnegative(),
      headings: z.array(HeadingSchema),
    })
    .nullable(),

  // docs
  readme: z.strictObject({ path: z.string(), text: z.string() }).nullable(),
  license: z.strictObject({
    /** = frontmatter.license */
    declared: z.string().nullable(),
    /** Recognized SPDX id (allowlist / header signature). */
    spdx: z.string().nullable(),
    /**
     * Detected LICENSE file path, relative to the skill root. The license
     * TEXT is deliberately not copied into the output — read this file for
     * the bytes (its sha256 is in files[]). License texts are not canonical
     * per SPDX id (copyright lines, appendices, wrapping vary), so the text
     * is the file's business; `spdx` is the classification.
     */
    file: z.string().nullable(),
    /** Where `spdx` came from. */
    source: z.enum(['frontmatter', 'file']).nullable(),
  }),

  // file tree (sorted by path, ascending)
  files: z.array(FileEntrySchema),

  // derived analysis
  tokens: z.strictObject({
    /** ① resident cost: name + description. */
    metadata: z.number().int().nonnegative(),
    /** ② activation cost: SKILL.md body. */
    body: z.number().int().nonnegative(),
    /** metadata + body. O4: readme/license never counted (not prompt budget). */
    total: z.number().int().nonnegative(),
    /** R2: tokenizer identity — counts are not comparable across tokenizers. */
    tokenizer: z.string(),
  }),
  references: z.strictObject({
    /** Relative paths referenced from the SKILL.md body (sorted asc). declared = resolved ∪ broken ∪ external. */
    declared: z.array(z.string()),
    resolved: z.array(z.string()),
    broken: z.array(z.string()),
    /**
     * Declared references that escape the skill folder (`../sibling/...`) and so
     * cannot be resolved within it (F7). Reported separately from `broken` —
     * they are out-of-scope, not author errors (common in vendor-CLI skill suites
     * that cross-reference a shared sibling). Sorted ascending.
     */
    external: z.array(z.string()),
    /** Files present but unreferenced (SKILL.md/README/LICENSE excluded). */
    orphans: z.array(z.string()),
  }),
  size: z.strictObject({
    total: z.number().int().nonnegative(),
    /** Only kinds with ≥1 file appear; keys emitted in FileKind enum order (byte-stable). */
    byKind: z.partialRecord(FileKindSchema, z.number().int().nonnegative()),
  }),
  /**
   * Content fingerprint, "sha256:<hex>". Authoritative definition (plan §5 R1):
   * SKILL.md's content hash is sha256(canonicalJSON(frontmatter minus
   * metadata.version, keys sorted) + "\n" + body); other files reuse their
   * byte sha256; (path, hash) pairs sorted by path joined into a manifest
   * string, then sha256'd. Implemented in P5 (src/digest.ts).
   */
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),

  // diagnostics (sorted by severity, code, field)
  diagnostics: z.array(DiagnosticSchema),
});

// ── Options ──

/**
 * Pluggable token counter. Not a zod-derived type: it carries a function and
 * exists only on the input side (options), never in the output JSON.
 */
export interface Tokenizer {
  /** Stable identity, surfaced as output `tokens.tokenizer` (R2). */
  name: string;
  count(text: string): number;
}

function isTokenizer(value: unknown): value is Tokenizer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { count?: unknown }).count === 'function'
  );
}

export const RuleOverrideSchema = z.enum(['error', 'warning', 'off']);

export const AnalyzeOptionsSchema = z.strictObject({
  /** F1: REPLACES the default ignore set (DEFAULT_IGNORE is exported for extension). */
  ignore: z.array(z.string()).optional(),
  /** F4: files larger than this are skipped from hashing — never silently (file-too-large diagnostic). */
  maxFileBytes: z.number().int().positive().optional(),
  /** Severity policy overrides per diagnostic code; "off" drops the diagnostic. */
  rules: z.record(z.string(), RuleOverrideSchema).optional(),
  /** Injectable tokenizer; default is the chars/4 approximation. */
  tokenizer: z.custom<Tokenizer>(isTokenizer, 'expected a Tokenizer ({ name, count })').optional(),
});

// ── Types (z.infer only) ──

export type Severity = z.infer<typeof SeveritySchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type Heading = z.infer<typeof HeadingSchema>;
export type FileKind = z.infer<typeof FileKindSchema>;
export type FileEntry = z.infer<typeof FileEntrySchema>;
export type Frontmatter = z.infer<typeof FrontmatterSchema>;
export type SkillAnalysis = z.infer<typeof SkillAnalysisSchema>;
export type RuleOverride = z.infer<typeof RuleOverrideSchema>;
export type AnalyzeOptions = z.infer<typeof AnalyzeOptionsSchema>;
