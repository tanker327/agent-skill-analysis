# Issue Tracking Policy

This project tracks issues as **GitHub Issues** on `tanker327/agent-skill-analysis` (via the
`gh` CLI), not in-repo files. (The local folder is named `skill-analysis` — that's wrong;
the project/repo name is `agent-skill-analysis`.) There is no `progress/` directory.

## When to log an issue
- Only log issues that are **unrelated to the current task** and **do not block it**
- If an issue **blocks the current task**, fix it immediately to keep the task moving — do not log it separately
- If you fix a blocking issue inline, document it in the **commit body** of the commit that fixes it (the git log is our changelog — see @.claude/rules/commit-message.md), not as a separate issue
- Before logging, search for an existing one: `gh issue list --search "<keywords>"` — comment on it instead of opening a duplicate

## How to log
Open the issue **immediately** when discovered — do not wait until end of session. Use the
template below.

```bash
gh issue create \
  --title "<scope>: <short summary>" \
  --label bug \
  --body "$(cat <<'EOF'
## Severity
non-blocker

## Summary
<1-2 sentences: what's wrong and where>

## Affected files / tests
<list — e.g. src/digest.ts, tests/digest.test.ts>

## Error evidence
<exact error messages, stack traces, failing test output>

## Root cause analysis
<why it happens — or "unknown, needs investigation">

## Potential fixes
1. <option>
2. <option>

## Phase
<the build-plan phase (P0–P6) this relates to, if known>
EOF
)"
```

- Title `<scope>` uses the commit scopes from @.claude/rules/commit-message.md (`schema`, `digest`, `frontmatter`, …)
- Use `--label enhancement` instead of `bug` for follow-up work rather than defects
- Capture the issue number returned by `gh issue create` so you can reference it

## Linking issues to work
- Reference the issue in the commit/PR that addresses it: put `refs #<n>` (or `closes #<n>` to auto-close) in the commit footer
- A fix commit that closes an issue MUST still describe **what** changed and **why** in its body per the commit-message rule — `closes #n` is a link, not a substitute for the changelog entry

## When to fix logged issues
- Address logged (non-blocking) issues after the current task/loop is done
- If a logged issue later starts blocking a task, fix it immediately and `closes #<n>` in the fix commit
- Never reclassify a contract regression (output shape, digest definition, determinism) as a "non-blocker" issue to defer — those are stop-and-fix per @.claude/rules/retry-policy.md
