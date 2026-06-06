/**
 * Generates the JSON Schema artifact from the compiled SkillAnalysisSchema.
 * Called by tsup's onSuccess hook after each build so the artifact stays in sync.
 *
 * Written to TWO locations:
 *   • dist/skill-analysis.schema.json — ships in the npm package
 *   • skill-analysis.schema.json      — committed at the repo root, so contract
 *     changes show up in PR diffs and non-JS consumers can fetch it from GitHub
 *     without installing or building. An UNCONDITIONAL byte-match test
 *     (tests/properties.test.ts) fails CI if schema.ts changes without this
 *     file being regenerated — run `npm run build` to refresh it.
 *
 * Runs as a standalone Node.js ESM script (not compiled by tsup) so it always
 * imports the freshly built dist/index.js without module-cache interference.
 */
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { SkillAnalysisSchema } from '../dist/index.js';

const jsonSchema = z.toJSONSchema(SkillAnalysisSchema);
const content = JSON.stringify(jsonSchema, null, 2) + '\n';
writeFileSync('dist/skill-analysis.schema.json', content, 'utf-8');
writeFileSync('skill-analysis.schema.json', content, 'utf-8');
