import type { AnalysisResult, Analyzer, Finding, Skill } from '../types.js';
import { descriptionAnalyzer } from './description.js';
import { structureAnalyzer } from './structure.js';

export { descriptionAnalyzer } from './description.js';
export { structureAnalyzer } from './structure.js';

/** Analyzers run by {@link analyzeSkill} when none are specified. */
export const defaultAnalyzers: readonly Analyzer[] = [descriptionAnalyzer, structureAnalyzer];

const ERROR_PENALTY = 25;
const WARNING_PENALTY = 10;

/**
 * Run analyzers against a parsed skill and aggregate the findings into a
 * 0–100 quality score.
 */
export function analyzeSkill(
  skill: Skill,
  analyzers: readonly Analyzer[] = defaultAnalyzers,
): AnalysisResult {
  const findings: Finding[] = analyzers.flatMap((analyzer) => analyzer.analyze(skill));
  return { findings, score: scoreFindings(findings) };
}

function scoreFindings(findings: readonly Finding[]): number {
  const penalty = findings.reduce((total, finding) => {
    if (finding.severity === 'error') return total + ERROR_PENALTY;
    if (finding.severity === 'warning') return total + WARNING_PENALTY;
    return total;
  }, 0);
  return Math.max(0, 100 - penalty);
}
