/**
 * Pipeline stage ⑨: per-file manifest.
 *
 * Reads every non-ignored path from the skill source and produces:
 *   • files[]    — FileEntry per file, sorted by path (ascending)
 *   • size.total — total bytes across all included files
 *   • size.byKind — byte totals per FileKind, in enum declaration order
 *
 * Kind classification (first match wins):
 *   SKILL.md                   → 'instructions'
 *   detected README path       → 'readme'   (reuses docs.ts result — never disagrees)
 *   detected LICENSE path      → 'license'  (reuses docs.ts result — never disagrees)
 *   first path segment 'scripts'    → 'script'
 *   first path segment 'references' → 'reference'
 *   first path segment 'assets'     → 'asset'
 *   anything else              → 'other'
 *
 * SHA-256 is computed with WebCrypto (runtime-agnostic).
 * isText probe: try TextDecoder(fatal:true) — throws → binary.
 *
 * F4: files whose byte count exceeds options.maxFileBytes are skipped from
 * files[] and from size, but a 'file-too-large' diagnostic is emitted with
 * field = the file path. Never silent.
 */

import { isRootReadme } from './docs.js';
import type { DiagnosticCollector } from './diagnostics.js';
import type { FileEntry, FileKind } from './schema.js';
import type { SkillSource } from './source.js';

// ── FileKind enum order (must match FileKindSchema declaration in schema.ts) ──
//
// byKind keys are emitted in this order so the JSON is byte-stable (determinism
// requirement; the architect resolved this in P0).

const FILE_KIND_ORDER: readonly FileKind[] = [
  'instructions',
  'reference',
  'asset',
  'script',
  'readme',
  'license',
  'other',
];

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Classify a file path as one of the FileKind enum values.
 *
 * `readmePath` and `licensePath` come from the docs stage so the two stages
 * always agree on which file is the README / LICENSE — no independent scan.
 */
function classifyKind(
  path: string,
  readmePath: string | null,
  licensePath: string | null,
): FileKind {
  if (path === 'SKILL.md') return 'instructions';
  if (readmePath !== null && path === readmePath) return 'readme';
  if (licensePath !== null && path === licensePath) return 'license';
  // Localized README variants beyond the single detected one (README.en.md when
  // README.md is the detected README) are still READMEs, not 'other' (F4).
  if (isRootReadme(path)) return 'readme';
  // Use first path segment to classify by convention directory.
  // Destructuring default avoids noUncheckedIndexedAccess on split()[0].
  const [firstSegment = ''] = path.split('/');
  if (firstSegment === 'scripts') return 'script';
  if (firstSegment === 'references') return 'reference';
  if (firstSegment === 'assets') return 'asset';
  return 'other';
}

/**
 * R5: probe whether a byte buffer is valid UTF-8 text.
 *
 * Uses TextDecoder with `fatal: true` — any invalid byte sequence throws,
 * which we catch to return false. Pure CPU; no I/O.
 */
function probeIsText(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the SHA-256 hex digest of a byte buffer using WebCrypto.
 *
 * WebCrypto is available in browsers, Node.js 20+, Deno, and Cloudflare
 * Workers — keeping the core runtime-agnostic (no node:crypto import).
 */
async function hashBytes(bytes: Uint8Array): Promise<string> {
  const buffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Public types ──────────────────────────────────────────────────────────────

/** Result returned by `buildManifest`, consumed by `analyze.ts`. */
export interface ManifestResult {
  /** All successfully processed files, sorted by path ascending. */
  files: FileEntry[];
  /** Byte-count summary consumed by the schema's `size` field. */
  size: {
    /** Total bytes across all included files (excludes over-limit skips). */
    total: number;
    /** Bytes per FileKind; only kinds with ≥1 file appear; enum order (byte-stable). */
    byKind: Partial<Record<FileKind, number>>;
  };
}

// ── Stage ⑨ ──────────────────────────────────────────────────────────────────

/**
 * Stage ⑨: build the per-file manifest.
 *
 * Processes every path in `paths` (caller-sorted from stage ①) in order,
 * preserving sort in the output files array.
 *
 * @param paths       Sorted non-ignored paths from stage ①.
 * @param source      Skill source for reading file bytes.
 * @param readmePath  Path detected by docs stage (or null) — used for kind.
 * @param licensePath Path detected by docs stage (or null) — used for kind.
 * @param maxFileBytes From AnalyzeOptions; if exceeded, file is skipped.
 * @param collector   Receives 'file-too-large' for over-limit files.
 */
export async function buildManifest(
  paths: readonly string[],
  source: SkillSource,
  readmePath: string | null,
  licensePath: string | null,
  maxFileBytes: number | undefined,
  collector: DiagnosticCollector,
): Promise<ManifestResult> {
  const entries: FileEntry[] = [];

  for (const path of paths) {
    const bytes = await source.read(path);
    const size = bytes.byteLength;

    // F4: over-limit files are excluded from files[] — never silently.
    if (maxFileBytes !== undefined && size > maxFileBytes) {
      collector.emit('file-too-large', {
        field: path,
        message: `${path}: ${size} bytes exceeds maxFileBytes (${maxFileBytes}).`,
      });
      continue;
    }

    const sha256 = await hashBytes(bytes);
    const isText = probeIsText(bytes);
    const kind = classifyKind(path, readmePath, licensePath);

    entries.push({ path, size, sha256, kind, isText });
  }

  // Accumulate byte totals per kind (entries already in path order from stage ①).
  const kindTotals = new Map<FileKind, number>();
  for (const f of entries) {
    kindTotals.set(f.kind, (kindTotals.get(f.kind) ?? 0) + f.size);
  }

  // Emit byKind in enum declaration order — byte-stable output (determinism R1).
  const byKind: Partial<Record<FileKind, number>> = {};
  for (const kind of FILE_KIND_ORDER) {
    const kindTotal = kindTotals.get(kind);
    if (kindTotal !== undefined) byKind[kind] = kindTotal;
  }

  const total = entries.reduce((sum, f) => sum + f.size, 0);

  return { files: entries, size: { total, byKind } };
}
