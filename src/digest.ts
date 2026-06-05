/**
 * Pipeline stage: content digest (plan §5, invariant R1).
 *
 * Produces a single "sha256:<hex>" string that is a stable content fingerprint
 * of the skill. A version-only bump (metadata.version change) leaves the digest
 * unchanged; any edit to SKILL.md prose, frontmatter fields, or other files
 * changes it.
 *
 * ── Authoritative definition (frozen — any change is an arch commit) ──────────
 *
 * digest = "sha256:" + sha256( manifestString )
 *
 * manifestString = concatenation of `${path}\n${contentHash}\n`
 *                  for each file entry, sorted by path ascending (UTF-16
 *                  lexicographic, same as JavaScript's default Array.sort).
 *                  UTF-8 encoded before hashing.
 *
 * contentHash per file:
 *   SKILL.md → sha256( canonicalJSON(rawFrontmatter − metadata.version) + "\n" + body )
 *              where the input string is UTF-8 encoded before hashing.
 *   all other files → their files[].sha256 (true byte hash from stage ⑨).
 *
 * rawFrontmatter = the object returned by yaml.parse(yamlBlock), NOT our
 *                  normalized Frontmatter shape. Parsing errors or absent YAML
 *                  block → use {} (best-effort, never throw).
 *
 * ── canonicalJSON definition (normative — cross-language reproducibility) ─────
 *
 * canonicalJSON(value) serializes to compact JSON with:
 *   1. No whitespace between tokens.
 *   2. Object keys sorted lexicographically on UTF-16 code units (JavaScript
 *      default string `<` comparison; NOT localeCompare, NOT Unicode normalization).
 *   3. Key sort is applied recursively to every nested object.
 *   4. String escaping: JSON.stringify semantics (solidus "/" NOT escaped;
 *      control chars below U+0020 use \u-escape; " and \ use short escapes).
 *   5. Number format: JSON.stringify output (no trailing zeros beyond what
 *      JSON.stringify produces; "-" prefix for negatives; Infinity/NaN from
 *      YAML (.inf/.nan) serialize as null; -0 serializes as 0).
 *   6. null → "null"; true → "true"; false → "false".
 *   7. Arrays: elements serialized recursively; element order preserved.
 *   8. undefined/function/symbol object values → omitted (JSON.stringify parity).
 *
 * ── Edge cases (explicitly defined) ──────────────────────────────────────────
 *
 * • No SKILL.md in tree → digest over remaining files; no SKILL.md entry.
 * • YAML block absent or unparseable → canonicalJSON({}) + "\n" + body.
 * • Empty YAML block (---\n--- fence) → yaml.parse('') → null → treated as {}.
 * • metadata field missing or not an object → deletion is a no-op.
 * • Cyclic YAML anchors (e.g. `a: &x\n  b: *x`) → the raw parsed object is
 *   run through projectJsonSafe (frontmatter.ts) before canonicalJSON sees it;
 *   cyclic references serialize as null at the point of revisit; traversal is
 *   depth-first in sorted-key order (matching canonicalJSON's key ordering).
 * • Non-finite numbers (.inf / .nan from YAML) and -0 follow JSON.stringify
 *   semantics when serialized: Infinity → null, NaN → null, -0 → 0.
 * • No files at all (empty tree after ignore + over-limit filtering) →
 *     manifestString = "" → digest = sha256("") =
 *     sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
 */

import { parse as parseYaml } from 'yaml';
import { projectJsonSafe, splitSkillMd } from './frontmatter.js';
import type { FileEntry } from './schema.js';

// ── SHA-256 ───────────────────────────────────────────────────────────────────

/**
 * SHA-256 of a Uint8Array → lowercase hex string (64 chars).
 * Uses WebCrypto (runtime-agnostic: browsers, Node.js 20+, Deno, Workers).
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── canonicalJSON ─────────────────────────────────────────────────────────────

/**
 * Serialize `value` to canonical JSON per the frozen definition in the module
 * doc-block above. This function IS the normative implementation — its comment
 * is transcribed into the P6 README verbatim.
 *
 * Do NOT change without: (a) updating digest stability tests, (b) bumping
 * schemaVersion, (c) landing as an arch commit with a README update.
 */
export function canonicalJSON(value: unknown): string {
  // null / primitives: delegate to JSON.stringify for correct escaping + format.
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    // JSON.stringify handles: null→"null", bool→"true"/"false",
    // number→standard JSON number, string→JSON-escaped string.
    // Infinity/NaN are stringified to "null" by JSON.stringify (edge case).
    return JSON.stringify(value) as string;
  }

  if (Array.isArray(value)) {
    // Elements serialized recursively; order preserved.
    return '[' + value.map(canonicalJSON).join(',') + ']';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Sort keys lexicographically on UTF-16 code units (JS default sort —
    // no locale, no normalization). Applied to this level only; nested
    // objects are sorted by recursive calls.
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys
      .filter((k) => obj[k] !== undefined) // omit undefined values (JSON.stringify parity)
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
    return '{' + pairs.join(',') + '}';
  }

  // undefined / function / symbol at top level — not from YAML, but be safe.
  return 'null';
}

