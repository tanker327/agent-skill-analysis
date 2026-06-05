import type { Analyzer, Finding } from '../types.js';

/** Claude Code rejects skill descriptions longer than 1024 characters. */
const MAX_DESCRIPTION_LENGTH = 1024;
const MIN_DESCRIPTION_LENGTH = 20;

/**
 * Checks that the skill description exists, fits length limits, and contains
 * triggering hints ("use when ...") so agents know when to invoke the skill.
 */
export const descriptionAnalyzer: Analyzer = {
  name: 'description',
  analyze(skill) {
    const findings: Finding[] = [];
    const description = skill.metadata.description;

    if (typeof description !== 'string' || description.trim() === '') {
      findings.push({
        analyzer: this.name,
        severity: 'error',
        message: 'Skill is missing a description — agents cannot decide when to use it.',
      });
      return findings;
    }

    if (description.length > MAX_DESCRIPTION_LENGTH) {
      findings.push({
        analyzer: this.name,
        severity: 'error',
        message: `Description is ${description.length} characters; the maximum is ${MAX_DESCRIPTION_LENGTH}.`,
      });
    }

    if (description.length < MIN_DESCRIPTION_LENGTH) {
      findings.push({
        analyzer: this.name,
        severity: 'warning',
        message: 'Description is very short — add detail about what the skill does.',
      });
    }

    if (!/\buse (this|when|it)\b/i.test(description)) {
      findings.push({
        analyzer: this.name,
        severity: 'warning',
        message:
          'Description has no triggering guidance — add a "Use when ..." clause so agents know when to invoke it.',
      });
    }

    return findings;
  },
};
