/**
 * `asa` — the command-line front end.
 *
 * Everything in this module is exported and unit-tested (per-file 100%
 * coverage); the process wiring (argv, stdout, exit code) lives in
 * cli-entry.ts, which contains no logic.
 *
 * Display rules:
 *   • `--json` prints exactly `JSON.stringify(analysis, null, 2)` — the
 *     pretty renderer is presentation only and never touches the contract.
 *   • No locale-dependent formatting — the determinism conventions apply to
 *     the pretty view too (byte sizes are computed, not toLocaleString'd).
 *   • ANSI colors are opt-in via `CliIO.color`; the entry enables them only
 *     for a TTY without NO_COLOR.
 *
 * Exit codes: 0 = analyzed and ok, 1 = analyzed but not ok (error-severity
 * diagnostics remain), 2 = usage or IO error (nothing analyzed).
 */
import { analyze } from './analyze.js';
import { fromDir } from './node.js';
import type { Diagnostic, SkillAnalysis } from './schema.js';
// Inlined by tsup at build time — the version/link footer can never drift
// from package.json, and the runtime bundle does no fs lookup for it.
import pkg from '../package.json';

// ── IO boundary ─────────────────────────────────────────────────────────────

/** Everything `runCli` needs from the process — injectable for tests. */
export interface CliIO {
  /** Write one line to stdout. */
  stdout(line: string): void;
  /** Write one line to stderr. */
  stderr(line: string): void;
  /** Enable ANSI colors in the pretty renderer. */
  color: boolean;
}

