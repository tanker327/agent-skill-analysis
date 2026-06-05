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
npm run test:coverage             # with v8 coverage (per-file 100% thresholds gate CI)
npm run lint / lint:fix           # eslint
npm run typecheck                 # tsc --noEmit
npm run build                     # tsup -> dist/ (ESM + CJS + d.ts + skill-analysis.schema.json)
```

The gate is always all four: `lint → typecheck → test (coverage) → build`. A green `npm test` alone is NOT a green gate — vitest does not typecheck. CI (`.github/workflows/ci.yml`) runs the chain on Node 20 and 22 (`engines >=20`; WebCrypto global); `prepublishOnly` runs the same chain. Never use `--no-verify` (a hook blocks it).

## Where the truth lives

- **`src/schema.ts` is the output contract**: `SkillAnalysisSchema` (zod, strict objects) is the single source of truth — all TS types come from `z.infer`, `dist/skill-analysis.schema.json` is generated from it at build time (`scripts/generate-schema.mjs` via tsup `onSuccess`), and a test asserts the artifact matches byte-for-byte. Output-shape changes must update the schema and its conformance tests in the same commit.
- **The README's "Digest" section is the authoritative digest definition** — it, `src/digest.ts`, and the stability tests in `tests/digest.test.ts` always change together (an `arch` commit).
- Design docs in `global_ignore/` (gitignored, local-only): `skl-skill-analysis-output.md` (output contract), `skl-skill-analysis-flow.md` (pipeline), `skl-skill-analysis-plan.md` (the executed build plan + decision table R1–R7/F1–F5/O1–O6). When present they are the design rationale — consult them before structural work.
- `.claude/rules/` holds the working rules (commit format/scopes, testing strategy, retry bounds, issue tracking) — loaded automatically; follow them.

## Architecture

One entry point: `analyze(source, options?) → Promise<SkillAnalysis>`.

- **`SkillSource`** abstracts input: `fromFiles(map)` (in-memory; preferred in tests) and `fromDir(path)` — the only Node-fs code, exported from the `./node` subpath so the core stays runtime-agnostic.
- **Pipeline** (each stage a pure function in its own `src/` module, with a matching `tests/` file):
  `analyze.ts` (orchestration, ignore set) → `frontmatter.ts` (split/normalize/validate, incl. `projectJsonSafe` cycle-breaking at the yaml.parse boundary) → `markdown.ts` (hand-rolled line scanner: headings, link targets, inline code) + `body.ts` (lines/headings/token budgets) + `tokenizer.ts` (pluggable, default ≈chars/4) → `docs.ts` (README + LICENSE detection, two-tier SPDX) → `manifest.ts` (WebCrypto sha256/size/kind/isText per file) → `references.ts` (declared/resolved/broken/orphans; word-boundary matching) → `digest.ts` (R1 version-stripped canonical-JSON content hash) → `finalize.ts` (applies `options.rules` severity overrides, computes `ok`, sorts, assembles).
- **`diagnostics.ts`** is the code registry (21 codes; code → default severity/message/hint) + collector. New codes are registered there and must ship with an emitting test fixture in the same commit (a meta-test enforces both directions).
- **CLI**: the `asa` bin (`asa <folder> [--json]`, folder required — bare `asa` prints usage; exit codes 0 ok / 1 not-ok / 2 usage-or-IO). All logic lives in `src/cli.ts` (`runCli(argv, io)` with injectable IO — unit-testable to 100%); `src/cli-entry.ts` is the logic-free shebang wrapper (coverage-excluded like the barrel). The pretty view is presentation only — `--json` prints the untouched contract.
- **Runtime deps are only `yaml` + `zod`** — hashing is WebCrypto, markdown scanning is hand-rolled, fast-check/vitest are dev-only. Don't add dependencies casually.

## Invariants (regressions here are stop-and-fix, never deferred)

- **Deterministic**: same file tree → byte-identical JSON. No clock, no randomness, no locale-dependent formatting (`toLocaleString`/`localeCompare`/`Intl` are leaks — they pass same-process tests and break across environments), fixed sort order for every array. A determinism test failure is never flaky — something leaked.
- **Never throws on content**: any broken skill content (bad YAML, cyclic anchors, binary files, pathological markdown) becomes a `{ code, severity, message }` diagnostic with a stable code. The only allowed rejection is `SkillSource` IO. fast-check property tests enforce this over arbitrary inputs.
- **Digest** ignores `metadata.version`: SKILL.md's content hash is `sha256(canonicalJSON(raw frontmatter minus metadata.version, sorted keys) + "\n" + body)` — never raw bytes, never re-serialized YAML. `files[].sha256` stays the true byte hash; the two are intentionally different. The README section is normative; changing digest behavior is an `arch` commit updating code + stability tests + README together. Post-publish, a digest semantics change requires a schemaVersion major bump.
- **Unknown frontmatter keys are preserved** in `frontmatter.extra`, never warned about — real-world skills carry harness-specific keys.
- **Severity is policy, not mechanism**: stages emit codes with library defaults; `finalize` applies consumer `options.rules` overrides ('off' deletes), then computes `ok`.

## Working conventions

- Tests live in `tests/` (not colocated); prefer in-memory `fromFiles` sources — disk fixtures exist only to exercise `fromDir`.
- Coverage thresholds are a ratchet (`perFile: true`, `autoUpdate: true`, currently 100): they only move up; write tests instead of lowering them. Structurally-unreachable defensive branches (e.g. `noUncheckedIndexedAccess` guards on regex groups) may carry a `/* v8 ignore next -- reason */` block comment — but prefer removing dead code or writing a real test when the branch is reachable.
- Never blind-update a snapshot — a snapshot diff is an output-contract diff; diagnostic assertions use inline snapshots or explicit assertions.
- Test fixtures derive limits from exported implementation constants (`BODY_TOKEN_LIMIT`, `SPDX_ALLOWLIST`, `RESERVED_NAMES`, …), never hardcoded copies.
- Publishing: `npm publish` for any version requires Eric's explicit go-ahead — never publish autonomously.
