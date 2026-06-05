# Contributing to agent-skill-analysis

Thanks for your interest in contributing!

## Getting started

```bash
git clone https://github.com/tanker327/skill-analysis.git
cd skill-analysis
npm install
npm test
```

## Development workflow

1. Fork the repo and create a feature branch from `main`.
2. Make your changes, including tests for new behavior.
3. Make sure everything passes:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   npm run build
   ```
4. Open a pull request with a clear description of the change and motivation.

## Guidelines

- Keep the library zero-runtime-dependency where practical.
- New analyzers belong in `src/analyzers/` and should be exported from `src/analyzers/index.ts`.
- Public API changes need README updates.
- Follow the existing code style (Prettier + ESLint enforce most of it).

## Reporting bugs

Open an issue with a minimal reproduction — ideally the `SKILL.md` content that triggers the problem and the output you expected.
