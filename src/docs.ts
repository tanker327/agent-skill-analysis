/**
 * Pipeline stages ⑦ and ⑧: README detection + LICENSE detection / SPDX recognition.
 *
 * ⑦  detectReadme   — case-insensitive root scan for README.md / README;
 *                     emits readme-missing on miss.
 * ⑧  detectLicense  — root scan for LICENSE / LICENSE.txt / LICENSE.md / COPYING;
 *                     two-tier SPDX recognition (frontmatter allowlist → file
 *                     head signature); emits license-missing / license-file-missing.
 *
 * Both stages are pure except for SkillSource I/O. Pure helpers (findReadmePath,
 * findLicensePath, classifySpdx) are exported so test fixtures can exercise the
 * classification logic without a real SkillSource.
 *
 * SPDX two-tier order (strict, per flow §3):
 *   1. frontmatter.license matched case-insensitively against SPDX_ALLOWLIST
 *      → spdx = matched id, source = "frontmatter"
 *   2. LICENSE file head scanned against FILE_SIGNATURES
 *      → spdx = matched id, source = "file"
 *   3. Neither → spdx = null, source = null  (file path still stored if present)
 *
 * The license TEXT is never copied into the output: texts are not canonical
 * per SPDX id (copyright lines, appendices, wrapping vary), so consumers read
 * `license.file` from the tree when they need the bytes — files[].sha256 is
 * the byte authority. Only the head (LICENSE_HEAD_LINES) is read here, for
 * signature classification.
 *
 * Note: a frontmatter.license value that fails the allowlist is NOT a diagnostic
 * — unrecognized declared licenses are valid (e.g. proprietary / custom SPDX
 * expressions). Per flow §3 and team-lead ruling 2026-06-05.
 */

import type { DiagnosticCollector } from './diagnostics.js';
import type { Frontmatter } from './schema.js';
import type { SkillSource } from './source.js';

// ── SPDX ─────────────────────────────────────────────────────────────────────

/**
 * SPDX ids recognized in both tiers of classification.
 *
 * Tier 1 (frontmatter): `frontmatter.license` is compared case-insensitively
 *   against these ids. Match → canonical id used as output `spdx`.
 * Tier 2 (file head): LICENSE file head is scanned against FILE_SIGNATURES
 *   (internal), keyed by these ids.
 *
 * Exported so test fixtures can iterate every id for corpus coverage.
 */
export const SPDX_ALLOWLIST: readonly string[] = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'GPL-2.0-only',
  'GPL-3.0-only',
  'MPL-2.0',
  'ISC',
  'Unlicense',
];

/**
 * Ordered list of file-head signature specs.
 *
 * Each entry: [spdxId, requiredStrings] — ALL required strings must appear
 * (case-insensitively) in the first LICENSE_HEAD_LINES of the license file.
 * Entries are tested in order; the first full match wins.
 *
 * GPL ordering: GPL-3.0-only before GPL-2.0-only so the "Version 3" check
 * is tried before "Version 2" (both headers start with "GNU GENERAL PUBLIC
 * LICENSE"; "Version 3" vs "Version 2" distinguishes them).
 */
const FILE_SIGNATURES: readonly [string, readonly string[]][] = [
  ['MIT', ['MIT License']],
  ['Apache-2.0', ['Apache License', 'Version 2.0']],
  ['GPL-3.0-only', ['GNU GENERAL PUBLIC LICENSE', 'Version 3']],
  ['GPL-2.0-only', ['GNU GENERAL PUBLIC LICENSE', 'Version 2']],
  ['MPL-2.0', ['Mozilla Public License', '2.0']],
  ['BSD-3-Clause', ['BSD 3-Clause']],
  ['BSD-2-Clause', ['BSD 2-Clause']],
  ['ISC', ['ISC License']],
  ['Unlicense', ['This is free and unencumbered software released into the public domain']],
];

/** Number of lines from the top of a LICENSE file used for signature matching. */
const LICENSE_HEAD_LINES = 20;

// ── Candidate basenames ───────────────────────────────────────────────────────

/** Recognized README basenames (lowercased for case-insensitive lookup). */
const README_BASENAMES = new Set(['readme.md', 'readme']);

/** Recognized LICENSE basenames (lowercased for case-insensitive lookup). */
const LICENSE_BASENAMES = new Set(['license', 'license.txt', 'license.md', 'copying']);

// ── Types ─────────────────────────────────────────────────────────────────────

