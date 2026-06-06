/**
 * Unit and integration tests for src/docs.ts — pipeline stages ⑦ (README
 * detection) and ⑧ (LICENSE detection + SPDX recognition).
 *
 * Three exported pure helpers allow testing without a real SkillSource:
 *   • findReadmePath(paths)           — stage ⑦ path search
 *   • findLicensePath(paths)          — stage ⑧ path search
 *   • classifySpdx(declared, head)    — two-tier SPDX classification
 *
 * The detect* stage functions (async, need SkillSource) are covered through
 * analyze() integration tests.
 *
 * SPDX corpus strategy (team-lead directive):
 *   Iterate SPDX_ALLOWLIST so adding a new id without a matching
 *   FILE_SIGNATURE_TEXTS entry causes an immediate loud failure.
 *
 * Two-tier SPDX order (flow §3):
 *   1. frontmatter.license case-insensitively in SPDX_ALLOWLIST → source="frontmatter"
 *   2. LICENSE file first-20-lines signature matching           → source="file"
 *   3. Neither                                                  → spdx=null
 */
import { describe, expect, it } from 'vitest';
import { analyze, SkillAnalysisSchema } from '../src/index.js';
import { classifySpdx, findLicensePath, findReadmePath, SPDX_ALLOWLIST } from '../src/docs.js';
import { mem } from './helpers.js';

// ── Canonical signature texts for file-based SPDX detection ──────────────────
//
// Each entry must trigger the matching FILE_SIGNATURES entry in docs.ts.
// Strings are matched case-insensitively inside the first 20 lines of the
// license file. If SPDX_ALLOWLIST grows without a matching entry here, the
// corpus completeness test fails loudly, and sigText() also throws on access.

const FILE_SIGNATURE_TEXTS: Record<string, string> = {
  MIT: 'MIT License\n\nCopyright (c) 2026 Test Author\n\nPermission is hereby granted, free of charge...',
  'Apache-2.0':
    'Apache License\nVersion 2.0, January 2004\n\nTerms and conditions for use, reproduction...',
  'GPL-3.0-only':
    'GNU GENERAL PUBLIC LICENSE\nVersion 3, June 2007\n\nEveryone is permitted to copy and distribute...',
  'GPL-2.0-only':
    'GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991\n\nEveryone is permitted to copy and distribute...',
  'MPL-2.0':
    'Mozilla Public License\n2.0\n\nPermissions of this weak copyleft license are conditioned...',
  'BSD-3-Clause': 'BSD 3-Clause License\n\nRedistribution and use in source and binary forms...',
  'BSD-2-Clause': 'BSD 2-Clause License\n\nRedistribution and use in source and binary forms...',
  ISC: 'ISC License\n\nCopyright (c) 2026 Test Author\n\nPermission to use, copy, modify...',
  Unlicense:
    'This is free and unencumbered software released into the public domain\n\nAnyone is free to copy...',
};

/**
 * Look up a canonical signature text by SPDX id.
 * Returns `string` (not `string | undefined`) so callers are type-safe.
 * Throws loudly if the id has no entry — a test-authoring error caught both
 * here and by the completeness-guard `it` below.
 */
function sigText(id: string): string {
  const s = FILE_SIGNATURE_TEXTS[id];
  if (s === undefined) {
    throw new Error(
      `No FILE_SIGNATURE_TEXTS entry for SPDX id "${id}" — add one to tests/docs.test.ts`,
    );
  }
  return s;
}

// Minimal valid SKILL.md used across integration tests.
const VALID_SKILL =
  '---\nname: docs-skill\ndescription: Docs integration test.\nmetadata:\n  version: "1.0.0"\n---\n\n# Body\n\nContent.';

// SKILL.md with frontmatter.license declared.
function skillWithLicense(id: string): string {
  return `---\nname: docs-skill\ndescription: Docs integration test.\nmetadata:\n  version: "1.0.0"\nlicense: ${id}\n---\n\n# Body\n\nContent.`;
}

function codes(result: Awaited<ReturnType<typeof analyze>>): string[] {
  return result.diagnostics.map((d) => d.code);
}

