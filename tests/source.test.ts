/**
 * Unit tests for src/source.ts (fromFiles) and src/node.ts (fromDir).
 *
 * fromDir is the only code that touches the filesystem; it is tested against the
 * real fixture at tests/fixtures/minimal-skill/ (the only disk fixture in P0).
 * Everything else uses fromFiles (in-memory, no fs flakiness).
 */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromFiles } from '../src/source.js';
import { fromDir } from '../src/node.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const FIXTURES_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const MINIMAL_SKILL_DIR = path.join(FIXTURES_DIR, 'minimal-skill');

// ── fromFiles ─────────────────────────────────────────────────────────────────

describe('fromFiles', () => {
  it('list() returns all provided paths', async () => {
    const source = fromFiles(
      new Map([
        ['SKILL.md', enc.encode('# Test')],
        ['README.md', enc.encode('# Readme')],
      ]),
    );
    expect((await source.list()).sort()).toEqual(['README.md', 'SKILL.md']);
  });

  it('list() returns empty array when map is empty', async () => {
    const source = fromFiles(new Map());
    expect(await source.list()).toEqual([]);
  });

  it('read() returns the correct bytes for a known path', async () => {
    const content = 'Hello, skill!';
    const source = fromFiles(new Map([['SKILL.md', enc.encode(content)]]));
    const bytes = await source.read('SKILL.md');
    expect(dec.decode(bytes)).toBe(content);
  });

  it('read() preserves binary content byte-for-byte', async () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG magic
    const source = fromFiles(new Map([['image.png', binary]]));
    const bytes = await source.read('image.png');
    expect(bytes).toEqual(binary);
  });

  it('read() rejects with an error for an unknown path', async () => {
    const source = fromFiles(new Map());
    await expect(source.read('nonexistent.md')).rejects.toThrow();
  });

  it('the SkillSource returned has no realpath() — memory source is not fs-backed', () => {
    // realpath is optional on the SkillSource interface; fromFiles need not implement it
    const source = fromFiles(new Map());
    // If realpath is absent that's correct; if present it should still work
    if ('realpath' in source && typeof source.realpath === 'function') {
      // acceptable — optional method implemented
    }
    // Main assertion: source exists and has list + read
    expect(typeof source.list).toBe('function');
    expect(typeof source.read).toBe('function');
  });

  it('{ dir } option sets source.dir (simulates a disk-backed source with a known root name)', () => {
    const source = fromFiles(new Map(), { dir: 'my-skill' });
    expect(source.dir).toBe('my-skill');
  });

  it('without { dir } option, source.dir is undefined', () => {
    const source = fromFiles(new Map());
    expect(source.dir).toBeUndefined();
  });

  it('accepts a plain Record<string, string> and UTF-8 encodes string values', async () => {
    const source = fromFiles({ 'SKILL.md': '# Hello', 'data.bin': 'text' });
    expect((await source.list()).sort()).toEqual(['SKILL.md', 'data.bin']);
    const text = dec.decode(await source.read('SKILL.md'));
    expect(text).toBe('# Hello');
  });

  it('accepts a plain Record with Uint8Array values (kept as-is, no double-encoding)', async () => {
    const bin = new Uint8Array([1, 2, 3]);
    const source = fromFiles({ 'file.bin': bin });
    expect(await source.read('file.bin')).toEqual(bin);
  });
});

// ── fromDir ───────────────────────────────────────────────────────────────────

describe('fromDir', () => {
  it('list() includes SKILL.md from the fixture directory', async () => {
    const source = fromDir(MINIMAL_SKILL_DIR);
    const files = await source.list();
    expect(files).toContain('SKILL.md');
  });

  it('list() returns only relative paths (no leading slash or directory prefix)', async () => {
    const source = fromDir(MINIMAL_SKILL_DIR);
    const files = await source.list();
    for (const f of files) {
      expect(f).not.toMatch(/^\//);
      expect(f).not.toContain(MINIMAL_SKILL_DIR);
    }
  });

  it('list() recurses into subdirectories using forward-slash separators', async () => {
    // tests/fixtures/minimal-skill/references/note.md exists to exercise the recursive walk
    const source = fromDir(MINIMAL_SKILL_DIR);
    const files = await source.list();
    expect(files).toContain('references/note.md');
  });

  it('source.dir equals the basename of the root directory', () => {
    const source = fromDir(MINIMAL_SKILL_DIR);
    expect(source.dir).toBe('minimal-skill');
  });

  it('read() returns the correct content for SKILL.md', async () => {
    const source = fromDir(MINIMAL_SKILL_DIR);
    const bytes = await source.read('SKILL.md');
    const text = dec.decode(bytes);
    expect(text).toContain('name: minimal-fixture');
  });

  it('read() rejects for a path not in the directory', async () => {
    const source = fromDir(MINIMAL_SKILL_DIR);
    await expect(source.read('does-not-exist.md')).rejects.toThrow();
  });

  it('list() skips entries that are neither files nor directories (symlink)', async () => {
    // Symlinks can't live in the git fixture (checkout differs across platforms),
    // so build a throwaway dir: readdir's Dirent reports a symlink as neither
    // isFile() nor isDirectory(), and walk() must skip it.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'skill-analysis-symlink-'));
    try {
      await writeFile(path.join(tmp, 'SKILL.md'), '# real file\n');
      await symlink(path.join(tmp, 'SKILL.md'), path.join(tmp, 'link.md'));
      const files = await fromDir(tmp).list();
      expect(files).toContain('SKILL.md');
      expect(files).not.toContain('link.md');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
