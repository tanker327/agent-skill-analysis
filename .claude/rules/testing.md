---
paths: ["tests/**", "**/*.test.ts", "vitest.config.ts"]
---

# Testing Strategy

This library uses **vitest** with v8 coverage. Tests live in `tests/`, one file per
`src/` module, plus `tests/contract.test.ts` for the cross-cutting meta-tests.
See `global_ignore/skl-skill-analysis-plan.md` §4 for the full strategy.

| Layer | Tool | Scope |
|---|---|---|
| Unit | vitest (`tests/<module>.test.ts`) | each pipeline stage as a pure function — table-driven, zero mocks |
| Fixture / integration | vitest + `fromFiles` memory source | full `analyze()` over constructed trees → snapshot |
| Contract meta-tests | vitest (`tests/contract.test.ts`) | determinism, schema conformance, diagnostic coverage, digest stability |
| Property-based | fast-check (P6+) | never-throw and always-schema-valid over fuzzed inputs |
| Coverage | `vitest run --coverage` | thresholds ratchet via `autoUpdate` + `perFile` |

## Principles

- **The pipeline is pure, so test it as pure.** Every stage takes inputs and returns
  output + diagnostics — no disk, no clock, no network. Unit-test with plain
  inputs/outputs; **no mocking, ever**. The only fs-touching code is `fromDir`
  (`src/node.ts`), tested against the few real fixtures in `tests/fixtures/`.
- **Prefer the memory source.** `fromFiles` constructs any tree (binary files, missing
  SKILL.md, broken YAML) without fs flakiness; use it for nearly everything.
- **Snapshots are for full-output fixtures only.** Diagnostics are asserted with inline
  snapshots or explicit asserts so a reviewer sees the expected codes in the test file.
  Never blind-update a snapshot — a snapshot diff is an output-contract diff.

## Invariants that MUST have tests (the contract meta-tests)

These encode the design guarantees — a regression fails CI:

- **Determinism**: same tree analyzed twice → byte-identical `JSON.stringify` output;
  shuffling the order `SkillSource.list()` returns → still identical (sorting guarantee).
- **Schema conformance**: every fixture's output passes `SkillAnalysisSchema.parse()`.
- **Diagnostic vocabulary coverage**: every code in the diagnostics registry is emitted
  by at least one fixture. Adding a code without a fixture fails the meta-test.
- **Digest stability pair** (plan §5 R1, authoritative): bumping only `metadata.version`
  → digest unchanged; changing one body character → digest changes; frontmatter
  formatting-only changes → digest unchanged.
- **Never-throw**: bad content (any kind) produces diagnostics, never an exception —
  the only allowed rejection is `SkillSource` IO (R3).

## Rules (MUST follow)

- Every new pipeline stage → a unit test file (it's pure; this is cheap).
- Every new diagnostic code → registered in `diagnostics.ts` **and** a fixture that
  emits it, in the same commit (the coverage meta-test enforces this).
- Every change to the output shape → update `SkillAnalysisSchema` + conformance
  fixtures in the same commit.
- Every bug fix → a regression test that fails before the fix. Write the failing test first.
- Coverage thresholds only ratchet up (`autoUpdate`); never hand-lower them — write the
  missing tests instead.
- Stay within the current build-plan phase (P0–P6): don't add tests for capability that
  phase hasn't built yet.
