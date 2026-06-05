#!/usr/bin/env bash
# PreToolUse hook: refuse edits to generated/managed files.
#   - package-lock.json is owned by `npm install`, never hand-edited.
#   - dist/ is tsup build output; edit src/ and rebuild instead.
#   - .env / .env.* would hold real credentials if ever added (gitignored);
#     .env.example is the only one that may be edited.
# Exit 2 blocks the tool call and feeds stderr back to Claude.
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.file_path??"")}catch{}})')

[ -n "$file" ] || exit 0
base=$(basename "$file")

case "$file" in
  */dist/* | dist/*)
    echo "Blocked: '$file' is tsup build output. Edit the source under src/ and run 'npm run build' instead." >&2
    exit 2
    ;;
esac

case "$base" in
  .env.example)
    exit 0
    ;;
  .env | .env.*)
    echo "Blocked: '$file' is a secret env file (gitignored). Edit it manually if needed; update .env.example for shape changes." >&2
    exit 2
    ;;
  package-lock.json)
    echo "Blocked: package-lock.json is managed by npm. Run 'npm install <pkg>' / 'npm uninstall <pkg>' to change dependencies instead of editing the lockfile." >&2
    exit 2
    ;;
esac
exit 0