/** Output shape for detectLicense, matching the schema's `license` field. */
export interface LicenseResult {
  declared: string | null;
  spdx: string | null;
  file: string | null;
  source: 'frontmatter' | 'file' | null;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Find the README path in the skill root.
 *
 * Only considers root-level paths (no `/` separator). Match is case-insensitive.
 * Returns the first match in iteration order (`paths` is caller-sorted, so
 * output is deterministic). Returns null when no README is present.
 */
export function findReadmePath(paths: readonly string[]): string | null {
  for (const p of paths) {
    if (!p.includes('/') && README_BASENAMES.has(p.toLowerCase())) return p;
  }
  return null;
}

/**
 * Find the LICENSE file path in the skill root.
 *
 * Only considers root-level paths (no `/` separator). Match is case-insensitive.
 * Recognizes: LICENSE, LICENSE.txt, LICENSE.md, COPYING.
 * Returns the first match in iteration order. Returns null when not found.
 */
export function findLicensePath(paths: readonly string[]): string | null {
  for (const p of paths) {
    if (!p.includes('/') && LICENSE_BASENAMES.has(p.toLowerCase())) return p;
  }
  return null;
}

/**
 * Two-tier SPDX classification (pure — no I/O).
 *
 * @param declared  `frontmatter.license` value (may be null).
 * @param fileHead  First LICENSE_HEAD_LINES lines joined with '\n' (may be null).
 */
export function classifySpdx(
  declared: string | null,
  fileHead: string | null,
): { spdx: string | null; source: 'frontmatter' | 'file' | null } {
  // Tier 1: frontmatter allowlist (case-insensitive, canonical id in output).
  if (declared !== null) {
    const lower = declared.toLowerCase();
    const match = SPDX_ALLOWLIST.find((id) => id.toLowerCase() === lower);
    if (match !== undefined) return { spdx: match, source: 'frontmatter' };
  }

  // Tier 2: file head signatures.
  if (fileHead !== null) {
    const lower = fileHead.toLowerCase();
    for (const [spdxId, required] of FILE_SIGNATURES) {
      if (required.every((s) => lower.includes(s.toLowerCase()))) {
        return { spdx: spdxId, source: 'file' };
      }
    }
  }

  return { spdx: null, source: null };
}

// ── Stage ⑦: README ───────────────────────────────────────────────────────────

/**
 * Stage ⑦: locate and read the skill's README file.
 *
 * Searches `paths` (caller-sorted enumeration) for a root-level README.md or
 * README (case-insensitive). Reads via the same UTF-8 path as SKILL.md
 * (TextDecoder fatal:false — invalid bytes become replacement chars).
 *
 * Emits readme-missing (warning) when no README is found.
 */
export async function detectReadme(
  paths: readonly string[],
  skillSource: SkillSource,
  collector: DiagnosticCollector,
): Promise<{ path: string; text: string } | null> {
  const readmePath = findReadmePath(paths);
  if (readmePath === null) {
    collector.emit('readme-missing');
    return null;
  }
  const bytes = await skillSource.read(readmePath);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return { path: readmePath, text };
}

// ── Stage ⑧: LICENSE + SPDX ──────────────────────────────────────────────────

/**
 * Stage ⑧: locate, read, and classify the skill's LICENSE file.
 *
 * Searches `paths` for a root-level LICENSE / LICENSE.txt / LICENSE.md /
 * COPYING (case-insensitive). Applies two-tier SPDX classification:
 *   1. frontmatter.license → SPDX_ALLOWLIST (case-insensitive)
 *   2. LICENSE file first 20 lines → FILE_SIGNATURES patterns
 *
 * Diagnostics emitted:
 *   • license-missing       — neither frontmatter.license nor a license file
 *   • license-file-missing  — frontmatter.license is set but no file found
 *
 * An unrecognized frontmatter.license that doesn't match the allowlist is
 * NOT a diagnostic — proprietary / non-standard license expressions are valid.
 */
export async function detectLicense(
  paths: readonly string[],
  frontmatter: Frontmatter,
  skillSource: SkillSource,
  collector: DiagnosticCollector,
): Promise<LicenseResult> {
  const declared = frontmatter.license;
  const licensePath = findLicensePath(paths);

  // Diagnostics: missing cases only (unrecognized declared = silent per flow §3).
  if (declared === null && licensePath === null) {
    collector.emit('license-missing');
  } else if (declared !== null && licensePath === null) {
    collector.emit('license-file-missing', { field: 'license' });
  }

  // Read the license file head (if present) — classification only; the full
  // text is never kept (see module header).
  let fileHead: string | null = null;
  if (licensePath !== null) {
    const bytes = await skillSource.read(licensePath);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    fileHead = text.split('\n').slice(0, LICENSE_HEAD_LINES).join('\n');
  }

  const { spdx, source } = classifySpdx(declared, fileHead);

  return {
    declared,
    spdx,
    file: licensePath,
    source,
  };
}
