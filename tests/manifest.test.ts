/**
 * Integration tests for P4 manifest pipeline (stage ⑨).
 *
 * Stage ⑨ (flow §2): for each file in the skill tree, produce:
 *   • sha256 — true byte hash (64-char lowercase hex), never the digest-variant
 *   • size   — byte length
 *   • kind   — classification by path convention:
 *                SKILL.md → instructions
 *                README basenames → readme
 *                LICENSE basenames (LICENSE/LICENSE.txt/LICENSE.md/COPYING) → license
 *                references/* → reference
 *                scripts/*   → script
 *                assets/*    → asset
 *                everything else → other
 *   • isText — true when UTF-8 decode succeeds; false for binary (R5/F5)
 *
 * Plus size aggregate: size.total + size.byKind (only kinds with ≥1 file appear).
 * F4: options.maxFileBytes — files strictly larger than this limit are SKIPPED from
 *     files[] and emit file-too-large (warning); never silent.
 *
 * Binary files: in files[] with isText=false, sha256 present, but absent from every
 * text field in the output (body, readme). (flow §4, F5)
 *
 * NOTE: Pure unit tests for the kind-classification helper and per-file hashing
 * will be added in a follow-up once src/manifest.ts exports those pure helpers.
 * Until then, all coverage goes through analyze() integration tests.
 *
 * All tests prefer fromFiles() in-memory source to avoid fs flakiness; the
 * fromDir binary-skill fixture is used only for the on-disk binary-detection test.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, fromFiles, SkillAnalysisSchema } from '../src/index.js';
import { fromDir } from '../src/node.js';
import { mem } from './helpers.js';

// ── Test data ─────────────────────────────────────────────────────────────────

/** PNG magic bytes — not valid UTF-8 → isText must be false. */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal valid SKILL.md frontmatter prefix used by fixtures that only need a parseable file. */
const FM =
  '---\nname: test-skill\ndescription: A test skill.\nmetadata:\n  version: "1.0.0"\n---\n\n';

// ── Binary file ───────────────────────────────────────────────────────────────

describe('manifest — binary file', () => {
  it('binary file appears in files[] with isText=false', async () => {
    const source = fromFiles({
      'SKILL.md': FM + 'Body text.',
      'README.md': '# Test',
      LICENSE: 'MIT License\n\nCopyright (c) 2026 test',
      'assets/icon.png': PNG_MAGIC,
    });
    const result = await analyze(source);
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    const entry = result.files.find((f) => f.path === 'assets/icon.png');
    expect(entry).toBeDefined();
    expect(entry?.isText).toBe(false);
    expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.size).toBe(PNG_MAGIC.byteLength);
    expect(entry?.kind).toBe('asset');
  });

  it('binary sha256 is the true byte hash — 64 lowercase hex chars', async () => {
    const source = fromFiles({
      'SKILL.md': FM + 'Body.',
      'README.md': '# Test',
      LICENSE: 'MIT License',
      'assets/data.bin': PNG_MAGIC,
    });
    const result = await analyze(source);
    const entry = result.files.find((f) => f.path === 'assets/data.bin');
    // Exact length and charset (schema regex: /^[0-9a-f]{64}$/)
    expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binary file does NOT appear in any text field (body, readme)', async () => {
    const source = fromFiles({
      'SKILL.md': FM + 'Body text about the skill.',
      'README.md': '# Test Skill',
      LICENSE: 'MIT License\n\nCopyright',
      'assets/icon.png': PNG_MAGIC,
    });
    const result = await analyze(source);
    const iconEntry = result.files.find((f) => f.path === 'assets/icon.png');
    // The file is binary → isText=false
    expect(iconEntry?.isText).toBe(false);
    // Body text must not include raw binary interpretation
    if (result.body !== null) {
      expect(result.body.text).not.toContain('assets/icon.png\x89');
    }
    // README text must not contain the binary bytes (PNG magic decoded as mojibake)
    if (result.readme !== null) {
      expect(result.readme.text).not.toContain('\x89');
    }
    // (license carries no text field — the output never copies license bytes)
  });

  it('text files have isText=true', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# Readme',
        LICENSE: 'MIT License',
        'references/guide.md': '# Guide',
        'scripts/run.py': 'print("hello")',
      }),
    );
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    for (const f of result.files) {
      expect(f.isText, `expected isText=true for ${f.path}`).toBe(true);
    }
  });
});

// ── Kind classification ───────────────────────────────────────────────────────

