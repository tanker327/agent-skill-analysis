#!/usr/bin/env bash
# PostToolUse hook: after editing a src/ module, run its mirrored vitest file
# (src/<name>.ts -> tests/<name>.test.ts); after editing a test file, run that
# file. Advisory only — failures come back as additionalContext so Claude sees
# them immediately, but the hook never blocks (always exits 0). The full gate
# (lint -> typecheck -> npm test -> build) remains the enforcement point.
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.file_path??"")}catch{}})')

[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Normalize to a repo-relative path.
rel=${file#"$PWD"/}

case "$rel" in
  src/*.d.ts) exit 0 ;;
  src/*.ts)
    base=$(basename "$rel" .ts)
    test_file="tests/${base}.test.ts"
    ;;
  tests/*.test.ts)
    test_file=$rel
    ;;
  *) exit 0 ;;
esac

[ -f "$test_file" ] || exit 0
VITEST=./node_modules/.bin/vitest
[ -x "$VITEST" ] || exit 0

if ! out=$(NO_COLOR=1 CI=1 "$VITEST" run "$test_file" 2>&1); then
  printf '%s' "$out" | tail -40 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"Related tests FAILED ('"$test_file"'):\n"+s}}))})' 2>/dev/null || true
fi
exit 0
