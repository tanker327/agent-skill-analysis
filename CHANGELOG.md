# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-05

Complete rebuild. The earlier triggering-quality prototype (`parseSkill`, `analyzeSkill`,
analyzer plugins) is gone; the library is now a deterministic structural analyzer:
one skill folder in, one self-describing `SkillAnalysis` JSON out.

### Added

- `analyze(source, options?) → Promise<SkillAnalysis>` — the single entry point, built as a
  pure 10-stage pipeline (enumerate → SKILL.md read/split → frontmatter normalize/validate →
  body analysis → README/LICENSE + SPDX detection → per-file manifest → reference graph →
  sizes/tokens → digest → finalize).
- `SkillSource` input abstraction: `fromFiles` (in-memory, runtime-agnostic) and `fromDir`
  (Node-only, exported from the `agent-skill-analysis/node` subpath — the only fs-touching
  module).
- `SkillAnalysisSchema` (zod) as the single source of truth for the output shape
  (`schemaVersion` `1.0.0`, `specVersion` `agentskills-2025-12`); all TypeScript types are
  inferred from it.
- Diagnostics system: 21 stable codes in `DIAGNOSTIC_REGISTRY` with library-default
  severities; consumer overrides via `options.rules` (`error` / `warning` / `off`), with `ok`
  computed after overrides. Unknown frontmatter keys are preserved in `frontmatter.extra`,
  never warned about.
- Content digest (authoritative definition in the README): canonical-JSON normalized
  SKILL.md hash with `metadata.version` removed — a version-only bump keeps the digest;
  defined edge semantics for cyclic YAML anchors, non-finite numbers, and `-0`.
- Pluggable tokenizer (`options.tokenizer`; default `approx-chars-4`) with three-layer
  token budget output (`tokens.metadata` / `body` / `total` + `tokens.tokenizer`).
- Reference graph (`declared` / `resolved` / `broken` / `orphans`) with low-false-positive
  orphan detection (path-token matching) and warning-only broken-link parsing.
- Per-file manifest with byte `sha256`, `size`, `kind` classification, and `isText`;
  `options.maxFileBytes` guard with explicit `file-too-large` diagnostics.
- Guarantees, each enforced by meta-tests: byte-identical determinism (including under
  shuffled `SkillSource.list()` order), never-throws-on-content (the only rejection is
  `SkillSource` IO), schema conformance of every output, and digest stability.

### Changed

- Runtime dependencies are exactly `yaml` + `zod`; hashing uses WebCrypto.
- Node engine requirement raised from `>=18` to `>=20`.
- Package exports split: runtime-agnostic core at `.`, Node fs access at `./node`.

### Removed

- Legacy API: `parseSkill`, `analyzeSkill`, `defaultAnalyzers`, `descriptionAnalyzer`,
  `structureAnalyzer`, and the quality-score output (`AnalysisResult`, `Finding`).
