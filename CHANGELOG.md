# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-06

First published release. Complete rebuild relative to the unpublished prototype: the earlier
triggering-quality experiment (`parseSkill`, `analyzeSkill`, analyzer plugins) is gone; the
library is a deterministic structural analyzer — one skill folder in, one self-describing
`SkillAnalysis` JSON out — plus an `asa` CLI on top.

### Added

- `analyze(source, options?) → Promise<SkillAnalysis>` — the single entry point, built as a
  pure 10-stage pipeline (enumerate → SKILL.md read/split → frontmatter normalize/validate →
  body analysis → README/LICENSE + SPDX detection → per-file manifest → reference graph →
  sizes/tokens → digest → finalize).
- `asa` CLI (`asa <folder> [--json]`): human-readable skill report by default, the raw
  untouched `SkillAnalysis` JSON with `--json`. The folder argument is required (bare `asa`
  prints sectioned usage with examples); a folder without SKILL.md is rejected up front as
  not-a-skill-folder (CLI policy only — the `analyze()` API still accepts it). Exit codes:
  0 ok, 1 analysis not-ok, 2 usage or IO error.
- `SkillSource` input abstraction: `fromFiles` (in-memory, runtime-agnostic) and `fromDir`
  (Node-only, exported from the `agent-skill-analysis/node` subpath — the only fs-touching
  module). `fromDir().read()` rejects paths that resolve outside the skill root.
- `SkillAnalysisSchema` (zod) as the single source of truth for the output shape
  (`schemaVersion` `1.0.0`, `specVersion` `agentskills-2025-12`); all TypeScript types are
  inferred from it. The generated JSON Schema artifact ships in the package
  (`dist/skill-analysis.schema.json`) and is committed at the repo root, guarded by a
  byte-match drift test.
- Diagnostics system: 22 stable codes in `DIAGNOSTIC_REGISTRY` with library-default
  severities; consumer overrides via `options.rules` (`error` / `warning` / `off`), with `ok`
  computed after overrides. Unknown frontmatter keys are preserved in `frontmatter.extra`,
  never warned about.
- Reference graph: `declared` split into `resolved` / `broken` / `external` (URLs, mailto,
  anchors), plus `orphans`. Directory link targets resolve against the manifest; `./`, `.`,
  `..` segments and `#fragment` anchors are normalized before resolution; CommonMark link
  titles and angle-bracketed destinations are handled.
- Transitive orphan detection: reachability walks from SKILL.md through ALL text files —
  markdown and source alike — recognizing realistic mention spellings: markdown links,
  backtick paths, Python/JS import forms (including the `__init__.py` package rule and
  sibling-directory `sys.path` imports), shell dynamic-prefix paths (`$VAR/`, `${VAR}/`,
  `$(...)/ `, `{baseDir}/`), absolute deploy-mount paths (`/mnt/.../<skill>/...`),
  directory-as-resource-pool references (`./fonts`, `templates/`), and paths named in
  frontmatter (e.g. hook `command:` strings). Root-level community-health docs
  (CONTRIBUTING, CHANGELOG, AGENTS.md, …) are excluded from orphan candidates.
- Content digest (authoritative definition in the README): canonical-JSON normalized
  SKILL.md hash with `metadata.version` removed — a version-only bump keeps the digest;
  defined edge semantics for cyclic YAML anchors, non-finite numbers, and `-0`.
- Pluggable tokenizer (`options.tokenizer`; default `approx-chars-4`) with three-layer
  token budget output (`tokens.metadata` / `body` / `total` + `tokens.tokenizer`).
- Per-file manifest with byte `sha256`, `size`, `kind` classification, and `isText`;
  `options.maxFileBytes` guard with explicit `file-too-large` diagnostics. Localized
  READMEs (`README.<lang>.md`) classify as `kind: "readme"` and satisfy readme detection.
- Guarantees, each enforced by meta-tests: byte-identical determinism (including under
  shuffled `SkillSource.list()` order), never-throws-on-content (the only rejection is
  `SkillSource` IO), schema conformance of every output, and digest stability.

### Changed

- Runtime dependencies are exactly `yaml` + `zod`; hashing uses WebCrypto.
- Node engine requirement raised from `>=18` to `>=20` (CI runs Node 20 and 22).
- Package exports split: runtime-agnostic core at `.`, Node fs access at `./node`.
- `frontmatter.allowed-tools` splits on commas and whitespace, parenthesis-aware — a
  pattern like `Bash(foo *)` stays one token.
- The output was hardened against a ~11k-skill real-world corpus (findings F2–F24): the
  default ignore set covers VCS/CI/tooling artifacts and all common lockfiles (npm, yarn,
  pnpm, Bun), inline-code masking is a spec-correct CommonMark multi-backtick code-span
  scanner, and a top-level `version` key hoists into `frontmatter.version` without
  duplicating into `extra`.

### Removed

- Legacy API: `parseSkill`, `analyzeSkill`, `defaultAnalyzers`, `descriptionAnalyzer`,
  `structureAnalyzer`, and the quality-score output (`AnalysisResult`, `Finding`).
- `license.text` — the output contract carries license detection metadata, not the full
  license body.