// ── Section 0-A: findReadmePath (pure) ───────────────────────────────────────

describe('findReadmePath — pure path search', () => {
  it('empty path list → null', () => {
    expect(findReadmePath([])).toBeNull();
  });

  it('README.md at root → returned', () => {
    expect(findReadmePath(['README.md', 'SKILL.md'])).toBe('README.md');
  });

  it('readme.md (lowercase) → returned', () => {
    expect(findReadmePath(['SKILL.md', 'readme.md'])).toBe('readme.md');
  });

  it('README (no extension) → returned', () => {
    expect(findReadmePath(['SKILL.md', 'README'])).toBe('README');
  });

  it('README.md in a subdirectory is NOT matched (root-level only)', () => {
    expect(findReadmePath(['docs/README.md'])).toBeNull();
  });

  it('returns first match when multiple README variants present', () => {
    // Paths are caller-sorted (analyze() sorts before passing); 'README' sorts
    // before 'README.md' lexicographically, so it deterministically wins.
    const paths = ['README', 'README.md', 'SKILL.md'];
    const result = findReadmePath(paths);
    expect(result).toBe('README');
  });

  it('README.txt is NOT a recognized README filename', () => {
    expect(findReadmePath(['README.txt'])).toBeNull();
  });

  it('no README variant in list → null', () => {
    expect(findReadmePath(['SKILL.md', 'LICENSE', 'references/guide.md'])).toBeNull();
  });
});

// ── Section 0-B: findLicensePath (pure) ──────────────────────────────────────

describe('findLicensePath — pure path search', () => {
  it('empty path list → null', () => {
    expect(findLicensePath([])).toBeNull();
  });

  it('LICENSE at root → returned', () => {
    expect(findLicensePath(['LICENSE', 'SKILL.md'])).toBe('LICENSE');
  });

  it('LICENSE.txt → returned', () => {
    expect(findLicensePath(['LICENSE.txt'])).toBe('LICENSE.txt');
  });

  it('LICENSE.md → returned', () => {
    expect(findLicensePath(['LICENSE.md'])).toBe('LICENSE.md');
  });

  it('COPYING → returned', () => {
    expect(findLicensePath(['COPYING'])).toBe('COPYING');
  });

  it('LICENSE file in a subdirectory is NOT matched (root-level only)', () => {
    expect(findLicensePath(['legal/LICENSE'])).toBeNull();
  });

  it('no LICENSE variant in list → null', () => {
    expect(findLicensePath(['SKILL.md', 'README.md', 'references/a.md'])).toBeNull();
  });

  it('LICENSE.rst is NOT a recognized LICENSE filename', () => {
    expect(findLicensePath(['LICENSE.rst'])).toBeNull();
  });
});

// ── Section 0-C: classifySpdx (pure) ─────────────────────────────────────────

