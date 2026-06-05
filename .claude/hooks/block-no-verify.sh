#!/usr/bin/env bash
# PreToolUse (Bash) hook: block `--no-verify`, which would bypass the pre-commit /
# CI gate. Our commit-message and retry-policy rules forbid it in writing — this
# enforces it mechanically. Exit 2 blocks the command and feeds stderr to Claude.
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.command??"")}catch{}})')

if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])--no-verify([[:space:]]|=|$)'; then
  echo "Blocked: --no-verify bypasses the pre-commit/CI gate. Fix the reported issues instead (see .claude/rules/commit-message.md and .claude/rules/retry-policy.md)." >&2
  exit 2
fi
exit 0
