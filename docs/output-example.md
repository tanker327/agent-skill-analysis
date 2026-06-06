# `SkillAnalysis` output — a full annotated example

This walks through a complete, real `analyze()` / `asa --json` output, field by field. The JSON below was produced by the library from the example skill shown first — every byte is genuine output, not hand-written.

The authoritative contract is `SkillAnalysisSchema` (zod, strict objects) exported from the package; a generated JSON Schema is committed at the repo root as [`skill-analysis.schema.json`](../skill-analysis.schema.json) and ships in the package as `dist/skill-analysis.schema.json`. Strict means **no extra keys, ever** — what you see here is the entire shape.

## The example skill

```
pdf-tools/
├── SKILL.md
├── README.md
├── LICENSE
├── assets/table.css
├── references/formats.md
└── scripts/
    ├── extract.py
    └── legacy.py        ← never referenced anywhere (planted orphan)
```

`SKILL.md`:

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when the user asks to read, parse, or extract content from a PDF document.
license: MIT
compatibility: Requires Python 3.10+ with pypdf installed.
allowed-tools: Bash Read Write
metadata:
  version: '1.2.0'
  author: Eric Wu
---

# PDF Tools

Extract content from PDF files.

## Quick start

Run `scripts/extract.py <file.pdf>` for plain text.

## Details