describe('classifySpdx — two-tier SPDX classification', () => {
  // ── Tier 1: frontmatter allowlist ──

  it('declared MIT → spdx="MIT", source="frontmatter"', () => {
    expect(classifySpdx('MIT', null)).toEqual({ spdx: 'MIT', source: 'frontmatter' });
  });

  it('tier 1 is case-insensitive: "mit" → spdx="MIT"', () => {
    expect(classifySpdx('mit', null)).toEqual({ spdx: 'MIT', source: 'frontmatter' });
  });

  it('tier 1 is case-insensitive: "apache-2.0" → spdx="Apache-2.0"', () => {
    expect(classifySpdx('apache-2.0', null)).toEqual({
      spdx: 'Apache-2.0',
      source: 'frontmatter',
    });
  });

  it('declared value not in allowlist → spdx=null, source=null (no diagnostic — proprietary ok)', () => {
    expect(classifySpdx('Proprietary', null)).toEqual({ spdx: null, source: null });
  });

  it('declared=null, fileHead=null → spdx=null, source=null', () => {
    expect(classifySpdx(null, null)).toEqual({ spdx: null, source: null });
  });

  // ── Tier 2: file head signatures ──

  it('MIT file signature → spdx="MIT", source="file"', () => {
    expect(classifySpdx(null, sigText('MIT'))).toEqual({
      spdx: 'MIT',
      source: 'file',
    });
  });

  it('file signature matching is case-insensitive', () => {
    const lower = (sigText('MIT') ?? '').toLowerCase();
    expect(classifySpdx(null, lower)).toEqual({ spdx: 'MIT', source: 'file' });
  });

  it('unrecognized file head → spdx=null, source=null', () => {
    expect(classifySpdx(null, 'All Rights Reserved. No use permitted.')).toEqual({
      spdx: null,
      source: null,
    });
  });

  // ── Tier precedence ──

  it('tier 1 wins over tier 2 when both present', () => {
    // frontmatter says MIT; file head says Apache. MIT wins (tier 1 first).
    const result = classifySpdx('MIT', sigText('Apache-2.0'));
    expect(result).toEqual({ spdx: 'MIT', source: 'frontmatter' });
  });

  it('falls through to tier 2 when declared is not in allowlist but file matches', () => {
    // Declared "Proprietary" fails allowlist → tier 2 kicks in.
    const result = classifySpdx('Proprietary', sigText('MIT'));
    expect(result).toEqual({ spdx: 'MIT', source: 'file' });
  });

  // ── GPL ordering (GPL-3.0-only must be tested before GPL-2.0-only) ──

  it('GPL-3.0-only file signature does not mis-classify as GPL-2.0-only', () => {
    expect(classifySpdx(null, sigText('GPL-3.0-only'))).toEqual({
      spdx: 'GPL-3.0-only',
      source: 'file',
    });
  });

  it('GPL-2.0-only file signature does not mis-classify as GPL-3.0-only', () => {
    expect(classifySpdx(null, sigText('GPL-2.0-only'))).toEqual({
      spdx: 'GPL-2.0-only',
      source: 'file',
    });
  });
});

// ── Section 1: SPDX allowlist corpus ─────────────────────────────────────────
//
// Iterating SPDX_ALLOWLIST ensures a new allowlist entry without a matching
// FILE_SIGNATURE_TEXTS entry causes an immediate loudly-failing test.

describe('SPDX allowlist corpus — one fixture per id (tier 1 + tier 2)', () => {
  it('FILE_SIGNATURE_TEXTS covers every id in SPDX_ALLOWLIST', () => {
    const missing = SPDX_ALLOWLIST.filter((id) => !(id in FILE_SIGNATURE_TEXTS));
    if (missing.length > 0) {
      expect.fail(
        `These SPDX ids are in SPDX_ALLOWLIST but have no FILE_SIGNATURE_TEXTS entry:\n` +
          missing.map((id) => `  • ${id}`).join('\n') +
          `\nAdd a canonical signature text for each to FILE_SIGNATURE_TEXTS in tests/docs.test.ts.`,
      );
    }
  });

  describe('tier 1 (frontmatter allowlist) — each id matches via classifySpdx(id, null)', () => {
    for (const id of SPDX_ALLOWLIST) {
      it(`${id}: classifySpdx("${id}", null) → spdx="${id}", source="frontmatter"`, () => {
        const result = classifySpdx(id, null);
        expect(result.spdx).toBe(id);
        expect(result.source).toBe('frontmatter');
      });
    }
  });

  describe('tier 2 (file head) — each id matched by its canonical signature text', () => {
    for (const id of SPDX_ALLOWLIST) {
      it(`${id}: file signature → spdx="${id}", source="file"`, () => {
        const sig = sigText(id); // throws loudly if id missing; corpus-guard above catches first
        const result = classifySpdx(null, sig);
        expect(result.spdx).toBe(id);
        expect(result.source).toBe('file');
      });
    }
  });
});

// ── Section 2: Integration via analyze() ─────────────────────────────────────

