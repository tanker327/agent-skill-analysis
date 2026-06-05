# agent-skill-analysis

[![npm version](https://img.shields.io/npm/v/agent-skill-analysis.svg)](https://www.npmjs.com/package/agent-skill-analysis)
[![CI](https://github.com/tanker327/skill-analysis/actions/workflows/ci.yml/badge.svg)](https://github.com/tanker327/skill-analysis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Parse and analyze Claude Code / AI agent skills (`SKILL.md` files) for quality, structure, and triggering effectiveness.

## Installation

```bash
npm install agent-skill-analysis
```

Works with both ESM and CommonJS, Node.js >= 18.

## Usage

```ts
import { readFile } from 'node:fs/promises';
import { parseSkill, analyzeSkill } from 'agent-skill-analysis';

const content = await readFile('SKILL.md', 'utf8');

const skill = parseSkill(content);
// → { metadata: { name, description, ... }, body, raw }

const report = analyzeSkill(skill);
// → { findings: [{ analyzer, severity, message }], score: 0–100 }

for (const finding of report.findings) {
  console.log(`[${finding.severity}] ${finding.analyzer}: ${finding.message}`);
}
console.log(`Score: ${report.score}/100`);
```

### Custom analyzers

```ts
import { analyzeSkill, defaultAnalyzers, type Analyzer } from 'agent-skill-analysis';

const bodyLengthAnalyzer: Analyzer = {
  name: 'body-length',
  analyze(skill) {
    if (skill.body.length > 10_000) {
      return [
        {
          analyzer: 'body-length',
          severity: 'warning',
          message: 'Skill body is very long — consider splitting into reference files.',
        },
      ];
    }
    return [];
  },
};

const report = analyzeSkill(skill, [...defaultAnalyzers, bodyLengthAnalyzer]);
```

## API

| Export | Description |
| --- | --- |
| `parseSkill(content)` | Parse raw `SKILL.md` content into a `Skill` (frontmatter metadata + body). |
| `analyzeSkill(skill, analyzers?)` | Run analyzers and aggregate findings into an `AnalysisResult` with a 0–100 score. |
| `defaultAnalyzers` | The built-in analyzer set. |
| `descriptionAnalyzer` | Checks the description exists, fits length limits, and includes triggering guidance. |
| `structureAnalyzer` | Checks the name is kebab-case and the body is non-empty. |

Types: `Skill`, `SkillMetadata`, `Analyzer`, `AnalysisResult`, `Finding`, `Severity`.

> **Note:** frontmatter parsing currently handles flat `key: value` pairs only. Nested YAML support is on the roadmap.

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
