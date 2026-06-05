# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project identity

This is **agent-skill-analysis** (npm package, GitHub `tanker327/agent-skill-analysis`). The local folder may be named `skill-analysis` — that name is wrong; never derive the project name, URLs, or `gh` arguments from the folder.

A TypeScript library: give it an AI-agent skill folder (a `SKILL.md` plus resources), get back one deterministic, self-describing `SkillAnalysis` JSON.

## Commands

```bash
npm test                          # vitest run (all tests)
npx vitest run tests/foo.test.ts  # single test file
npx vitest run -t "name"          # single test by name
npm run test:coverage             # with v8 coverage (thresholds gate CI)
npm run lint / lint:fix           # eslint
npm run typecheck                 # tsc --noEmit
npm run build                     # tsup -> dist/ (ESM + CJS + d.ts)
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build on a Node matrix; `prepublishOnly` runs the same chain. Never use `--no-verify` (a hook blocks it).

## Where the truth lives

- **Design docs are in `global_ignore/`** (gitignored, local-only): `skl-skill-analysis-output.md` (the output JSON contract), `skl-skill-analysis-flow.md` (the 10-stage pipeline), `skl-skill-analysis-plan.md` (implementation phases P0–P6 + the decision table R1–R7/F1–F5/O1–O6). When present, they are authoritative — read them before structural work. The essentials are summarized below for clones that lack them.
- `.claude/rules/` holds the working rules (commit format/scopes, testing strategy, retry bounds, issue tracking) — they are loaded automatically; follow them.

## Architecture (target)

**The repo is mid-rebuild.** The current `src/` (`parser.ts`, `analyzers/` — an older quality-score design) is legacy and is being replaced wholesale by the pipeline below; don't extend the legacy code.

One entry point: `analyze(source, options?) → Promise<SkillAnalysis>`.

- **`SkillSource`** abstracts input: `fromFiles(map)` (memory; preferred in tests) and `fromDir(path)` (the only Node-fs code, exported from the `./node` subpath so the core stays runtime-agnostic).
- **Pipeline**: enumerate+ignore → read/split SKILL.md → frontmatter normalize+validate → body analysis (headings, tokens) → README / LICENSE+SPDX detection → per-file manifest (sha256/size/kind) → reference graph (resolved/broken/orphans) → digest → finalize (apply `options.rules` severity overrides, compute `ok`, assemble). Each stage is a pure function in its own `src/` module with a matching `tests/` file.
- **Contract**: `SkillAnalysisSchema` (zod) in `src/schema.ts` is the single source of truth — types come from `z.infer`, a JSON Schema artifact is generated at build time, and tests validate every output against it. Output-shape changes must update the schema in the same commit.
- **Runtime deps are only `yaml` + `zod`** — hashing is WebCrypto, markdown scanning is a hand-rolled line scanner (`src/markdown.ts`), the tokenizer is a pluggable interface with a chars/4 default. Don't add dependencies casually.

## Invariants (regressions here are stop-and-fix, never deferred)

- **Deterministic**: same file tree → byte-identical JSON. No clock, no randomness, fixed sort order for every array. A determinism test failure is never flaky — something leaked.
- **Never throws on content**: any broken skill content becomes a `{ code, severity, message }` diagnostic with a stable code. The only allowed rejection is `SkillSource` IO. Every diagnostic code must be emitted by at least one test fixture (a meta-test enforces this).
- **Digest** ignores `metadata.version`: SKILL.md's content hash is `sha256(canonicalJSON(frontmatter minus metadata.version, sorted keys) + "\n" + body)` — never raw bytes, never re-serialized YAML. `files[].sha256` stays the true byte hash. This definition is authoritative (plan §5 R1); changing it requires updating its stability tests and the README together.
- **Unknown frontmatter keys are preserved** in `frontmatter.extra`, never warned about — real-world skills carry harness-specific keys.
- **Severity is policy, not mechanism**: stages emit codes with library-default severities; `finalize` applies consumer `options.rules` overrides, then computes `ok`.

## Phase discipline

Work follows the plan's phases P0–P6 (scaffold/contract → frontmatter chain → body+tokens → README/LICENSE → manifest+references → digest → finalize/publish). Don't implement ahead of the current phase; each phase ends with lint + typecheck + test + commit, and `analyze()` must produce schema-valid output at every phase boundary.

## Gotchas

- `CONTRIBUTING.md` predates the rebuild (it mentions `src/analyzers/` and zero-dependency goals) — the rules in `.claude/rules/` and the plan doc win on conflict.
- Tests live in `tests/` (not colocated); prefer the in-memory source over disk fixtures; never blind-update a snapshot — a snapshot diff is an output-contract diff.
- Coverage thresholds ratchet (`autoUpdate` + `perFile` in vitest config once P0 lands): they only move up; write tests instead of lowering them.