See [the format guide](references/formats.md) for table extraction,
and [missing doc](references/gone.md) for nothing.
```

Note the three planted findings: a link to `references/gone.md` (which doesn't exist), `scripts/legacy.py` (which nothing references), and the experimental `allowed-tools` key.

## The full output

```json
{
  "schemaVersion": "1.0.0",
  "analyzerVersion": "0.1.0",
  "specVersion": "agentskills-2025-12",
  "ok": true,
  "dir": "pdf-tools",
  "frontmatter": {
    "name": "pdf-tools",
    "description": "Extract text and tables from PDF files. Use when the user asks to read, parse, or extract content from a PDF document.",
    "version": "1.2.0",
    "license": "MIT",
    "compatibility": "Requires Python 3.10+ with pypdf installed.",
    "allowedTools": ["Bash", "Read", "Write"],
    "metadata": {
      "author": "Eric Wu",
      "version": "1.2.0"
    },
    "extra": {}
  },
  "body": {
    "text": "\n# PDF Tools\n\nExtract content from PDF files.\n\n## Quick start\n\nRun `scripts/extract.py <file.pdf>` for plain text.\n\n## Details\n\nSee [the format guide](references/formats.md) for table extraction,\nand [missing doc](references/gone.md) for nothing.\n",
    "lines": 14,
    "headings": [
      { "depth": 1, "text": "PDF Tools" },
      { "depth": 2, "text": "Quick start" },
      { "depth": 2, "text": "Details" }
    ]
  },
  "readme": {
    "path": "README.md",
    "text": "# pdf-tools\nExtracts text and tables from PDFs.\n"
  },
  "license": {
    "declared": "MIT",
    "spdx": "MIT",
    "file": "LICENSE",
    "source": "frontmatter"
  },
  "files": [
    {
      "path": "LICENSE",
      "size": 89,
      "sha256": "6a0daa6f78372e0eced9afb74013a99b97ca0298abafc86f9ff296285964b2d1",
      "kind": "license",
      "isText": true
    },
    {
      "path": "README.md",
      "size": 48,
      "sha256": "5e40388d0612538ef24f87fa72d765006f70bd233c5c1b59a68f4446de76a0d7",
      "kind": "readme",
      "isText": true
    },
    {
      "path": "SKILL.md",
      "size": 553,
      "sha256": "32f718ac6e9e6c92581740a46b82b55afffb3e70dc6908e511f9dbc42995f638",
      "kind": "instructions",
      "isText": true
    },
    {
      "path": "assets/table.css",
      "size": 22,
      "sha256": "9f55f2a7a4ccc9269efd3faec1175cdf96f0e3f4d08194a15d2aeb433b8a9938",
      "kind": "asset",
      "isText": true
    },
    {
      "path": "references/formats.md",
      "size": 60,
      "sha256": "55f3c4d7eda48795cffdca30627cf06673b4d81d04e020a28747719ccb7cbbe1",
      "kind": "reference",
      "isText": true
    },
    {
      "path": "scripts/extract.py",
      "size": 31,
      "sha256": "6efccdd49fe481cf7e5aa5c474b33b4de26aeae9f27f7fab826747ffd2a9f50e",
      "kind": "script",
      "isText": true
    },
    {
      "path": "scripts/legacy.py",
      "size": 25,
      "sha256": "497a7542470f4631d038fa474581ce2be98cbe274aa914fef0c718b48ca590d8",
      "kind": "script",
      "isText": true
    }
  ],
  "tokens": {
    "metadata": 32,
    "body": 62,
    "total": 94,
    "tokenizer": "approx-chars-4"
  },
  "references": {
    "declared": ["references/formats.md", "references/gone.md"],
    "resolved": ["references/formats.md"],
    "broken": ["references/gone.md"],
    "orphans": ["scripts/legacy.py"]
  },
  "size": {
    "total": 828,
    "byKind": {
      "instructions": 553,
      "reference": 60,
      "asset": 22,
      "script": 56,
      "readme": 48,
      "license": 89
    }
  },
  "digest": "sha256:0bdb5d9a41634803007d7dbc5869fd993f40e55de2cac6dbedf7bb9defce13f6",
  "diagnostics": [
    {
      "code": "allowed-tools-experimental",
      "severity": "warning",
      "message": "allowed-tools is experimental and support varies across agents.",
      "field": "allowed-tools"
    },
    {
      "code": "broken-ref",
      "severity": "warning",
      "message": "Referenced path does not exist in the skill.",
      "field": "references/gone.md",
      "hint": "Fix the path or remove the reference from SKILL.md."
    },
    {
      "code": "orphan-file",
      "severity": "warning",
      "message": "File is not reachable from SKILL.md through any chain of references.",
      "field": "scripts/legacy.py",
      "hint": "Reference it from SKILL.md (directly, or via a reachable doc or script) or remove it to keep the skill lean."
    }
  ]
}
```

## Field-by-field

### Versions

| Field             | Here                    | Meaning                                                                |
| ----------------- | ----------------------- | ---------------------------------------------------------------------- |
| `schemaVersion`   | `"1.0.0"`               | the **output contract** version — consumers key compatibility off this |
| `analyzerVersion` | `"0.1.0"`               | the library version that produced the output                           |
| `specVersion`     | `"agentskills-2025-12"` | which Agent Skills spec snapshot the validation rules encode           |

Three different versions because they evolve independently: the contract can be stable while the analyzer fixes bugs, and the checks can track a new spec without reshaping the output.

### `ok: true`

`true` ⇔ **no error-severity diagnostics remain** after `options.rules` overrides. Our three findings are all warnings, so `ok` stays `true` (and the CLI exits `0`). Severity is policy: run the same skill with `rules: { 'orphan-file': 'error' }` and `ok` flips to `false`.

### `dir: "pdf-tools"`

The skill root's folder name — `fromDir` sets it to the basename; `fromFiles` leaves it `null` unless you pass `{ dir }`. Used by the `name-dir-mismatch` check (here `name` matches, so no diagnostic).

### `frontmatter`

The normalized YAML between the `---` fences. Best-effort by design: even broken frontmatter yields a partial object plus diagnostics, never a crash.

- `name` / `description` — the resident metadata every harness loads. `null` when missing (each with an error diagnostic).
- `version: "1.2.0"` — **hoisted** from `metadata.version`, kept as a string (`"1.10"` survives without becoming `1.1`). Note it still appears inside `metadata` too — the hoist is a convenience copy, not a move.
- `license` — the raw declared value, verbatim.
- `allowedTools` — the spec's space-separated `allowed-tools` string split into an array. Declaring it at all earns the `allowed-tools-experimental` warning (support varies across agents).
- `metadata` — string→string map; non-string values are stringified with a `metadata-non-string` diagnostic.
- `extra: {}` — **every unknown frontmatter key lands here verbatim, never warned about**. Real-world skills carry harness-specific keys; the named fields plus `extra` reconstruct the complete frontmatter.

### `body`

The SKILL.md content after the closing fence. `null` when SKILL.md is missing entirely.

- `text` — the verbatim body (note the leading `\n` — nothing is trimmed; byte fidelity matters for the digest).
- `lines: 14` — `text.split('\n').length`.
- `headings` — the ATX outline (`depth` 1–6 + text), fence-aware: `#` inside code blocks is not a heading.

### `readme` and `license`

