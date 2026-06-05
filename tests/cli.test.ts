/**
 * Unit tests for src/cli.ts — the `asa` command-line front end.
 *
 * runCli is tested end-to-end against the real disk fixture (it goes through
 * fromDir, the only fs path); the renderers are tested directly against
 * in-memory analyses built with mem() so every display branch is exercised
 * without disk fixtures.
 *
 * cli-entry.ts (process wiring) is coverage-excluded and not tested here.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { fromDir } from '../src/node.js';
import {
  errorMessage,
  formatBytes,
  renderAnalysis,
  renderDiagnostic,
  runCli,
  USAGE,
  type CliIO,
} from '../src/cli.js';
import { mem } from './helpers.js';
import pkg from '../package.json';

const FIXTURES_DIR = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const MINIMAL_SKILL_DIR = path.join(FIXTURES_DIR, 'minimal-skill');

/** Capture-everything CliIO for assertions. */
function makeIO(color = false): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line), color },
    out,
    err,
  };
}

// A complete skill exercising every optional display field: version, license,
// compatibility, allowed-tools, headings, a resolved ref, a broken ref, and an
// orphan file.
const RICH_FILES = {
  'SKILL.md': [
    '---',
    'name: rich-skill',
    'description: A skill with everything on display.',
    'license: MIT',
    'compatibility: claude-code',
    'allowed-tools: WebSearch Bash',
    'metadata:',
    '  version: "1.2.0"',
    '---',
    '',
    '# Rich Skill',
    '',
    '## Usage',
    '',
    'See [the note](references/note.md) and [missing](references/gone.md).',
    '',
  ].join('\n'),
  'references/note.md': '# Note\n',
  'assets/orphan.txt': 'unreferenced\n',
};

// A clean skill: zero diagnostics, ok, singular counts where possible.
const CLEAN_FILES = {
  'SKILL.md': [
    '---',
    'name: clean-skill',
    'description: A perfectly clean skill.',
    'license: MIT',
    'metadata:',
    '  version: "1.0.0"',
    '---',
    '',
    '# Clean Skill',
    '',
  ].join('\n'),
  'README.md': '# Clean Skill\n',
  // Without a LICENSE file, declaring frontmatter.license emits license-file-missing.
  LICENSE: 'MIT License\n\nCopyright (c) 2026 Eric Wu\n\nPermission is hereby granted...\n',
};

// ── runCli ────────────────────────────────────────────────────────────────────

