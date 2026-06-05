# Commit Message Rules

## Format

```
<type>(<scope>): <short description>

[optional body]
[optional footer: refs P<n>, global_ignore/skl-skill-analysis-*.md]

Co-Authored-By: Claude <noreply@anthropic.com>
```

- Subject line: 72 characters max, lowercase, no trailing period — a one-line summary of the change
- Body: **required for any non-trivial commit** (wrap at 100 characters). The git log is our changelog, so the body must be detailed enough to understand the change without reading the diff:
  - **What changed** — the concrete edits: files/modules touched, behavior added/removed/altered, schema or diagnostic codes changed. Use a bullet list when more than one thing changed.
  - **Why** — the reason or problem being solved, so a future reader understands intent, not just mechanics.
- **Branch context**: if this commit is one of several on a feature branch, add a line explaining what _this_ commit contributes toward the branch's overall goal.
- Footer: reference the build-plan phase (P0–P6, see `global_ignore/skl-skill-analysis-plan.md`) and/or the design doc that motivated the change, if applicable
- Every commit Claude makes ends with a `Co-Authored-By: Claude … <noreply@anthropic.com>` trailer (the harness supplies the exact model name)

Trivial commits (a typo fix, a formatting-only change, a dependency bump) may use just the subject line; everything that changes behavior or structure needs a body.

## Types

| Type       | When to use                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `feat`     | New capability: a pipeline stage, a diagnostic code, a SkillSource, an exported API                                   |
| `fix`      | Bug fix                                                                                                               |
| `test`     | Adding or updating tests/fixtures only                                                                                |
| `arch`     | Contract changes: `SkillAnalysisSchema` shape, `schemaVersion` bump, digest definition, JSON Schema artifact, CI gate |
| `chore`    | Dependencies, tooling, config (tsup, vitest, eslint, prettier, tsconfig)                                              |
| `docs`     | Documentation only (README, CHANGELOG, design docs) — no code change                                                  |
| `refactor` | Code restructure with no behavior change                                                                              |

## Scopes — map to the library's modules

`schema` | `source` | `analyze` | `frontmatter` | `markdown` | `body` | `license` | `manifest` | `references` | `digest` | `finalize` | `tokenizer` | `diagnostics` | `cli` | `tests` | `harness` | `docs` | `repo`

- `schema` — the zod contract (`schema.ts`), output shape, JSON Schema artifact
- `source` — `SkillSource` interface, `fromFiles`, `fromDir` (`source.ts` / `node.ts`)
- `analyze` — pipeline orchestration (`analyze.ts`), ignore set, options
- `frontmatter` / `markdown` / `body` / `license` / `manifest` / `references` / `digest` / `finalize` / `tokenizer` / `diagnostics` — the matching `src/*.ts` module
- `cli` — the `asa` bin (`cli.ts`, `cli-entry.ts`, the package.json `bin` field)
- `tests` — fixtures, helpers, contract meta-tests (when not tied to one module)
- `harness` — `.claude/` (hooks, rules, settings), `.github/`
- `docs` — README, CHANGELOG, `global_ignore/` design docs
- `repo` — root tooling spanning the package (`package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`)

Use the module the change primarily lives in. A change that alters the output contract (even from inside one stage) prefers `schema` — the contract is the source of truth.

## Examples

A full commit with a changelog-quality body:

```
feat(digest): hash SKILL.md via canonical JSON with metadata.version removed

What changed:
- Add digest.ts: per-file content hashes joined as a path-sorted manifest
  string, then sha256'd into the top-level digest.
- SKILL.md's content hash is computed from canonicalJSON(frontmatter with
  metadata.version deleted, keys sorted) + "\n" + body — not the raw bytes —
  so a version-only bump leaves the digest unchanged (R1).
- files[].sha256 still hashes the real bytes; the two are intentionally
  different.

Why: digest is the registry-facing content identity; bumping the version
must not change it, and YAML re-serialization is not canonical across
libraries so we normalize through JSON instead.

refs P5, global_ignore/skl-skill-analysis-plan.md §5 R1

Co-Authored-By: Claude <noreply@anthropic.com>
```

Trivial commits — subject line only:

```
chore(repo): bump engines to node >=20
docs(readme): fix typo in the diagnostics table
```

## Rules (MUST follow)

- NEVER use `--no-verify` to bypass pre-commit hooks or the CI gate
- The git log IS our changelog: any commit that changes behavior or structure MUST have a body describing **what** changed and **why** — detailed enough to understand without opening the diff
- One logical change per commit — do not bundle unrelated changes
- Scope MUST be one of the module names above
- Respect phase discipline: a commit should not implement work beyond the current build-plan phase (P0–P6); if it does, that is a signal to split it
- Any commit that changes the output shape MUST update `SkillAnalysisSchema` and its conformance tests in the same commit — the schema and reality never drift
- The digest definition (plan §5 R1) is authoritative: a commit that changes digest behavior MUST update the digest stability tests and the README definition together, and is an `arch` commit
- Always end the message with the `Co-Authored-By` trailer