- `readme` — detected case-insensitively at the root (`README.md` / `README`); carries the full text (it's skill-specific display content). `null` + `readme-missing` warning when absent.
- `license` — identification only, in four fields:
  - `declared: "MIT"` — what frontmatter says, verbatim.
  - `spdx: "MIT"` — the recognized SPDX id, via two-tier classification: tier 1 matches `declared` against the allowlist; tier 2 scans the LICENSE file's first 20 lines for signature phrases.
  - `file: "LICENSE"` — the detected root-level license file (`LICENSE` / `LICENSE.txt` / `LICENSE.md` / `COPYING`).
  - `source: "frontmatter"` — which tier produced `spdx`. Here the frontmatter declaration won; a skill with only a recognizable LICENSE file gets `"file"`.
  - The license **text is deliberately not copied** into the output — texts aren't canonical per SPDX id (copyright lines, appendices vary). Read `license.file` from the tree when you need the bytes; its `sha256` is in `files[]`.
  - A custom/unrecognized `declared` value (e.g. `Proprietary-Internal`) is **not** a diagnostic — `spdx` just stays `null`.

### `files`

One entry per analyzed file, **sorted by path ascending** (every array in the output has a fixed order — that's part of the determinism guarantee).

- `size` — bytes; `sha256` — the true byte hash (hex, no prefix).
- `kind` — classified by convention: `SKILL.md` → `instructions`, detected README/LICENSE → `readme`/`license`, then by first directory segment: `scripts/` → `script`, `references/` → `reference`, `assets/` → `asset`, anything else → `other`.
- `isText` — UTF-8 validity probe; binary files get `false` and their bytes never leak into any text field.

Ignored paths (`.git`, `node_modules`, `__pycache__`, …) never appear. Files over `options.maxFileBytes` are excluded with a `file-too-large` warning.

### `tokens`

The skill's prompt-budget cost: `metadata: 32` (name + description — paid for **every** installed skill, always resident), `body: 62` (paid on activation), `total: 94`. README/LICENSE are never counted — they aren't prompt content. `tokenizer: "approx-chars-4"` records which tokenizer produced the numbers (inject your own via `options.tokenizer`; counts are not comparable across tokenizers).

### `references`

Two deliberately different techniques:

- `declared: [formats.md, gone.md]` — paths from **explicit markdown links** in the SKILL.md body only. Split against the real tree: `resolved` (exists) ∪ `broken` (doesn't — each gets a `broken-ref` warning). Direct-from-SKILL.md by contract.
- `orphans: [scripts/legacy.py]` — files **not reachable from SKILL.md through any chain of references**. The walk is transitive across markdown _and_ source files: here `SKILL.md` → backtick mention of `scripts/extract.py`, and `SKILL.md` → `references/formats.md` → `` `../assets/table.css` `` — so both are reachable and only `legacy.py` is flagged. Mentions count as paths (root- or file-relative, `./`-anchored), unique basenames, JS/TS import specifiers, Python `-m`/relative imports (with `__init__.py` package plumbing), and shell `$VAR`-anchored paths. See the README's "References" section for the complete matching rules and known limits.

### `size`

`total: 828` bytes across all analyzed files, plus `byKind` subtotals. Only kinds with at least one file appear, in a fixed enum order (`other` would come last) — byte-stable like everything else.

### `digest`

```
sha256:0bdb5d9a41634803007d7dbc5869fd993f40e55de2cac6dbedf7bb9defce13f6
```

The registry-facing **content identity** of the whole skill. Per-file content hashes are joined as a path-sorted manifest string and hashed again. The key property: SKILL.md's contribution is computed from `canonicalJSON(frontmatter minus metadata.version, sorted keys) + "\n" + body` — **not** the raw bytes — so:

- bumping only `metadata.version` → digest unchanged (a release is the same content),
- reformatting frontmatter without changing meaning → digest unchanged,
- changing one body character or any resource file → digest changes.

`files[].sha256` stays the true byte hash — the two are intentionally different. The README's "Digest" section is the normative definition. (Note: the digest covers the analyzed tree, so it varies with the `ignore` configuration.)

### `diagnostics`

Every finding as `{ code, severity, message, field?, hint? }`, sorted (stable order). `code` is the machine-stable identifier — match on it, not on message text. `field` carries the offending frontmatter key or file path; `hint` is the human fix suggestion. The full code registry with default severities is exported as `DIAGNOSTIC_REGISTRY` and tabulated in the README.

Severity here reflects library defaults **after** any `options.rules` overrides — `'off'` removes a diagnostic entirely, and `ok` is computed from what remains.

## Reproduce it

```bash
# Rebuild the tree above, then:
asa ./pdf-tools --json
```

Run it twice — the output is byte-identical, including the digest. That's the contract.
