# agent-skill-analysis

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Deterministic analysis of AI agent skills: give it a skill folder, get back a single, self-describing `SkillAnalysis` JSON.

> **Status: early development.** The library is being rebuilt around the design below — the API shown is the target, not yet published. Docs will grow as the project does.

## What it does

Point it at a skill folder (on disk or in memory) and it produces one JSON document covering:

- **Frontmatter** — parsed, normalized, and validated against the Agent Skills spec; unknown keys are preserved, never rejected
- **Body** — line count, heading outline, token estimates for the progressive-disclosure budget (metadata / body / total)
- **Docs** — README detection, LICENSE detection with SPDX identification
- **Files** — per-file manifest with size, sha256, and kind (`instructions` / `reference` / `script` / `asset` / …)
- **References** — which files `SKILL.md` points at: resolved, broken, and orphaned
- **Digest** — a content fingerprint that ignores `metadata.version` bumps, so a version-only change keeps the same identity
- **Diagnostics** — every problem becomes a `{ code, severity, message }` entry with stable codes; severities are overridable by the consumer

## Design principles

- **Deterministic** — the same file tree always produces byte-identical JSON: no timestamps, no randomness, fixed ordering everywhere
- **Never throws on bad content** — a broken skill yields diagnostics, not exceptions; the only error boundary is file IO
- **Pure, portable JSON** — fully serializable, vendor-neutral, versioned with `schemaVersion`

## Planned usage

```ts
import { analyze, fromFiles } from 'agent-skill-analysis';
import { fromDir } from 'agent-skill-analysis/node';

// from disk
const analysis = await analyze(fromDir('./my-skill'));

// or from memory (e.g. an unpacked tarball)
const analysis2 = await analyze(fromFiles(files));

analysis.ok; // no error-level diagnostics
analysis.frontmatter; // name, description, version, extra keys, …
analysis.diagnostics; // [{ code: "readme-missing", severity: "warning", … }]
analysis.digest; // content fingerprint
```

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
