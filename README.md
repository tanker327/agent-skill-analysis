# agent-skill-analysis

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Deterministic structural analysis of AI-agent skill folders: give it a skill (a `SKILL.md` plus its resources) and get back **one self-describing `SkillAnalysis` JSON** — same tree in, byte-identical JSON out, every time.

The library answers, without you opening the folder: _what is this skill, what does it contain, what does it cost to load, and is it well-formed?_ It is vendor-neutral — no registry concepts, no harness-specific assumptions — so any consumer (a CLI, a registry service, a CI check) can build policy on top of it.

## What it produces

A single JSON document covering:

- **Frontmatter** — parsed, normalized, and validated against the Agent Skills spec. Unknown keys are **preserved in `frontmatter.extra`**, never warned about — real-world skills carry harness-specific keys (`context`, `model`, `hooks`, …) and rejecting them is a false positive, not rigor.
- **Body** — full text, line count, heading outline (code fences respected), and token estimates.
- **Docs** — README detection; LICENSE detection with two-stage SPDX recognition (frontmatter allowlist, then file-header signatures).
- **Files** — per-file manifest: `path`, `size`, `sha256` (true byte hash), `kind` (`instructions` / `reference` / `script` / `asset` / `readme` / `license` / `other`), `isText`.
- **References** — which files `SKILL.md` actually points at: `declared`, `resolved`, `broken`, and `orphans`.
- **Size** — total bytes plus a by-kind breakdown (resource weight vs instruction weight).
- **Digest** — a content fingerprint that ignores `metadata.version` bumps (authoritative definition below).
- **Diagnostics** — every problem becomes a `{ code, severity, message }` entry with a stable code; severity is overridable per consumer.

## Design principles

- **Deterministic** — no timestamps, no randomness, fixed sort order for every array. The same file tree produces byte-identical output, which makes the JSON snapshot-testable and usable as a content identity.
- **Never throws on content** — a broken skill (missing SKILL.md, invalid YAML, binary garbage) yields diagnostics, never an exception. The only rejection boundary is `SkillSource` IO: if a file can't be _read_, the whole `analyze()` rejects (a partial analysis would poison the digest).
- **Pure, portable JSON** — fully serializable, no class instances, no buffers; binary files surface only as `sha256` + `size`.
- **Self-describing** — `schemaVersion` versions the JSON shape (semver; consumers branch compatibility on it), `analyzerVersion` is this library's version, `specVersion` is a date-tagged snapshot of the Agent Skills spec the validation targets (e.g. `agentskills-2025-12` — the spec itself carries no version number, so we don't invent one).
- **Two runtime dependencies** — `yaml` and `zod`. Hashing is WebCrypto, markdown scanning is a hand-rolled line scanner, token counting is a built-in approximation. Runs on Node ≥ 20, Bun, Deno, browsers, and edge runtimes; only the optional `/node` subpath touches the filesystem.

## Usage

```ts
import { analyze, fromFiles } from 'agent-skill-analysis';
import { fromDir } from 'agent-skill-analysis/node';

// From disk (Node only — fromDir is the single fs-touching API,
// isolated behind the /node subpath so the core stays runtime-agnostic):
const analysis = await analyze(fromDir('./my-skill'));

// From memory (e.g. an unpacked tarball; works in any runtime):
const analysis2 = await analyze(
  fromFiles({
    'SKILL.md': '---\nname: my-skill\ndescription: …\n---\n\n# My Skill\n…',
    'references/guide.md': '…',
  }),
);

analysis.ok; // true iff no error-severity diagnostics remain
analysis.frontmatter; // name, description, version, allowedTools, metadata, extra
analysis.tokens; // { metadata, body, total, tokenizer }
analysis.references; // { declared, resolved, broken, orphans }
analysis.diagnostics; // [{ code: 'readme-missing', severity: 'warning', … }]
analysis.digest; // 'sha256:…' content fingerprint
```

`fromFiles` accepts a `Record` or `Map` of relative POSIX paths to `string | Uint8Array`, plus an optional `{ dir }` to simulate a named root folder. `fromDir(path)` lists regular files only (symlink policy belongs to your unpack/validation layer, not this library) and sets `dir` to the folder's basename — used by the `name-dir-mismatch` check, which is skipped for memory sources (`dir: null`).