describe('README detection via analyze()', () => {
  it('README.md present → readme.path="README.md", readme.text contains content', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': VALID_SKILL, 'README.md': '# My Skill\n\nDescription.' }),
    );
    expect(result.readme).not.toBeNull();
    expect(result.readme?.path).toBe('README.md');
    expect(result.readme?.text).toContain('# My Skill');
  });

  it('readme.md (lowercase) is also detected', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': VALID_SKILL, 'readme.md': '# lowercase readme' }),
    );
    expect(result.readme).not.toBeNull();
    expect(result.readme?.path).toBe('readme.md');
  });

  it('README (no extension) is detected', async () => {
    const result = await analyze(mem({ 'SKILL.md': VALID_SKILL, README: 'Plain text readme.' }));
    expect(result.readme).not.toBeNull();
    expect(result.readme?.path).toBe('README');
  });

  it('no README → readme=null and readme-missing emitted (warning)', async () => {
    const result = await analyze(mem({ 'SKILL.md': VALID_SKILL, LICENSE: sigText('MIT') }));
    expect(result.readme).toBeNull();
    expect(codes(result)).toContain('readme-missing');
    const diag = result.diagnostics.find((d) => d.code === 'readme-missing');
    expect(diag?.severity).toBe('warning');
  });

  it('readme-missing: ok stays true (warning, not error)', async () => {
    const result = await analyze(mem({ 'SKILL.md': VALID_SKILL, LICENSE: sigText('MIT') }));
    expect(result.ok).toBe(true);
  });

  it('README in a subdirectory is not detected (root-level only)', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': VALID_SKILL, 'docs/README.md': '# Sub readme' }),
    );
    expect(result.readme).toBeNull();
    expect(codes(result)).toContain('readme-missing');
  });
});

