# Contributing to agent-skill-analysis

Thanks for your interest in contributing!

## Getting started

```bash
git clone https://github.com/tanker327/agent-skill-analysis.git
cd agent-skill-analysis
npm install
npm test
```

Node >= 20 is required (the library hashes via the WebCrypto global).

## Development workflow

1. Fork the repo and create a feature branch from `main`.
2. Make your changes, including tests for new behavior.
3. Make sure the full gate passes — all four steps, every time (a green `npm test` alone is not enough; vitest does not typecheck):
   ```bash
   npm run lint
   npm run typecheck
   npm run test:coverage
   npm run build
   ```
4. Open a pull request with a clear description of the change and motivation.

## Architecture in one paragraph

One entry point — `analyze(source, options?) → Promise<SkillAnalysis>` — runs a pure pipeline: each stage is a pure function in its own `src/` module (`frontmatter.ts`, `markdown.ts`, `body.ts`, `docs.ts`, `manifest.ts`, `references.ts`, `digest.ts`, `finalize.ts`), orchestrated by `analyze.ts` over a `SkillSource` (`fromFiles` in-memory, or `fromDir` from the `./node` subpath — the only file that touches `node:fs`). `src/schema.ts` (zod) is the single source of truth for the output shape; `src/diagnostics.ts` is the registry of all diagnostic codes.

## Guidelines

- **Runtime dependencies are exactly `yaml` and `zod`.** Everything else is built in (WebCrypto hashing, hand-rolled markdown scanner). PRs adding runtime dependencies need a very strong case.
- **Determinism is the core guarantee**: same file tree → byte-identical JSON. No clocks, no randomness, no locale-dependent string formatting, fixed sort order for every array.
- **The library never throws on content** — broken input becomes a `{ code, severity, message }` diagnostic. Only `SkillSource` IO may reject.
- **Output-shape changes** must update `SkillAnalysisSchema` and its conformance tests in the same commit. The JSON Schema artifact (`dist/skill-analysis.schema.json`) regenerates from it at build time.
- **New diagnostic codes** are registered in `src/diagnostics.ts` and must ship with a test fixture that emits them — a meta-test in `tests/contract.test.ts` enforces this in both directions.
- **Digest changes are special**: the README's "Digest" section is the authoritative definition; any behavioral change updates `src/digest.ts`, the stability tests, and the README together.
- Tests live in `tests/` (not colocated). Prefer in-memory `fromFiles` fixtures; disk fixtures only for `fromDir`. Derive limits from exported constants (`BODY_TOKEN_LIMIT`, `SPDX_ALLOWLIST`, …) rather than hardcoding copies.
- Coverage thresholds are a ratchet (per-file, auto-updating) — they only go up. Write the missing tests instead of lowering them.
- Public API changes need README updates.
- Follow the existing code style (Prettier + ESLint enforce most of it).

## Reporting bugs

Open an issue with a minimal reproduction — ideally the `SKILL.md` content (or `fromFiles` map) that triggers the problem and the output you expected. If the bug is a determinism break (same tree, different JSON), say so — those are treated as highest priority.
