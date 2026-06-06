# Library usage — `agent-skill-analysis`

Deterministic structural analysis of AI-agent skill folders. One entry point:

```ts
analyze(source: SkillSource, options?: AnalyzeOptions): Promise<SkillAnalysis>
```

Same file tree in → byte-identical `SkillAnalysis` JSON out, every time. This page covers the JS/TS API in detail; for the `asa` command see [cli-usage.md](cli-usage.md), and for a fully annotated output see [output-example.md](output-example.md).

## Install

```bash
npm install agent-skill-analysis
```

- **Core entry (`agent-skill-analysis`)** is runtime-agnostic — no Node APIs, hashing via WebCrypto. Works in Node ≥ 20, Bun, Deno, and edge runtimes.
- **Node subpath (`agent-skill-analysis/node`)** holds the only filesystem code (`fromDir`). Import it only where Node's `fs` exists.
- Ships ESM **and** CJS with full type declarations; `require()` works the same as `import`.

## Quick start

### Analyze a folder on disk

```ts
import { analyze } from 'agent-skill-analysis';
import { fromDir } from 'agent-skill-analysis/node';

const analysis = await analyze(fromDir('./my-skill'));

console.log(analysis.ok); // true ⇔ no error-severity diagnostics
console.log(analysis.frontmatter.name); // "my-skill"
console.log(analysis.digest); // "sha256:…" — version-independent content identity
for (const d of analysis.diagnostics) {
  console.log(`${d.severity} ${d.code}: ${d.message}`);
}
```

### Analyze an in-memory tree (no disk, any runtime)

`fromFiles` accepts a `Record` or `Map` of **relative POSIX paths** to `string | Uint8Array`:

```ts
import { analyze, fromFiles } from 'agent-skill-analysis';

const analysis = await analyze(
  fromFiles({
    'SKILL.md': '---\nname: demo\ndescription: A demo.\n---\n\n# Demo\n',
    'references/guide.md': '# Guide',
    'assets/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // binary is fine
  }),
);
```

The optional second argument simulates a named root folder, which enables the `name-dir-mismatch` check (skipped when `dir` is absent):

```ts
fromFiles(files, { dir: 'demo' });
```

This is the preferred source for tests and services that already hold the skill bytes (e.g. an unpacked tarball) — no temp directories needed.

## Options

All options are validated at the door (`AnalyzeOptionsSchema`, strict — unknown keys reject):

```ts
const analysis = await analyze(source, {
  ignore: [...DEFAULT_IGNORE, 'dist'], // path-segment ignore set
  maxFileBytes: 1_000_000, // skip hashing files larger than this
  rules: { 'orphan-file': 'off' }, // severity overrides
  tokenizer: myTokenizer, // custom token counting
});
```

### `ignore: string[]`

A path is ignored when **any of its segments** matches an entry. The default set is conservative:

```ts
import { DEFAULT_IGNORE } from 'agent-skill-analysis';
// ['.git', '.hg', '.svn', 'node_modules', '__pycache__', '.DS_Store', 'Thumbs.db']
```

⚠️ `options.ignore` **replaces** the default set — spread `DEFAULT_IGNORE` to extend it. Note the digest varies with the ignore configuration: two parties comparing digests must use the same config.

### `maxFileBytes: number`

Files exceeding the limit are excluded from `files[]` and `size`, each with a `file-too-large` warning — never silently. They still participate in reference resolution (a link to an over-limit file is `resolved`, an unreferenced one is still an orphan candidate).

### `rules: Record<string, 'error' | 'warning' | 'off'>`

Severity is **policy, not mechanism**: every diagnostic code ships a library default, and `rules` lets the consumer override per code — `'off'` deletes the diagnostic entirely. `ok` is computed **after** overrides:

```ts
// Strict registry policy: orphans are fatal, version optional
const analysis = await analyze(source, {
  rules: {
    'orphan-file': 'error',
    'version-missing': 'off',
  },
});
// analysis.ok is now false if any orphan exists
```

The full code → default-severity registry is exported:

```ts
import { DIAGNOSTIC_REGISTRY } from 'agent-skill-analysis';
console.log(DIAGNOSTIC_REGISTRY['orphan-file'].defaultSeverity); // "warning"
```

### `tokenizer: { name: string, count(text: string): number }`

Token counts default to a chars/4 approximation (`approx-chars-4`). Inject a real tokenizer for accurate budgets — the output records which one produced the numbers (`tokens.tokenizer`), because counts are **not comparable across tokenizers**:

```ts
import { encoding_for_model } from 'tiktoken';

const enc = encoding_for_model('gpt-4o');
const analysis = await analyze(source, {
  tokenizer: {
    name: 'tiktoken-o200k',
    count: (text) => enc.encode(text).length,
  },
});
// analysis.tokens = { metadata, body, total, tokenizer: 'tiktoken-o200k' }
```