describe('LICENSE detection and SPDX recognition via analyze()', () => {
  // ── License file detection ──

  it('LICENSE file present → license.file="LICENSE" (text is never copied to output)', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': VALID_SKILL,
        'README.md': '# Readme',
        LICENSE: sigText('MIT'),
      }),
    );
    expect(result.license.file).toBe('LICENSE');
    // The license text is deliberately NOT in the output — consumers read
    // license.file from the tree; files[].sha256 is the byte authority.
    expect(result.license).not.toHaveProperty('text');
  });

  it('LICENSE.txt is also detected', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': VALID_SKILL,
        'README.md': '# Readme',
        'LICENSE.txt': sigText('MIT'),
      }),
    );
    expect(result.license.file).toBe('LICENSE.txt');
  });

  it('LICENSE.md is also detected', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': VALID_SKILL,
        'README.md': '# Readme',
        'LICENSE.md': sigText('MIT'),
      }),
    );
    expect(result.license.file).toBe('LICENSE.md');
  });

  it('COPYING is also detected', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': VALID_SKILL,
        'README.md': '# Readme',
        COPYING: sigText('GPL-3.0-only'),
      }),
    );
    expect(result.license.file).toBe('COPYING');
    expect(result.license.spdx).toBe('GPL-3.0-only');
  });

  // ── SPDX from file ──

  it('MIT file signature → spdx="MIT", source="file"', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': VALID_SKILL,
        'README.md': '# Readme',
        LICENSE: sigText('MIT'),
      }),
    );
    expect(result.license.spdx).toBe('MIT');
    expect(result.license.source).toBe('file');
    expect(result.license.declared).toBeNull();
  });

  // ── SPDX from frontmatter ──

  it('frontmatter license: MIT (no file) → spdx="MIT", source="frontmatter"', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': skillWithLicense('MIT'), 'README.md': '# Readme' }),
    );
    expect(result.license.spdx).toBe('MIT');
    expect(result.license.source).toBe('frontmatter');
    expect(result.license.declared).toBe('MIT');
  });

  it('frontmatter tier-1 wins over file tier-2 when both present', async () => {
    // Frontmatter says MIT; file contains Apache-2.0 header. MIT wins.
    const result = await analyze(
      mem({
        'SKILL.md': skillWithLicense('MIT'),
        'README.md': '# Readme',
        LICENSE: sigText('Apache-2.0'),
      }),
    );
    expect(result.license.spdx).toBe('MIT');
    expect(result.license.source).toBe('frontmatter');
    // File path is still stored even when frontmatter wins.
    expect(result.license.file).toBe('LICENSE');
  });

  // ── Custom / proprietary license ──

  it('custom license (not in allowlist) → spdx=null, source=null, file path kept', async () => {
    const proprietaryText = 'All Rights Reserved. No use without written permission.';
    const result = await analyze(
      mem({
        'SKILL.md': skillWithLicense('Proprietary-Internal'),
        'README.md': '# Readme',
        LICENSE: proprietaryText,
      }),
    );
    expect(result.license.spdx).toBeNull();
    expect(result.license.source).toBeNull();
    expect(result.license.declared).toBe('Proprietary-Internal');
    expect(result.license.file).toBe('LICENSE');
  });

  it('LICENSE file with unrecognized header → spdx=null, file path still stored', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': VALID_SKILL,
        'README.md': '# Readme',
        LICENSE: 'Custom License Text\n\nYou may use this however you like.',
      }),
    );
    expect(result.license.spdx).toBeNull();
    expect(result.license.file).toBe('LICENSE');
  });

  // ── Diagnostic: license-missing ──

  it('no frontmatter.license + no license file → license-missing (warning)', async () => {
    const result = await analyze(mem({ 'SKILL.md': VALID_SKILL, 'README.md': '# Readme' }));
    expect(codes(result)).toContain('license-missing');
    const diag = result.diagnostics.find((d) => d.code === 'license-missing');
    expect(diag?.severity).toBe('warning');
  });

  it('license-missing: ok stays true (warning, not error)', async () => {
    const result = await analyze(mem({ 'SKILL.md': VALID_SKILL, 'README.md': '# Readme' }));
    expect(result.ok).toBe(true);
  });

  // ── Diagnostic: license-file-missing ──

  it('frontmatter.license set but no LICENSE file → license-file-missing (warning, field="license")', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': skillWithLicense('MIT'), 'README.md': '# Readme' }),
    );
    expect(codes(result)).toContain('license-file-missing');
    const diag = result.diagnostics.find((d) => d.code === 'license-file-missing');
    expect(diag?.severity).toBe('warning');
    expect(diag?.field).toBe('license');
  });

  it('license-file-missing: license.declared is still set, spdx still from allowlist', async () => {
    // Even without a file, tier 1 classification runs on the declared value.
    const result = await analyze(
      mem({ 'SKILL.md': skillWithLicense('MIT'), 'README.md': '# Readme' }),
    );
    expect(result.license.declared).toBe('MIT');
    expect(result.license.spdx).toBe('MIT');
    expect(result.license.source).toBe('frontmatter');
    expect(result.license.file).toBeNull();
  });

  it('license-file-missing: ok stays true (warning, not error)', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': skillWithLicense('MIT'), 'README.md': '# Readme' }),
    );
    expect(result.ok).toBe(true);
  });

  it('license-missing NOT emitted when frontmatter.license is set (even without file)', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': skillWithLicense('MIT'), 'README.md': '# Readme' }),
    );
    expect(codes(result)).not.toContain('license-missing');
  });

  // ── license.declared ──

  it('license.declared mirrors frontmatter.license raw value', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': skillWithLicense('Apache-2.0'),
        'README.md': '# Readme',
        LICENSE: sigText('Apache-2.0'),
      }),
    );
    expect(result.license.declared).toBe('Apache-2.0');
  });

  it('license.declared is null when no license frontmatter field', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': VALID_SKILL,
        'README.md': '# Readme',
        LICENSE: sigText('MIT'),
      }),
    );
    expect(result.license.declared).toBeNull();
  });

  // ── Schema validation ──

  it('output with full README + LICENSE passes SkillAnalysisSchema.parse()', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': VALID_SKILL,
        'README.md': '# My Skill\n\nDescription.',
        LICENSE: sigText('MIT'),
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('output with no README or LICENSE passes SkillAnalysisSchema.parse()', async () => {
    const result = await analyze(mem({ 'SKILL.md': VALID_SKILL }));
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  it('output with frontmatter.license but no file passes SkillAnalysisSchema.parse()', async () => {
    const result = await analyze(
      mem({ 'SKILL.md': skillWithLicense('MIT'), 'README.md': '# Readme' }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });
});