describe('runCli', () => {
  it('--json prints the exact SkillAnalysis JSON (2-space indent) and exits 0', async () => {
    const { io, out, err } = makeIO();
    const code = await runCli([MINIMAL_SKILL_DIR, '--json'], io);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const expected = await analyze(fromDir(MINIMAL_SKILL_DIR));
    expect(out.join('\n')).toBe(JSON.stringify(expected, null, 2));
  });

  it('default (pretty) output shows the skill name and exits 0 for an ok skill', async () => {
    const { io, out, err } = makeIO();
    const code = await runCli([MINIMAL_SKILL_DIR], io);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain('minimal-fixture');
    expect(text).toContain('dir');
    expect(text).toContain('minimal-skill');
    expect(text).toContain('✓ ok');
    expect(text).toContain('references/note.md (orphan)');
  });

  it('--help / -h print usage and exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const { io, out } = makeIO();
      expect(await runCli([flag], io)).toBe(0);
      expect(out).toEqual([USAGE]);
    }
  });

  it('usage footer carries the package version and repo link from package.json', () => {
    // Derived from package.json (the source of truth), never hardcoded copies —
    // a version bump or repo move must not be able to leave USAGE stale.
    const footer = USAGE.split('\n').at(-1);
    expect(footer).toBe(`${pkg.name} v${pkg.version} — ${pkg.homepage.replace(/#readme$/, '')}`);
    expect(footer).toContain('https://github.com/tanker327/agent-skill-analysis');
  });

  it('unknown option → usage on stderr, exit 2', async () => {
    const { io, out, err } = makeIO();
    expect(await runCli(['--nope'], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err[0]).toBe("asa: unknown option '--nope'");
    expect(err[1]).toBe(USAGE);
  });

  it('more than one folder path → usage on stderr, exit 2', async () => {
    const { io, err } = makeIO();
    expect(await runCli(['a', 'b'], io)).toBe(2);
    expect(err[0]).toBe('asa: expected at most one folder path');
  });

  it('nonexistent folder → IO error on stderr, exit 2', async () => {
    const { io, out, err } = makeIO();
    expect(await runCli([path.join(FIXTURES_DIR, 'does-not-exist')], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^asa: /);
  });

  it('no folder argument → usage on stderr, exit 2 (even with --json)', async () => {
    for (const argv of [[], ['--json']]) {
      const { io, out, err } = makeIO();
      expect(await runCli(argv, io)).toBe(2);
      expect(out).toEqual([]);
      expect(err[0]).toBe('asa: missing folder path');
      expect(err[1]).toBe(USAGE);
    }
  });

  it('a folder without SKILL.md analyzes (never throws) and exits 1', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'asa-empty-'));
    try {
      const { io, out } = makeIO();
      expect(await runCli([tmp], io)).toBe(1);
      expect(out.join('\n')).toContain('SKILL.md missing');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── renderAnalysis ────────────────────────────────────────────────────────────

describe('renderAnalysis', () => {
  it('rich skill: every optional field renders (no color)', async () => {
    const a = await analyze(mem(RICH_FILES));
    const text = renderAnalysis(a, false);
    expect(text).toContain('rich-skill v1.2.0');
    expect(text).toContain('A skill with everything on display.');
    expect(text).toContain('MIT (frontmatter)');
    expect(text).toContain('compatibility');
    expect(text).toContain('claude-code');
    expect(text).toContain('allowed tools');
    expect(text).toContain('WebSearch, Bash');
    expect(text).toContain(a.digest);
    // Heading outline with depth indentation.
    expect(text).toContain('# Rich Skill');
    expect(text).toContain('  ## Usage');
    // Reference problem lists.
    expect(text).toContain('✗ references/gone.md (broken)');
    expect(text).toContain('• assets/orphan.txt (orphan)');
    // Memory source → no dir row.
    expect(text).not.toMatch(/^dir/m);
    // broken-ref / orphan-file / readme-missing etc. are warnings → still ok.
    expect(text).toContain('✓ ok');
    expect(text).toMatch(/⚠ \d+ warnings/);
    // No ANSI escapes when color is off.
    expect(text).not.toContain('[');
  });

  it('rich skill: color mode emits ANSI escapes', async () => {
    const a = await analyze(mem(RICH_FILES));
    const text = renderAnalysis(a, true);
    expect(text).toContain('[1m');
    expect(text).toContain('[0m');
  });

  it('clean skill: ok status, "Diagnostics  none", singular file count', async () => {
    const a = await analyze(mem(CLEAN_FILES));
    expect(a.diagnostics).toEqual([]);
    const text = renderAnalysis(a, false);
    expect(text).toContain('✓ ok');
    expect(text).not.toContain('⚠');
    expect(text).toContain('Diagnostics  none');
    expect(text).toContain('1 heading');
    expect(text).not.toContain('1 headings');
  });

  it('empty tree: unnamed skill, missing body, em-dash license, errors', async () => {
    const a = await analyze(mem({}));
    const text = renderAnalysis(a, false);
    expect(text).toContain('(unnamed skill)');
    expect(text).toContain('SKILL.md missing — no body to analyze');
    expect(text).toContain('license');
    expect(text).toContain('—');
    expect(text).toContain('0 files');
    expect(text).toMatch(/✗ \d+ error/);
  });

  it('declared-but-unrecognized license falls back to the declared text', async () => {
    // No LICENSE file — otherwise its recognized SPDX id would win over the
    // unrecognized declared text.
    const files = {
      'SKILL.md': CLEAN_FILES['SKILL.md'].replace('license: MIT', 'license: My Custom License'),
      'README.md': '# Clean Skill\n',
    };
    const a = await analyze(mem(files));
    expect(renderAnalysis(a, false)).toContain('My Custom License');
  });
});

// ── renderDiagnostic ──────────────────────────────────────────────────────────

describe('renderDiagnostic', () => {
  it('error with field and hint renders all segments', () => {
    const line = renderDiagnostic(
      {
        code: 'broken-reference',
        severity: 'error',
        field: 'references/gone.md',
        message: 'Referenced file does not exist.',
        hint: 'Fix the path.',
      },
      false,
    );
    expect(line).toContain('✗ error');
    expect(line).toContain('broken-reference');
    expect(line).toContain('[references/gone.md]');
    expect(line).toContain('Referenced file does not exist.');
    expect(line).toContain('hint: Fix the path.');
  });

  it('warning without field or hint renders only mark, code, and message', () => {
    const line = renderDiagnostic(
      { code: 'readme-missing', severity: 'warning', message: 'No README found.' },
      false,
    );
    expect(line).toBe('⚠ warning readme-missing — No README found.');
  });
});

// ── formatBytes / errorMessage ────────────────────────────────────────────────

describe('formatBytes', () => {
  it('formats bytes, KB, and MB with at most one decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});

describe('errorMessage', () => {
  it('unwraps Error instances and stringifies everything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain string')).toBe('plain string');
  });
});
