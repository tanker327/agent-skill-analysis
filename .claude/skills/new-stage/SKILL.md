---
name: new-stage
description: Scaffold a pipeline stage for the SkillAnalysis analyzer — src module, mirrored test file, diagnostic registry entries, fixtures, and wiring into analyze.ts
disable-model-invocation: true
argument-hint: <stage-name> [diagnostic-code ...]
---

Scaffold a new pipeline stage named `$1` (kebab-case → `src/$1.ts`), following the
conventions from `global_ignore/skl-skill-analysis-plan.md` §2–§3 and
`.claude/rules/testing.md`. Any further arguments are diagnostic codes the stage
will emit.

## Preconditions — verify before doing anything

1. `src/schema.ts`, `src/diagnostics.ts`, and `src/analyze.ts` exist (P0 has
   landed). If not, STOP and tell the user this skill needs the P0 skeleton first.
2. `src/$1.ts` does not already exist. If it does, STOP — this skill scaffolds,
   it does not overwrite.

## Steps

1. **Create `src/$1.ts`** — a pure function module:
   - One exported function taking plain inputs (never a `SkillSource` — IO stays
     in `analyze.ts`) and returning `{ <result fields>, diagnostics: Diagnostic[] }`.
   - No clock, no randomness, no locale-dependent calls, no `node:` imports.
   - Any array it returns must have a fixed, documented sort order.
   - Match the style of the closest existing stage module.

2. **Register diagnostic codes** — for each code passed as an argument, add an
   entry to the registry in `src/diagnostics.ts`: code, default severity
   (`error` | `warning`), message template, optional hint. Codes are kebab-case,
   no `E_`/`W_` prefixes (e.g. `readme-missing`).

3. **Create `tests/$1.test.ts`** — mirrored test file:
   - Table-driven unit tests over the pure function: happy path, empty input,
     and one case per diagnostic code (the vocabulary meta-test in
     `tests/contract.test.ts` fails CI if a registered code has no fixture).
   - Zero mocks. Use plain values or the `fromFiles` memory source via
     `tests/helpers.ts` for full-pipeline cases.

4. **Wire into the pipeline** — call the stage from `src/analyze.ts` at the
   right point in the flow (see the pipeline order in
   `global_ignore/skl-skill-analysis-flow.md` §1, or the stage sequence already
   in `analyze.ts`). If the stage adds output fields, update
   `SkillAnalysisSchema` in `src/schema.ts` **in this same change** and extend
   the full-output fixtures.

5. **Run the gate** — `npm run lint && npm run typecheck && npm test`. All
   green, including the contract meta-tests (determinism, schema conformance,
   diagnostic coverage).

6. **Report** — list created/modified files, the registered codes, and remind
   the user this should be committed per `.claude/rules/commit-message.md`
   (scope = the stage name; `arch` type if the schema changed, otherwise `feat`).

Stay within the current build-plan phase: if `$1` belongs to a later phase than
the one in progress, point that out and ask before proceeding.