### Options

```ts
const analysis = await analyze(source, {
  // Replaces the default ignore set (exported as DEFAULT_IGNORE — spread it to extend):
  ignore: [...DEFAULT_IGNORE, 'docs-internal'],

  // Files larger than this are skipped from hashing — never silently
  // (each one gets a file-too-large diagnostic):
  maxFileBytes: 10 * 1024 * 1024,

  // Severity policy per diagnostic code: 'error' | 'warning' | 'off'.
  rules: {
    'readme-missing': 'error', // promote
    'orphan-file': 'off', // silence
    'name-reserved': 'warning', // enable a default-off code
  },

  // Inject a real tokenizer (see Tokens below):
  tokenizer: myTokenizer,
});
```

**Severity is policy, not mechanism**: pipeline stages emit codes with library-default severities; your `rules` overrides are applied at the end, and `ok` is computed _after_ them. Promoting a warning to `error` flips `ok`; `'off'` removes the diagnostic entirely.

### CLI

The package ships an `asa` bin (Node only — it goes through `fromDir`):

```bash
asa ./my-skill          # pretty view: status, summary, body outline, files,
                        # references, diagnostics
asa ./my-skill --json   # the raw SkillAnalysis JSON (2-space indent), exactly
                        # as analyze() returns it
asa                     # no argument: prints usage and exits 2
                        # (use `asa .` to analyze the current directory)
```