/** Repository link for the usage footer — the homepage minus its #readme anchor. */
const REPO_URL = pkg.homepage.replace(/#readme$/, '');

export const USAGE = [
  'asa — analyze an AI-agent skill folder (a SKILL.md plus resources)',
  '',
  'Usage',
  '  asa <folder> [--json]',
  '',
  'Arguments',
  '  folder      path to the skill folder (e.g. "." for the current directory)',
  '',
  'Options',
  '  --json      print the raw SkillAnalysis JSON instead of the pretty view',
  '  -h, --help  show this help',
  '',
  'Examples',
  '  asa ./my-skill          pretty report: status, summary, files, diagnostics',
  '  asa ./my-skill --json   the raw SkillAnalysis JSON (the full contract)',
  '',
  'Exit codes',
  '  0  analyzed and ok',
  '  1  analyzed, error-severity diagnostics remain',
  '  2  usage or IO error (nothing analyzed)',
  '',
  `${pkg.name} v${pkg.version} — ${REPO_URL}`,
].join('\n');

// ── ANSI helpers ────────────────────────────────────────────────────────────

type Style = 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'cyan';

const ANSI: Record<Style, string> = {
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  cyan: '36',
};

function paint(text: string, style: Style, color: boolean): string {
  return color ? `\u001b[${ANSI[style]}m${text}\u001b[0m` : text;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** "512 B" / "1.5 KB" / "2 MB" — Math.round, never toFixed/toLocaleString. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${String(Math.round(kb * 10) / 10)} KB`;
  return `${String(Math.round((kb / 1024) * 10) / 10)} MB`;
}

/** Message of an unknown thrown value (SkillSource IO is the only thrower). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

// ── Pretty renderer ─────────────────────────────────────────────────────────

/** One diagnostic as a display line (exported for direct branch testing). */
export function renderDiagnostic(d: Diagnostic, color: boolean): string {
  const mark =
    d.severity === 'error' ? paint('✗ error  ', 'red', color) : paint('⚠ warning', 'yellow', color);
  const field = d.field === undefined ? '' : ` ${paint(`[${d.field}]`, 'cyan', color)}`;
  const hint = d.hint === undefined ? '' : `\n        ${paint(`hint: ${d.hint}`, 'dim', color)}`;
  return `${mark} ${d.code}${field} — ${d.message}${hint}`;
}

/** The full pretty view of a SkillAnalysis, as one multi-line string. */
export function renderAnalysis(a: SkillAnalysis, color: boolean): string {
  const lines: string[] = [];

  // Header: name, version, description.
  const name = a.frontmatter.name ?? '(unnamed skill)';
  const title = a.frontmatter.version === null ? name : `${name} v${a.frontmatter.version}`;
  lines.push(paint(title, 'bold', color));
  if (a.frontmatter.description !== null) {
    lines.push(paint(a.frontmatter.description, 'dim', color));
  }
  lines.push('');

  // Status: ok / error count, plus warning count when present.
  const errors = a.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = a.diagnostics.length - errors;
  const status = a.ok
    ? paint('✓ ok', 'green', color)
    : paint(`✗ ${errors} error${plural(errors)}`, 'red', color);
  const warnSuffix =
    warnings === 0
      ? ''
      : `   ${paint(`⚠ ${warnings} warning${plural(warnings)}`, 'yellow', color)}`;
  lines.push(`${status}${warnSuffix}`);
  lines.push('');

  // Summary key/value block (aligned keys).
  const kv: [string, string][] = [];
  if (a.dir !== null) kv.push(['dir', a.dir]);
  const license =
    a.license.spdx === null
      ? (a.license.declared ?? '—')
      : `${a.license.spdx} (${String(a.license.source)})`;
  kv.push(['license', license]);
  if (a.frontmatter.compatibility !== null) kv.push(['compatibility', a.frontmatter.compatibility]);
  if (a.frontmatter.allowedTools !== null) {
    kv.push(['allowed tools', a.frontmatter.allowedTools.join(', ')]);
  }
  kv.push([
    'tokens',
    `${a.tokens.total} (metadata ${a.tokens.metadata} + body ${a.tokens.body}, ${a.tokens.tokenizer})`,
  ]);
  kv.push(['digest', a.digest]);
  const keyWidth = Math.max(...kv.map(([k]) => k.length));
  for (const [k, v] of kv) {
    lines.push(`${paint(k.padEnd(keyWidth), 'cyan', color)}  ${v}`);
  }
  lines.push('');

  // Body: line count + heading outline (or a missing-SKILL.md notice).
  if (a.body === null) {
    lines.push(paint('SKILL.md missing — no body to analyze', 'red', color));
  } else {
    lines.push(
      `${paint('Body', 'bold', color)}  ${a.body.lines} line${plural(a.body.lines)}, ` +
        `${a.body.headings.length} heading${plural(a.body.headings.length)}`,
    );
    for (const h of a.body.headings) {
      lines.push(
        `  ${'  '.repeat(h.depth - 1)}${paint('#'.repeat(h.depth), 'dim', color)} ${h.text}`,
      );
    }
  }
  lines.push('');

  // Files: per-file rows with size and kind.
  lines.push(
    `${paint('Files', 'bold', color)}  ${a.files.length} file${plural(a.files.length)}, ` +
      formatBytes(a.size.total),
  );
  const pathWidth = Math.max(0, ...a.files.map((f) => f.path.length));
  for (const f of a.files) {
    lines.push(
      `  ${f.path.padEnd(pathWidth)}  ${formatBytes(f.size).padStart(8)}  ${paint(f.kind, 'dim', color)}`,
    );
  }
  lines.push('');

  // References: counts plus the problem lists (broken, orphans).
  const r = a.references;
  lines.push(
    `${paint('References', 'bold', color)}  ${r.resolved.length} resolved, ` +
      `${r.broken.length} broken, ${r.orphans.length} orphan${plural(r.orphans.length)}`,
  );
  for (const p of r.broken)
    lines.push(`  ${paint('✗', 'red', color)} ${p} ${paint('(broken)', 'red', color)}`);
  for (const p of r.orphans)
    lines.push(`  ${paint('•', 'yellow', color)} ${p} ${paint('(orphan)', 'dim', color)}`);
  lines.push('');

  // Diagnostics.
  if (a.diagnostics.length === 0) {
    lines.push(`${paint('Diagnostics', 'bold', color)}  none`);
  } else {
    lines.push(`${paint('Diagnostics', 'bold', color)}  ${a.diagnostics.length}`);
    for (const d of a.diagnostics) lines.push(`  ${renderDiagnostic(d, color)}`);
  }

  return lines.join('\n');
}

// ── Entry ───────────────────────────────────────────────────────────────────

/**
 * Parse argv, analyze the folder, print, and return the exit code.
 * Never throws — IO/usage failures become stderr lines and exit code 2.
 */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let json = false;
  const paths: string[] = [];
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '-h' || arg === '--help') {
      io.stdout(USAGE);
      return 0;
    } else if (arg.startsWith('-')) {
      io.stderr(`asa: unknown option '${arg}'`);
      io.stderr(USAGE);
      return 2;
    } else {
      paths.push(arg);
    }
  }
  if (paths.length > 1) {
    io.stderr('asa: expected at most one folder path');
    io.stderr(USAGE);
    return 2;
  }
  // The folder is required: a bare `asa` shows usage instead of silently
  // analyzing the current directory (use `asa .` for that explicitly).
  const folder = paths[0];
  if (folder === undefined) {
    io.stderr('asa: missing folder path');
    io.stderr(USAGE);
    return 2;
  }

  let analysis: SkillAnalysis;
  try {
    analysis = await analyze(fromDir(folder));
  } catch (err) {
    io.stderr(`asa: ${errorMessage(err)}`);
    return 2;
  }

  io.stdout(json ? JSON.stringify(analysis, null, 2) : renderAnalysis(analysis, io.color));
  return analysis.ok ? 0 : 1;
}
