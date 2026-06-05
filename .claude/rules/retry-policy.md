# Retry and Loop Bounding Policy

Bound retries so failures get diagnosed instead of masked. The defaults below apply
across this repo's gate: `npm run lint` → `npm run typecheck` → `npm test` (vitest, with
coverage thresholds) → `npm run build`.

## CI retries
- Maximum 2 retries for flaky CI failures before investigating root cause
- If the same test fails 3 times, stop retrying and diagnose
- A `typecheck` or coverage-threshold failure is **never** flaky — never retry it; fix the cause
- A determinism meta-test failure (same tree, different output) is **never** flaky by
  construction — the library is pure; something nondeterministic leaked in. Find it.

## Agent self-repair loops
- If a fix attempt fails twice in a row (same error), stop and report to the user
- Do not blindly retry the same approach — diagnose why it failed
- After 3 consecutive failed tool calls, pause and reassess strategy

## Test-fix cycles
- If a test fix introduces a new test failure, revert and rethink
- Do not chain more than 3 fix attempts without running the full suite (`npm test`)
- Never "fix" a failing snapshot by blindly updating it — read the diff first; a snapshot
  change is an output-contract change and must be intentional (and may require a
  `SkillAnalysisSchema` / schemaVersion update per @.claude/rules/commit-message.md)
- Never lower a coverage threshold to make the gate pass — the ratchet (`autoUpdate`)
  only moves up; write the missing tests instead

## When to escalate
- Error you don't understand after reading source and docs
- Circular dependency between fixes
- Environment issue (missing tool, permission, network)
- A fix would require changing the output contract, the digest definition (plan §5 R1),
  or a determinism guarantee — stop and flag it
- A fix would require jumping ahead of the current build-plan phase (P0–P6)
