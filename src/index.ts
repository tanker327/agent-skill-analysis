/**
 * Public entry point. Node-only `fromDir` lives behind the "./node" subpath
 * (agent-skill-analysis/node) so this core entry stays runtime-agnostic.
 */
export { analyze, DEFAULT_IGNORE } from './analyze.js';
export { fromFiles } from './source.js';
export type { SkillSource } from './source.js';
export {
  ANALYZER_VERSION,
  AnalyzeOptionsSchema,
  SCHEMA_VERSION,
  SkillAnalysisSchema,
  SPEC_VERSION,
} from './schema.js';
export type {
  AnalyzeOptions,
  Diagnostic,
  FileEntry,
  FileKind,
  Frontmatter,
  Heading,
  RuleOverride,
  Severity,
  SkillAnalysis,
  Tokenizer,
} from './schema.js';
export { DIAGNOSTIC_REGISTRY } from './diagnostics.js';
export type { DefaultSeverity, DiagnosticCode, DiagnosticSpec } from './diagnostics.js';
