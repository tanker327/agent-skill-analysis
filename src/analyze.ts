/**
 * Pipeline orchestration. P0 skeleton: stage ① (enumerate + ignore set) is
 * real; every other field is a legal empty value so the output is
 * schema-valid and byte-deterministic from day one. Stages ②–⑩ light up in
 * P1–P5; finalize policy lands in P6.
 */
import { analyzeBody } from './body.js';
import { compareDiagnostics, DiagnosticCollector } from './diagnostics.js';
import { detectLicense, detectReadme } from './docs.js';
import { parseFrontmatterFromText } from './frontmatter.js';
import {
  ANALYZER_VERSION,
  AnalyzeOptionsSchema,
  SCHEMA_VERSION,
  SPEC_VERSION,
  type AnalyzeOptions,
  type Diagnostic,
  type Frontmatter,
  type SkillAnalysis,
} from './schema.js';
import type { SkillSource } from './source.js';
import { DEFAULT_TOKENIZER } from './tokenizer.js';

/**
 * Default ignore set (F1), conservative by design. A path is ignored when any
 * of its segments matches an entry. `options.ignore` REPLACES this set —
 * spread DEFAULT_IGNORE to extend it. Note: the digest varies with the
 * ignore configuration; cross-party comparison requires the same config.
 */
export const DEFAULT_IGNORE: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
];

/** sha256("") — placeholder until the real digest lands in P5 (plan §5 R1). */
const EMPTY_DIGEST = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function isIgnored(path: string, ignore: readonly string[]): boolean {
  return path.split('/').some((segment) => ignore.includes(segment));
}

/**
 * Analyze one skill folder into a single deterministic SkillAnalysis JSON.
 *
 * Never rejects on skill content — broken content becomes diagnostics. The
 * only rejections are SkillSource IO failures (R3) and invalid `options`.
 */
export async function analyze(
  source: SkillSource,
  options?: AnalyzeOptions,
): Promise<SkillAnalysis> {
  // The single production-path zod parse: validate consumer options at the door.
  const opts = AnalyzeOptionsSchema.parse(options ?? {});
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  // Resolve the tokenizer once — injected or default. All token counts use
  // the same instance so `tokens.tokenizer` matches the actual counts (R2).
  const tokenizer = opts.tokenizer ?? DEFAULT_TOKENIZER;

  // Stage ①: enumerate + ignore. Sorted immediately — source order is never trusted.
  const paths = (await source.list()).filter((p) => !isIgnored(p, ignore)).sort();

  const collector = new DiagnosticCollector();
  const dir = source.dir ?? null;

  // Stages ②–⑤: SKILL.md chain (P1).
  const EMPTY_FRONTMATTER: Frontmatter = {
    name: null,
    description: null,
    version: null,
    license: null,
    compatibility: null,
    allowedTools: null,
    metadata: null,
    extra: {},
  };

  let frontmatter: Frontmatter = EMPTY_FRONTMATTER;
  let bodyText: string | null = null;

  if (!paths.includes('SKILL.md')) {
    // Stage ②: SKILL.md absent — emit no-skill-md, skip ③④⑤ (flow §6 row 1).
    collector.emit('no-skill-md');
  } else {
    // Stage ②: read + UTF-8 decode (fatal:false → invalid bytes → replacement chars).
    const bytes = await source.read('SKILL.md');
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // Stages ③④⑤: split / normalize / validate.
    const parsed = parseFrontmatterFromText(text, dir, collector);
    frontmatter = parsed.frontmatter;
    bodyText = parsed.body;
  }

  // Stage ⑥: body analysis (P2). analyzeBody returns lines, headings, and the
  // pre-computed body token count so analyze.ts doesn't tokenize twice.
  let body: { text: string; lines: number; headings: { depth: number; text: string }[] } | null =
    null;
  let bodyTokens = 0;
  if (bodyText !== null) {
    const ba = analyzeBody(bodyText, collector, tokenizer);
    body = { text: bodyText, lines: ba.lines, headings: ba.headings };
    bodyTokens = ba.bodyTokens;
  }

  // tokens.metadata = tokenize(name + ' ' + description) where only non-null
  // values are joined. Deterministic contract: both null → '' → 0 tokens;
  // one null → just the non-null value; both present → 'name description'.
  // Single-space separator — compact and natural (R2, approved 2026-06-05).
  const metadataText = [frontmatter.name, frontmatter.description]
    .filter((v): v is string => v !== null)
    .join(' ');
  const metadataTokens = tokenizer.count(metadataText);

  // Stages ⑦–⑧: README + LICENSE/SPDX detection (P3).
  const readme = await detectReadme(paths, source, collector);
  const license = await detectLicense(paths, frontmatter, source, collector);

  // Policy resolution (superseded by finalize.ts in P6): translate raw
  // diagnostics to output Diagnostics, skipping 'off'-severity entries and
  // threading the optional `field` through.
  const diagnostics: Diagnostic[] = [];
  for (const raw of collector.all()) {
    // 'off' entries are suppressed by default; consumers may enable them via
    // options.rules in P6 finalize. The 'off' branch is required here because
    // name-reserved (registered P1) widens RegisteredDefaultSeverity to include
    // 'off', making the assignment to Diagnostic.severity ill-typed without it.
    if (raw.severity === 'off') continue;
    const diag: Diagnostic = { code: raw.code, severity: raw.severity, message: raw.message };
    if (raw.field !== undefined) diag.field = raw.field;
    if (raw.hint !== undefined) diag.hint = raw.hint;
    diagnostics.push(diag);
  }
  diagnostics.sort(compareDiagnostics);
  const ok = !diagnostics.some((d) => d.severity === 'error');

  return {
    schemaVersion: SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    specVersion: SPEC_VERSION,
    ok,
    dir,
    frontmatter,
    body,
    readme,
    license,
    files: [],
    tokens: {
      metadata: metadataTokens,
      body: bodyTokens,
      total: metadataTokens + bodyTokens,
      tokenizer: tokenizer.name,
    },
    references: { declared: [], resolved: [], broken: [], orphans: [] },
    size: { total: 0, byKind: {} },
    digest: EMPTY_DIGEST,
    diagnostics,
  };
}