Exit codes: `0` analyzed and `ok`, `1` analyzed but not `ok` (error-severity diagnostics remain), `2` usage or IO error. ANSI colors appear only on a TTY and respect [`NO_COLOR`](https://no-color.org); the `--json` output is the untouched contract — the pretty view is presentation only.

## Tokens

`tokens` quantifies the progressive-disclosure cost of the skill in three layers:

| Field             | Meaning                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `tokens.metadata` | `name` + `description` — the **resident** cost every installed skill pays in the prompt |
| `tokens.body`     | the SKILL.md body — the **activation** cost paid when the skill is selected             |
| `tokens.total`    | `metadata + body`                                                                       |

README, LICENSE, and resource files are deliberately **not** counted — they are displayed or loaded on demand, never part of the prompt budget.

The counter is pluggable. The default, `approx-chars-4` (≈ characters ÷ 4, rounded up), is dependency-free and deterministic but approximate. Inject a real one:

```ts
import type { Tokenizer } from 'agent-skill-analysis';

const tiktoken: Tokenizer = {
  name: 'js-tiktoken/cl100k_base', // surfaces as tokens.tokenizer in the output
  count: (text) => encoder.encode(text).length,
};

const analysis = await analyze(source, { tokenizer: tiktoken });
```

> **Caveat (R2):** token counts are **not comparable across tokenizers**. The output's `tokens.tokenizer` field records which counter produced the numbers — compare counts only between analyses with the same tokenizer name. Determinism holds per tokenizer: same tree + same tokenizer → same counts.

Budget diagnostics use the exported constants `BODY_TOKEN_LIMIT` (4,000 tokens → `body-too-long`) and `BODY_LINE_LIMIT` (500 lines, per Anthropic's skill-authoring guidance → `body-too-many-lines`). Both are warnings by default.

## Frontmatter notes

- **`allowedTools`** is parsed from the spec's space-separated `allowed-tools` string into a `string[]`. The parse is mildly lossy: re-joining with single spaces does not restore unusual whitespace in the original. The tarball/source remains the byte authority.
- **`frontmatter.version`** is `metadata.version` hoisted to the top level, kept as a string (`"1.10"` survives).
- **`frontmatter.extra`** holds every non-standard key verbatim. Named fields + `extra` = the complete frontmatter; there is no separate `raw` field.

## References — methodology and known false positives

The reference graph is built with two deliberately different techniques (F3):

- **`orphans` (low false-positive — the primary signal):** for each file that actually exists (SKILL.md/README/LICENSE excluded), check whether its relative path appears in the body — matched on path tokens/word boundaries, not bare substrings, so `a.md` doesn't match inside `data.md` (R4).
- **`broken` (high false-positive — warning only):** parse markdown link targets and inline-code path strings out of the body to get `declared`; `broken = declared − files`. Prose examples that merely _look_ like paths can land here, which is exactly why `broken-ref` is warning-severity and never flips `ok` by default.

Known limits (R4): glob patterns (`scripts/*.py`) and directory-level mentions (`see references/`) are not expanded — files referenced only that way will appear as orphans. If your skills use these patterns, consider `rules: { 'orphan-file': 'off' }`.

`declared = resolved ∪ broken`; all four arrays are sorted ascending.

## Diagnostics

Every code ships with a library-default severity; override any of them via `options.rules`. A `field` (the offending frontmatter field or file path) is attached where applicable. Output is sorted by `(severity, code, field)`.

| Code                         | Default | Emitted when                                                                           |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `no-skill-md`                | error   | no `SKILL.md` at the skill root (analysis still proceeds best-effort)                  |
| `frontmatter-parse`          | error   | the YAML block between the `---` fences is invalid                                     |
| `name-missing`               | error   | required `name` is absent                                                              |
| `name-too-long`              | error   | `name` exceeds 64 characters                                                           |
| `name-invalid`               | error   | `name` violates the charset (lowercase/digits/hyphens; no leading/trailing/double `-`) |
| `name-reserved`              | **off** | `name` is a reserved word — suppressed by default; enable via `rules`                  |
| `name-dir-mismatch`          | warning | `name` ≠ folder name (skipped when the source has no `dir`)                            |
| `description-missing`        | error   | required `description` is absent                                                       |
| `description-too-long`       | error   | `description` exceeds 1024 characters                                                  |
| `compatibility-too-long`     | warning | `compatibility` exceeds 500 characters                                                 |
| `metadata-non-string`        | error   | a `metadata` value isn't a string (it is stringified best-effort)                      |
| `version-missing`            | warning | `metadata.version` is not set                                                          |
| `allowed-tools-experimental` | warning | `allowed-tools` is present (support varies across agents)                              |
| `body-too-long`              | warning | body exceeds `BODY_TOKEN_LIMIT` (4,000) tokens                                         |
| `body-too-many-lines`        | warning | body exceeds `BODY_LINE_LIMIT` (500) lines                                             |
| `readme-missing`             | warning | no README in the skill folder                                                          |
| `license-missing`            | warning | neither `frontmatter.license` nor a LICENSE/COPYING file exists                        |
| `license-file-missing`       | warning | `frontmatter.license` is declared but no license file exists                           |
| `broken-ref`                 | warning | a referenced path doesn't exist in the tree (see false-positive note above)            |
| `orphan-file`                | warning | a file is present but never referenced from SKILL.md (see known limits above)          |
| `file-too-large`             | warning | a file exceeded `maxFileBytes` and was excluded from the manifest                      |

The full registry — including default messages and hints — is exported as `DIAGNOSTIC_REGISTRY`. A custom or unrecognized license is **not** a diagnostic: `license.spdx` stays `null` while `license.file`/`license.text` are still populated.

## Digest — the content fingerprint (authoritative definition)

`analysis.digest` is a deterministic fingerprint of the skill's content. **This section is the authoritative definition** (design decision R1): the implementation (`src/digest.ts`), its stability tests, and this text always change together — any behavioral change to the digest is a breaking (`arch`) change.

The design goal: **bumping only `metadata.version` must not change the digest** — a version-only release keeps the same content identity.

### Definition

```
digest = "sha256:" + sha256( manifestString )

manifestString = for each file, sorted by path ascending:
                   path + "\n" + contentHash + "\n"
                 …concatenated, then UTF-8 encoded
```

- Path sorting is UTF-16 code-unit lexicographic (JavaScript's default `Array.sort` string comparison). The `\n` separators are literal LF, never platform line endings.
- `contentHash` per file:
  - **`SKILL.md`** → `sha256( canonicalJSON(rawFrontmatter − metadata.version) + "\n" + body )`, UTF-8 encoded. `rawFrontmatter` is the object produced by parsing the raw YAML block (NOT the normalized `frontmatter` output field). A missing or unparseable YAML block → `{}`. Removing `metadata.version` is a no-op when `metadata` is absent or not an object; an emptied `metadata: {}` is kept, not deleted.
  - **Every other file** → its true byte hash — the same value as `files[].sha256`.

`files[].sha256` for `SKILL.md` is _intentionally different_ from the digest's SKILL.md content hash: the manifest entry is byte-faithful (version included), the digest input is normalized (version removed).

### Properties (each enforced by a stability test)

- **Version-bump invariance** — changing only `metadata.version` leaves the digest unchanged.
- **Content sensitivity** — changing a single body character (or any other file's bytes) changes the digest.
- **Format invariance (intentional side effect)** — frontmatter formatting-only changes (indentation, quote style, key order, flow vs block style) do NOT change the digest, because hashing goes through the parsed object via canonical JSON, never through raw YAML bytes or re-serialized YAML.

### canonicalJSON (normative — for cross-language reimplementation)

`canonicalJSON(value)` serializes to compact JSON with:

1. No whitespace between tokens.
2. Object keys sorted lexicographically on UTF-16 code units (JavaScript default string `<` comparison; NOT `localeCompare`, NOT Unicode normalization).
3. Key sorting applied recursively to every nested object.
4. String escaping per `JSON.stringify` semantics: solidus `/` NOT escaped; control characters below U+0020 `\u`-escaped; `"` and `\` use short escapes.
5. Number format: `JSON.stringify` output.
6. `null` → `null`; `true` → `true`; `false` → `false`.
7. Arrays: elements serialized recursively, order preserved.
8. `undefined`/function/symbol object values → key omitted (`JSON.stringify` parity).

### Edge semantics (explicitly defined)

- No `SKILL.md` in the tree → digest over the remaining files; no SKILL.md entry in the manifest string.
- YAML block absent or unparseable → `canonicalJSON({}) + "\n" + body`.
- Empty YAML block (`---\n---`) → parses to `null` → treated as `{}`.
- **Cyclic YAML anchors** (e.g. `a: &x\n  b: *x`) → the parsed object is projected to a JSON-safe value before serialization: a truly cyclic reference serializes as `null` at the point of revisit, with depth-first traversal in sorted-key order (matching canonicalJSON's key ordering). Non-cyclic shared anchors expand to their full values normally; merge keys (`<<`) are preserved literally as a `<<` key (not merged).
- **Non-finite numbers** (`.inf`/`.nan` from YAML) and `-0` follow `JSON.stringify` semantics: `Infinity` → `null`, `NaN` → `null`, `-0` → `0`.
- No files at all (empty tree after ignore and over-limit filtering) → `manifestString = ""` → `digest = sha256("")` = `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

### Caveat: the digest depends on the analysis configuration

Ignored files never enter the manifest, so **the same tree analyzed with a different `ignore` set (or a different `maxFileBytes`) produces a different digest**. Cross-party digest comparison requires identical configuration — the library's defaults are exported as `DEFAULT_IGNORE`. Files skipped as over-limit are excluded from the digest and flagged with a `file-too-large` diagnostic (never silently).

## Output contract

The whole shape is defined by a single zod schema, `SkillAnalysisSchema` — exported, with every TypeScript type inferred from it (`SkillAnalysis`, `Diagnostic`, `FileEntry`, …). A JSON Schema artifact is generated at build time for non-TypeScript consumers. The schema is the source of truth: output-shape changes always land together with a schema change.

- `schemaVersion` (`"1.0.0"`) — semver of the JSON shape; bumped on breaking shape **or digest-semantics** changes once published.
- `analyzerVersion` — this library's own version.
- `specVersion` (`"agentskills-2025-12"`) — the spec snapshot validation targets; bumped manually when the spec changes, recorded in the changelog.

## Development

```bash
npm install
npm test          # run tests
npm run lint      # lint
npm run typecheck # type-check
npm run build     # build ESM + CJS + types to dist/
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
