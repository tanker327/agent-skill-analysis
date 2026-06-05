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