describe('manifest — kind classification', () => {
  /**
   * Table-driven test covering all 7 FileKind values in a single skill tree.
   * Expected kinds (from output contract §3.5):
   *   SKILL.md            → instructions  (special case)
   *   README.md           → readme        (README basename)
   *   LICENSE             → license       (LICENSE basename)
   *   references/*.md     → reference     (prefix rule)
   *   scripts/*.py        → script        (prefix rule)
   *   assets/*            → asset         (prefix rule)
   *   agents/*.md         → other         (no matching rule)
   */
  it('classifies all 7 kinds correctly', async () => {
    const source = fromFiles({
      'SKILL.md': FM + 'Body.',
      'README.md': '# Readme',
      LICENSE: 'MIT License',
      'references/guide.md': '# Guide',
      'scripts/run.py': 'print("hello")',
      'assets/logo.png': PNG_MAGIC,
      'agents/reviewer.md': '# Reviewer', // custom dir → other
    });
    const result = await analyze(source);
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();

    function kindOf(p: string): string {
      const e = result.files.find((f) => f.path === p);
      if (e === undefined) throw new Error(`file not in manifest: ${p}`);
      return e.kind;
    }

    expect(kindOf('SKILL.md')).toBe('instructions');
    expect(kindOf('README.md')).toBe('readme');
    expect(kindOf('LICENSE')).toBe('license');
    expect(kindOf('references/guide.md')).toBe('reference');
    expect(kindOf('scripts/run.py')).toBe('script');
    expect(kindOf('assets/logo.png')).toBe('asset');
    expect(kindOf('agents/reviewer.md')).toBe('other');
  });

  it('COPYING is classified as kind=license', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# R',
        COPYING: 'GNU GPL v3',
      }),
    );
    const entry = result.files.find((f) => f.path === 'COPYING');
    expect(entry?.kind).toBe('license');
  });

  it('LICENSE.md is classified as kind=license', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# R',
        'LICENSE.md': '## License\n\nMIT.',
      }),
    );
    const entry = result.files.find((f) => f.path === 'LICENSE.md');
    expect(entry?.kind).toBe('license');
  });

  it('plain README (no extension) is classified as kind=readme', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        README: '# Readme without extension',
        LICENSE: 'MIT',
      }),
    );
    const entry = result.files.find((f) => f.path === 'README');
    expect(entry?.kind).toBe('readme');
  });

  it('deeply nested references/ path is still kind=reference', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'references/deep/nested/doc.md': '# Deep doc',
      }),
    );
    const entry = result.files.find((f) => f.path === 'references/deep/nested/doc.md');
    expect(entry?.kind).toBe('reference');
  });

  it('deeply nested assets/ path is still kind=asset', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'assets/img/small/icon.png': 'fake-png-bytes',
      }),
    );
    const entry = result.files.find((f) => f.path === 'assets/img/small/icon.png');
    expect(entry?.kind).toBe('asset');
  });

  it('deeply nested scripts/ path is still kind=script', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'scripts/utils/helpers.py': 'def helper(): pass',
      }),
    );
    const entry = result.files.find((f) => f.path === 'scripts/utils/helpers.py');
    expect(entry?.kind).toBe('script');
  });
});

// ── Files array ordering ──────────────────────────────────────────────────────

describe('manifest — files sorted ascending by path', () => {
  it('files[] is sorted by path regardless of source.list() order', async () => {
    // Provide files in deliberately non-alphabetical order
    const source = fromFiles({
      'scripts/run.py': 'print("hi")',
      'SKILL.md': FM + 'Body.',
      'README.md': '# R',
      'references/guide.md': '# G',
      'assets/logo.png': 'fake',
    });
    const result = await analyze(source);
    const paths = result.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });

  it('files[] sorted order is consistent with sort-reversed source', async () => {
    const files = {
      'SKILL.md': FM + 'Body.',
      'README.md': '# R',
      'references/a.md': '# A',
      'references/b.md': '# B',
      'scripts/run.py': 'pass',
    };
    const enc = new TextEncoder();
    const fwd = fromFiles(new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)])));
    const rev = fromFiles(
      new Map(
        Object.entries(files)
          .reverse()
          .map(([k, v]) => [k, enc.encode(v)]),
      ),
    );
    const [r1, r2] = await Promise.all([analyze(fwd), analyze(rev)]);
    expect(r1.files.map((f) => f.path)).toEqual(r2.files.map((f) => f.path));
  });
});

