#!/usr/bin/env bash
# PostToolUse hook: auto-format the file Claude just edited with Prettier, then
# surface any remaining ESLint issues, so every change lands CI-clean (matches
# `npm run format` / `npm run lint`). Never blocks (always exits 0).
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.file_path??"")}catch{}})')

[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0

# Only touch files Prettier handles in this repo.
case "$file" in
  *.ts | *.tsx | *.js | *.mjs | *.cjs | *.json | *.md | *.yml | *.yaml) ;;
  *) exit 0 ;;
esac

# Never touch generated/build output or the lockfile.
case "$file" in
  */dist/* | */node_modules/* | */coverage/* | *package-lock.json) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
PRETTIER=./node_modules/.bin/prettier
[ -x "$PRETTIER" ] || exit 0

"$PRETTIER" --write "$file" >/dev/null 2>&1 || true

# For lintable files, run ESLint with auto-fix, then surface anything it couldn't
# fix back to Claude as additionalContext (needs a code change, not formatting).
case "$file" in
  *.ts | *.tsx | *.js | *.mjs | *.cjs) ;;
  *) exit 0 ;;
esac

ESLINT=./node_modules/.bin/eslint
[ -x "$ESLINT" ] || exit 0

"$ESLINT" --fix "$file" >/dev/null 2>&1 || true
if ! out=$("$ESLINT" "$file" 2>&1); then
  printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"ESLint still reports issues after auto-fix (fix in code):\n"+s}}))})' 2>/dev/null || true
fi
exit 0
