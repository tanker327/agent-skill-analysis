# CLI usage — `asa`

The package ships an `asa` bin: point it at a skill folder, get the pretty report or the raw `SkillAnalysis` JSON. The CLI is Node-only (it reads the folder via `fromDir`); everything it prints with `--json` is the untouched library output — the pretty view is presentation only.

For the JS/TS API see [library-usage.md](library-usage.md); for a fully annotated JSON output see [output-example.md](output-example.md).

## Install

```bash
# As a project dependency
npm install agent-skill-analysis
npx asa ./my-skill

# Globally
npm install -g agent-skill-analysis
asa ./my-skill

# From a checkout of this repo
npm run build && npm link
asa ./my-skill
```

## Synopsis

```
asa <folder> [--json]
```

| Argument / option | Meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `folder`          | path to the skill folder — **required**; use `asa .` for the current directory |
| `--json`          | print the raw `SkillAnalysis` JSON (2-space indent) instead of the pretty view |
| `-h`, `--help`    | print usage (stdout, exit 0)                                                   |

Running bare `asa` (no folder) prints usage to **stderr** and exits `2` — analyzing the current directory must be asked for explicitly with `asa .`.

## Exit codes

| Code | Meaning               | Typical cause                                                              |
| ---- | --------------------- | -------------------------------------------------------------------------- |
| `0`  | analyzed, `ok: true`  | no error-severity diagnostics                                              |
| `1`  | analyzed, `ok: false` | error-severity diagnostics remain (e.g. `name-missing`)                    |
| `2`  | nothing analyzed      | missing/unknown argument, folder doesn't exist, **folder has no SKILL.md** |

A folder without a `SKILL.md` is rejected up front as "not a skill folder" — nothing is scanned or hashed:

```
$ asa ./random-folder
asa: no SKILL.md in './random-folder' — not a skill folder
$ echo $?
2
```

(That's CLI policy only — the library's `analyze()` still accepts such a tree and reports it through diagnostics. Use the JS API if you want that behavior.)

## The pretty view

```
$ asa ./pdf-tools
pdf-tools v1.2.0
Extract text and tables from PDF files. Use when the user asks to read, parse, or extract content from a PDF document.

✓ ok   ⚠ 3 warnings

dir            pdf-tools
license        MIT (frontmatter)
compatibility  Requires Python 3.10+ with pypdf installed.
allowed tools  Bash, Read, Write
tokens         94 (metadata 32 + body 62, approx-chars-4)
digest         sha256:0bdb5d9a41634803007d7dbc5869fd993f40e55de2cac6dbedf7bb9defce13f6

Body  14 lines, 3 headings
  # PDF Tools
    ## Quick start
    ## Details

Files  7 files, 828 B
  LICENSE                    89 B  license
  README.md                  48 B  readme
  SKILL.md                  553 B  instructions
  assets/table.css           22 B  asset
  references/formats.md      60 B  reference
  scripts/extract.py         31 B  script
  scripts/legacy.py          25 B  script

References  1 resolved, 1 broken, 1 orphan
  ✗ references/gone.md (broken)
  • scripts/legacy.py (orphan)

Diagnostics  3
  ⚠ warning allowed-tools-experimental [allowed-tools] — allowed-tools is experimental and support varies across agents.
  ⚠ warning broken-ref [references/gone.md] — Referenced path does not exist in the skill.
        hint: Fix the path or remove the reference from SKILL.md.
  ⚠ warning orphan-file [scripts/legacy.py] — File is not reachable from SKILL.md through any chain of references.
        hint: Reference it from SKILL.md (directly, or via a reachable doc or script) or remove it to keep the skill lean.
```

Reading it top to bottom:

- **Header** — `name vVERSION` and the description from frontmatter.
- **Status** — `✓ ok` / `✗ N errors`, plus the warning count. Mirrors the exit code (`0`/`1`).
- **Summary block** — folder name, license (`spdx (source)` when recognized, otherwise the declared text or `—`), optional compatibility / allowed-tools rows, token budget, and the digest.
- **Body** — line count and the heading outline (indentation = heading depth).
- **Files** — every analyzed file with byte size and kind (`instructions`, `reference`, `asset`, `script`, `readme`, `license`, `other` — classified by convention directory).
- **References** — resolved/broken counts from SKILL.md's markdown links, plus orphans: files not reachable from SKILL.md through **any chain of references** (markdown links, backtick mentions, Python/JS imports, shell calls — see the README's references section for the full matching rules).
- **Diagnostics** — every finding with its stable code, severity, the offending field/path in brackets, and a fix hint.

### Colors

ANSI colors appear only when stdout is a TTY, and [`NO_COLOR`](https://no-color.org) is respected. Piped/redirected output is always plain text — no stripping needed.

## `--json` mode

`asa <folder> --json` prints exactly `JSON.stringify(analysis, null, 2)` — the full output contract, schema-validated, nothing added or removed. See [output-example.md](output-example.md) for every field explained.

## Scripting recipes

```bash
# Content identity of a skill (version-independent)
asa ./my-skill --json | jq -r .digest

# Gate a CI job: asa exits 1 on error-severity diagnostics
asa ./my-skill || exit 1

# List orphaned files
asa ./my-skill --json | jq -r '.references.orphans[]'

# Count tokens the skill costs when activated
asa ./my-skill --json | jq .tokens.body

# Diff two skill versions by content, ignoring metadata.version bumps
[ "$(asa ./v1 --json | jq -r .digest)" = "$(asa ./v2 --json | jq -r .digest)" ] \
  && echo "same content"

# Machine-readable diagnostics as TSV: code<TAB>severity<TAB>field
asa ./my-skill --json | jq -r '.diagnostics[] | [.code, .severity, .field // ""] | @tsv'
```

Because the output is deterministic (same tree → byte-identical JSON), `asa --json` output is safe to cache, hash, and diff.

## What the CLI cannot do (use the library)

- Severity overrides (`rules`), custom ignore sets, `maxFileBytes`, custom tokenizers — these are `analyze()` options without CLI flags. See [library-usage.md](library-usage.md).
- Analyzing in-memory trees / tarballs — use `fromFiles`.
- Analyzing a folder without SKILL.md — CLI refuses (exit 2); the library reports it as diagnostics.
