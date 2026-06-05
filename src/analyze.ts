/**
 * Pipeline orchestration. P0 skeleton: stage ① (enumerate + ignore set) is
 * real; every other field is a legal empty value so the output is
 * schema-valid and byte-deterministic from day one. Stages ②–⑩ light up in
 * P1–P5; finalize policy lands in P6.
 */
import { compareDiagnostics, DiagnosticCollector } from './diagnostics.js';
import {
  ANALYZER_VERSION,
  AnalyzeOptionsSchema,
  SCHEMA_VERSION,
  SPEC_VERSION,
  type AnalyzeOptions,
  type Diagnostic,
  type SkillAnalysis,
} from './schema.js';
import type { SkillSource } from './source.js';

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

/** Name of the default chars/4 tokenizer (implemented in P2, src/tokenizer.ts). */
const DEFAULT_TOKENIZER_NAME = 'approx-chars-4';

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

  // Stage ①: enumerate + ignore. Sorted immediately — source order is never trusted.
  const paths = (await source.list()).filter((p) => !isIgnored(p, ignore)).sort();

  const collector = new DiagnosticCollector();
  if (!paths.includes('SKILL.md')) {
    collector.emit('no-skill-md');
  }

  // P0 policy resolution (superseded by finalize.ts in P6): fixed sort,
  // ok = no errors. Two P1 behaviors are deliberately absent until the codes
  // that exercise them register: the default-"off" filter (name-reserved) —
  // which the compiler will demand back, because RegisteredDefaultSeverity
  // widens to include 'off' (see diagnostics.ts) — and the `field`
  // passthrough (frontmatter codes), which the P1 diagnostic fixtures assert.
  const diagnostics: Diagnostic[] = [];
  for (const raw of collector.all()) {
    const diag: Diagnostic = { code: raw.code, severity: raw.severity, message: raw.message };
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
    dir: source.dir ?? null,
    frontmatter: {
      name: null,
      description: null,
      version: null,
      license: null,
      compatibility: null,
      allowedTools: null,
      metadata: null,
      extra: {},
    },
    body: null,
    readme: null,
    license: { declared: null, spdx: null, file: null, text: null, source: null },
    files: [],
    tokens: { metadata: 0, body: 0, total: 0, tokenizer: DEFAULT_TOKENIZER_NAME },
    references: { declared: [], resolved: [], broken: [], orphans: [] },
    size: { total: 0, byKind: {} },
    digest: EMPTY_DIGEST,
    diagnostics,
  };
}
