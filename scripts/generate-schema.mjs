/**
 * Generates dist/skill-analysis.schema.json from the compiled SkillAnalysisSchema.
 * Called by tsup's onSuccess hook after each build so the artifact stays in sync.
 *
 * Runs as a standalone Node.js ESM script (not compiled by tsup) so it always
 * imports the freshly built dist/index.js without module-cache interference.
 */
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { SkillAnalysisSchema } from '../dist/index.js';

const jsonSchema = z.toJSONSchema(SkillAnalysisSchema);
writeFileSync(
  'dist/skill-analysis.schema.json',
  JSON.stringify(jsonSchema, null, 2) + '\n',
  'utf-8',
);