`tokens.metadata` is the resident cost (`name` + `description` — what a harness loads for every skill); `tokens.body` is the activation cost (the SKILL.md body). README and LICENSE are never counted — they aren't prompt budget.

## Reading the result

The full annotated output lives in [output-example.md](output-example.md). The shape in brief:

```ts
const a: SkillAnalysis = await analyze(source);

a.ok; // boolean — no error-severity diagnostics remain
a.frontmatter; // { name, description, version, license, compatibility, allowedTools, metadata, extra }
a.body; // { text, lines, headings } | null (null = SKILL.md missing)
a.readme; // { path, text } | null
a.license; // { declared, spdx, file, source } — text is NOT copied (read license.file)
a.files; // per-file { path, size, sha256, kind, isText }, sorted by path
a.tokens; // { metadata, body, total, tokenizer }
a.references; // { declared, resolved, broken, orphans }
a.size; // { total, byKind }
a.digest; // "sha256:…" — version-stripped content identity
a.diagnostics; // [{ code, severity, message, field?, hint? }], sorted
```

### Validating with the schema

The zod schema is the output contract and is exported (a generated JSON Schema is committed at the repo root as [`skill-analysis.schema.json`](../skill-analysis.schema.json) and ships in the package as `dist/skill-analysis.schema.json`):

```ts
import { SkillAnalysisSchema } from 'agent-skill-analysis';

SkillAnalysisSchema.parse(analysis); // throws ZodError on contract mismatch
```

### Useful exported constants

| Export                                | Meaning                                                |
| ------------------------------------- | ------------------------------------------------------ |
| `SCHEMA_VERSION`                      | output contract version (`schemaVersion` field)        |
| `ANALYZER_VERSION`                    | library version that produced the output               |
| `SPEC_VERSION`                        | the Agent Skills spec snapshot the checks encode       |
| `DEFAULT_IGNORE`                      | default ignore set (spread to extend)                  |
| `DEFAULT_TOKENIZER`                   | the chars/4 approximation                              |
| `BODY_TOKEN_LIMIT`, `BODY_LINE_LIMIT` | thresholds behind `body-too-long` / body-line warnings |
| `DIAGNOSTIC_REGISTRY`                 | every code → default severity/message/hint             |

All TypeScript types (`SkillAnalysis`, `Diagnostic`, `Frontmatter`, `FileEntry`, `AnalyzeOptions`, `Tokenizer`, `SkillSource`, …) are exported from the root entry.

## Guarantees

- **Deterministic.** Same tree → byte-identical `JSON.stringify(analysis)`. No clock, no randomness, no locale-dependent formatting; every array has a fixed sort order. Source enumeration order does not matter — paths are sorted on entry.
- **Never throws on content.** Broken YAML, cyclic anchors, binary files, pathological markdown — all become `{ code, severity, message }` diagnostics with stable codes. The **only** rejections are `SkillSource` IO failures and invalid `options`:

```ts
try {
  const analysis = await analyze(fromDir(path));
  // analysis always schema-valid here, even for a hopelessly broken skill
} catch (err) {
  // reachable only for IO errors (folder unreadable) or bad options
}
```

- **Digest ignores `metadata.version`.** `digest` is the registry-facing content identity: bumping only the version leaves it unchanged, while any body or resource change moves it. `files[].sha256` remains the true byte hash of each file — the two are intentionally different. See the README's "Digest" section for the normative definition.
- **Unknown frontmatter keys are preserved**, never warned about — they land verbatim in `frontmatter.extra` (real-world skills carry harness-specific keys).

## Implementing a custom `SkillSource`

Any object with this shape works — stream from S3, a tarball, a zip, anywhere:

```ts
import type { SkillSource } from 'agent-skill-analysis';

const source: SkillSource = {
  dir: 'my-skill', // or undefined — enables/skips name-dir-mismatch
  list: async () => ['SKILL.md', 'references/guide.md'], // relative POSIX paths
  read: async (path) => myStore.getBytes(path), // Uint8Array
};
```

`list()` order is irrelevant (sorted internally). `read()` may reject — that rejection propagates as the IO error described above.

## Recipes

### CI gate: fail the build on a broken skill

```ts
import { analyze } from 'agent-skill-analysis';
import { fromDir } from 'agent-skill-analysis/node';

const a = await analyze(fromDir(process.argv[2] ?? '.'), {
  rules: { 'broken-ref': 'error' }, // dead references are fatal for us
});
if (!a.ok) {
  for (const d of a.diagnostics.filter((d) => d.severity === 'error')) {
    console.error(`✗ ${d.code}${d.field ? ` [${d.field}]` : ''}: ${d.message}`);
  }
  process.exit(1);
}
```

### Registry dedupe: has the content actually changed?

```ts
const before = await analyze(fromFiles(oldTree));
const after = await analyze(fromFiles(newTree));
if (before.digest === after.digest) {
  // version-only bump (or formatting-only frontmatter change) — same content identity
}
```
