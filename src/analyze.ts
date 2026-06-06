/**
 * Pipeline orchestration. P0 skeleton: stage ① (enumerate + ignore set) is
 * real; every other field is a legal empty value so the output is
 * schema-valid and byte-deterministic from day one. Stages ②–⑩ light up in
 * P1–P5; finalize policy lands in P6.
 */
import { analyzeBody } from './body.js';
import { DiagnosticCollector } from './diagnostics.js';
import { finalizeDiagnostics } from './finalize.js';
import { computeDigest } from './digest.js';
import { detectLicense, detectReadme } from './docs.js';
import { parseFrontmatterFromText } from './frontmatter.js';
import { buildManifest } from './manifest.js';
import { analyzeReferences } from './references.js';
import {
  ANALYZER_VERSION,
  AnalyzeOptionsSchema,
  SCHEMA_VERSION,
  SPEC_VERSION,
  type AnalyzeOptions,
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
  // VCS
  '.git',
  '.hg',
  '.svn',
  // Dependency / build / tool caches
  'node_modules',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
  // F3: VCS/CI/editor/tooling artifacts that show up when a skill folder is a
  // whole repo root. All entries are dot-prefixed dirs/files or lockfiles, so
  // they cannot collide with a real-word skill resource name (segment match).
  '.github',
  '.gitlab',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.vscode',
  '.idea',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];

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
  // skillMdText is the raw decoded SKILL.md content — passed to computeDigest
  // so the digest stage can re-parse the YAML block fresh (R1 definition).
  let skillMdText: string | null = null;

  if (!paths.includes('SKILL.md')) {
    // Stage ②: SKILL.md absent — emit no-skill-md, skip ③④⑤ (flow §6 row 1).
    collector.emit('no-skill-md');
  } else {
    // Stage ②: read + UTF-8 decode (fatal:false → invalid bytes → replacement chars).
    const bytes = await source.read('SKILL.md');
    skillMdText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    // Stages ③④⑤: split / normalize / validate.
    const parsed = parseFrontmatterFromText(skillMdText, dir, collector);
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
  const readmePath = readme?.path ?? null;
  const licensePath = license.file;

  // Stage ⑨: per-file manifest — sha256, kind, isText, size (P4).
  const manifest = await buildManifest(
    paths,
    source,
    readmePath,
    licensePath,
    opts.maxFileBytes,
    collector,
  );

  // Stage ⑩: reference graph — declared/resolved/broken/orphans (P4).
  // Pass the full post-ignore path list (stage ①) so that over-limit files
  // (absent from manifest.files) still resolve correctly when linked from body.
  // fileTexts feeds the transitive orphan check: every in-manifest text file
  // (within size limit — over-limit/binary files never join the scan),
  // decoded here so the references stage stays pure. Only files reachable
  // from SKILL.md are actually scanned, following both doc and code chains
  // (SKILL.md → guide.md → a.py → b.py).
  const fileTexts = new Map<string, string>();
  for (const f of manifest.files) {
    if (f.path !== 'SKILL.md' && f.isText) {
      const bytes = await source.read(f.path);
      fileTexts.set(f.path, new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    }
  }
  const references = analyzeReferences(
    bodyText,
    paths,
    readmePath,
    licensePath,
    collector,
    fileTexts,
    dir,
  );

  // Stage: digest (P5). computeDigest re-parses the SKILL.md YAML block fresh
  // so the canonical JSON uses the raw parsed object (R1), not our normalized shape.
  const digest = await computeDigest(manifest.files, skillMdText);

  // Stage ⑪: finalize — apply options.rules overrides, sort, compute ok (P6).
  const { diagnostics, ok } = finalizeDiagnostics(collector.all(), opts.rules);

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
    files: manifest.files,
    tokens: {
      metadata: metadataTokens,
      body: bodyTokens,
      total: metadataTokens + bodyTokens,
      tokenizer: tokenizer.name,
    },
    references,
    size: manifest.size,
    digest,
    diagnostics,
  };
}