// ── SHA-256 ───────────────────────────────────────────────────────────────────

describe('manifest — sha256', () => {
  it('every file entry has a 64-char lowercase hex sha256', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# R',
        LICENSE: 'MIT',
        'references/guide.md': '# Guide',
      }),
    );
    for (const f of result.files) {
      expect(f.sha256, `sha256 format for ${f.path}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('same content → same sha256 (deterministic hashing)', async () => {
    const content = '# Identical content';
    const source = fromFiles({
      'SKILL.md': FM + 'Body.',
      'README.md': '# R',
      'references/a.md': content,
      'references/b.md': content, // identical content, different path
    });
    const result = await analyze(source);
    const aEntry = result.files.find((f) => f.path === 'references/a.md');
    const bEntry = result.files.find((f) => f.path === 'references/b.md');
    // Same content → same hash
    expect(aEntry?.sha256).toBe(bEntry?.sha256);
  });

  it('different content → different sha256', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# R',
        'references/a.md': '# Content A',
        'references/b.md': '# Content B different',
      }),
    );
    const aEntry = result.files.find((f) => f.path === 'references/a.md');
    const bEntry = result.files.find((f) => f.path === 'references/b.md');
    expect(aEntry?.sha256).not.toBe(bEntry?.sha256);
  });
});

// ── Size totals ───────────────────────────────────────────────────────────────

describe('manifest — size.total and size.byKind', () => {
  it('size.total equals the sum of all file byte lengths', async () => {
    const skillContent = FM + 'Body.';
    const readmeContent = '# Readme';
    const referenceContent = '# Guide\n\nContent.';
    const files = {
      'SKILL.md': skillContent,
      'README.md': readmeContent,
      'references/guide.md': referenceContent,
    };
    const result = await analyze(mem(files));
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    const enc = new TextEncoder();
    const expectedTotal =
      enc.encode(skillContent).byteLength +
      enc.encode(readmeContent).byteLength +
      enc.encode(referenceContent).byteLength;
    expect(result.size.total).toBe(expectedTotal);
  });

  it('size.byKind sums match per-kind file sizes', async () => {
    const enc = new TextEncoder();
    const skillContent = FM + 'Body.';
    const refContent = '# Guide';
    const result = await analyze(
      mem({
        'SKILL.md': skillContent,
        'README.md': '# Readme',
        'references/guide.md': refContent,
      }),
    );
    expect(result.size.byKind['instructions']).toBe(enc.encode(skillContent).byteLength);
    expect(result.size.byKind['reference']).toBe(enc.encode(refContent).byteLength);
  });

  it('size.byKind sum equals size.total', async () => {
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# Readme',
        'references/guide.md': '# Guide',
        'scripts/run.py': 'print("hi")',
      }),
    );
    const byKindSum = Object.values(result.size.byKind).reduce((a, b) => a + b, 0);
    expect(result.size.total).toBe(byKindSum);
  });

  it('size.byKind only includes kinds that have ≥1 file', async () => {
    // No scripts, assets, license, or other-kind files in this tree
    const result = await analyze(
      mem({
        'SKILL.md': FM + 'Body.',
        'README.md': '# Readme',
        'references/guide.md': '# Guide',
      }),
    );
    expect(result.size.byKind['script']).toBeUndefined();
    expect(result.size.byKind['asset']).toBeUndefined();
    expect(result.size.byKind['license']).toBeUndefined();
    expect(result.size.byKind['other']).toBeUndefined();
    // instructions, readme, reference should be present
    expect(result.size.byKind['instructions']).toBeDefined();
    expect(result.size.byKind['readme']).toBeDefined();
    expect(result.size.byKind['reference']).toBeDefined();
  });

  it('size.total and byKind include all files including SKILL.md', async () => {
    // Confirm SKILL.md is counted in size.total (kind=instructions)
    const enc = new TextEncoder();
    const skillContent = FM + 'Only file.';
    // No README or LICENSE → only SKILL.md in files (diagnostics for missing docs)
    const result = await analyze(
      mem({
        'SKILL.md': skillContent,
      }),
    );
    expect(result.size.total).toBe(enc.encode(skillContent).byteLength);
    expect(result.size.byKind['instructions']).toBe(enc.encode(skillContent).byteLength);
  });
});

// ── maxFileBytes (F4) ─────────────────────────────────────────────────────────

describe('manifest — maxFileBytes (F4: never-silent over-limit skip)', () => {
  it('file strictly larger than maxFileBytes is absent from files[] and emits file-too-large', async () => {
    const source = fromFiles({
      'SKILL.md': FM + 'Body.',
      'README.md': '# R',
      LICENSE: 'MIT',
      'references/large.md': 'x'.repeat(20), // 20 bytes > 10 limit
    });
    const result = await analyze(source, { maxFileBytes: 10 });
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    // File is ABSENT from manifest (skipped, not hashed)
    const entry = result.files.find((f) => f.path === 'references/large.md');
    expect(entry).toBeUndefined();
    // Diagnostic MUST be emitted — F4 never-silent rule
    const diag = result.diagnostics.find((d) => d.code === 'file-too-large');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warning');
  });

  it('file exactly at maxFileBytes is NOT skipped', async () => {
    // SKILL.md (FM + 'Body.') is ~88 bytes — use maxFileBytes well above that so
    // only the target file is near the boundary.
    const content = 'x'.repeat(200); // exactly 200 bytes
    const source = fromFiles({
      'SKILL.md': FM + 'Body.',
      'README.md': '# R',
      'references/exact.md': content, // exactly 200 bytes, limit = 200
    });
    const result = await analyze(source, { maxFileBytes: 200 });
    // At the boundary = not over the limit = NOT skipped
    const entry = result.files.find((f) => f.path === 'references/exact.md');
    expect(entry).toBeDefined();
    // No file-too-large diagnostic (nothing exceeds 200 bytes)
    expect(result.diagnostics.find((d) => d.code === 'file-too-large')).toBeUndefined();
  });

  it('file-too-large diagnostic is emitted for binary files too', async () => {
    const bigBin = new Uint8Array(100); // 100 bytes > 50 limit
    const source = fromFiles({
      'SKILL.md': FM + 'Body.',
      'README.md': '# R',
      'assets/big.bin': bigBin,
    });
    const result = await analyze(source, { maxFileBytes: 50 });
    const diagCodes = result.diagnostics.map((d) => d.code);
    expect(diagCodes).toContain('file-too-large');
    // Binary file must also be absent from files[]
    expect(result.files.find((f) => f.path === 'assets/big.bin')).toBeUndefined();
  });

  it('files below maxFileBytes are still included when some files exceed it', async () => {
    // Use maxFileBytes = 200: SKILL.md (~88 bytes) and small.md (2 bytes) fit;
    // only references/large.md (201 bytes) is over the limit → exactly 1 diagnostic.
    const source = fromFiles({
      'SKILL.md': FM + 'Body.',
      'README.md': '# R',
      'references/small.md': 'hi', // 2 bytes < 200
      'references/large.md': 'x'.repeat(201), // 201 bytes > 200
    });
    const result = await analyze(source, { maxFileBytes: 200 });
    // Small file remains in manifest
    expect(result.files.find((f) => f.path === 'references/small.md')).toBeDefined();
    // Large file is absent
    expect(result.files.find((f) => f.path === 'references/large.md')).toBeUndefined();
    // Exactly one file-too-large diagnostic (only references/large.md)
    const diagsFL = result.diagnostics.filter((d) => d.code === 'file-too-large');
    expect(diagsFL).toHaveLength(1);
  });
});

// ── fromDir binary-skill disk fixture ─────────────────────────────────────────
// Verifies binary-detection works against a real on-disk binary PNG file.
// Fixture: tests/fixtures/binary-skill/ — SKILL.md + assets/icon.png (8 PNG magic bytes).

const FIXTURES_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const BINARY_SKILL_DIR = path.join(FIXTURES_DIR, 'binary-skill');

describe('manifest — fromDir disk fixture (binary file on disk)', () => {
  it('binary-skill: assets/icon.png is isText=false with valid sha256', async () => {
    const source = fromDir(BINARY_SKILL_DIR);
    const result = await analyze(source);
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
    const bin = result.files.find((f) => f.path === 'assets/icon.png');
    expect(bin).toBeDefined();
    expect(bin?.isText).toBe(false);
    expect(bin?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bin?.size).toBe(8); // PNG magic is 8 bytes
    expect(bin?.kind).toBe('asset');
  });

  it('binary-skill: SKILL.md is isText=true with kind=instructions', async () => {
    const source = fromDir(BINARY_SKILL_DIR);
    const result = await analyze(source);
    const skill = result.files.find((f) => f.path === 'SKILL.md');
    expect(skill?.isText).toBe(true);
    expect(skill?.kind).toBe('instructions');
  });
});