// ── Frontmatter preparation ───────────────────────────────────────────────────

/**
 * Return a shallow-cloned version of `raw` with `metadata.version` removed.
 *
 * - If `raw` is not a plain object → return as-is (nothing to delete).
 * - If `raw.metadata` is not a plain object → return raw with metadata unchanged.
 * - Otherwise → clone metadata, delete 'version' key, return modified clone.
 *   An empty metadata object {} is kept (not deleted) — only the version key
 *   is removed.
 */
function stripMetadataVersion(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  const meta = obj['metadata'];
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    // metadata absent or not a plain object → nothing to strip.
    return obj;
  }
  // Shallow-clone both the top-level object and the metadata sub-object.
  const clonedMeta = { ...(meta as Record<string, unknown>) };
  delete clonedMeta['version'];
  return { ...obj, metadata: clonedMeta };
}

// ── SKILL.md content hash ─────────────────────────────────────────────────────

/**
 * Compute the SKILL.md content hash per the R1 definition.
 *
 * contentHash(SKILL.md) = sha256( canonicalJSON(rawFrontmatter − version) + "\n" + body )
 *
 * The YAML block is re-parsed fresh (isolated from normalize diagnostics).
 * Any parse error → rawFrontmatter = {} (best-effort, never throw).
 * Empty/absent YAML block → rawFrontmatter = {} (yaml.parse('') returns null).
 */
async function computeSkillMdContentHash(skillMdText: string): Promise<string> {
  const { yamlBlock, body } = splitSkillMd(skillMdText);

  // Re-parse the raw YAML block fresh — NOT our normalized Frontmatter shape.
  let rawFrontmatter: unknown = {};
  if (yamlBlock !== null) {
    try {
      // yaml.parse('') → null (empty YAML document); fall back to {}.
      // projectJsonSafe breaks any cyclic YAML anchor references so that
      // canonicalJSON never encounters a circular object (consistent with
      // how parseFrontmatterFromText projects the same parse at stage ③).
      // logLevel 'error' (matches stage ③): silences process.emitWarning for
      // non-fatal YAML issues; parse results and error-throwing are unchanged.
      rawFrontmatter = projectJsonSafe(
        (parseYaml(yamlBlock, { logLevel: 'error' }) as unknown) ?? {},
      );
    } catch {
      // Unparseable YAML → best-effort empty object; pipeline already emits
      // frontmatter-parse diagnostic for this case.
      rawFrontmatter = {};
    }
  }

  const stripped = stripMetadataVersion(rawFrontmatter);
  const canonical = canonicalJSON(stripped) + '\n' + body;
  const bytes = new TextEncoder().encode(canonical);
  return sha256Hex(bytes);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute the skill content digest.
 *
 * @param manifestFiles  Output of buildManifest — sorted by path ascending.
 *                       Used for contentHash of every non-SKILL.md file.
 * @param skillMdText    Full raw SKILL.md text (null when SKILL.md is absent).
 *                       Passed as raw bytes → UTF-8 string so it matches the
 *                       source exactly (fatal:false decode already applied).
 */
export async function computeDigest(
  manifestFiles: readonly FileEntry[],
  skillMdText: string | null,
): Promise<string> {
  // ── Build (path → contentHash) map ─────────────────────────────────────────

  // Collect all (path, contentHash) entries. Over-limit files are absent from
  // manifestFiles but may still be in `paths` (the stage ① list). They are NOT
  // in the digest because they were not hashed — their file-too-large diagnostic
  // makes their exclusion explicit to the consumer.

  const entries: [string, string][] = [];

  // SKILL.md gets the canonical content hash (not its raw byte sha256).
  if (skillMdText !== null) {
    const skillMdHash = await computeSkillMdContentHash(skillMdText);
    entries.push(['SKILL.md', skillMdHash]);
  }

  // All other files use their byte sha256 from the manifest.
  for (const f of manifestFiles) {
    if (f.path !== 'SKILL.md') {
      entries.push([f.path, f.sha256]);
    }
  }

  // ── Build manifest string ───────────────────────────────────────────────────
  //
  // Sort by path (UTF-16 lexicographic — JS default).
  // manifestFiles is already sorted from stage ①, but we sort entries[]
  // explicitly to guarantee correctness regardless of insertion order above.
  // Paths are unique in the skill tree — the equal-path case is structurally
  // impossible, so a two-valued comparator is correct and has no dead branch.
  entries.sort(([a], [b]) => (a < b ? -1 : 1));

  // Format: `${path}\n${contentHash}\n` per entry, concatenated.
  // The '\n' separator is literal (not platform line-ending); frozen forever.
  const manifestString = entries.map(([p, h]) => `${p}\n${h}\n`).join('');

  // ── Final SHA-256 ───────────────────────────────────────────────────────────
  const manifestBytes = new TextEncoder().encode(manifestString);
  const hex = await sha256Hex(manifestBytes);
  return `sha256:${hex}`;
}
