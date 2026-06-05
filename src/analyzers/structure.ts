import type { Analyzer, Finding } from '../types.js';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Checks naming conventions and that the skill body has usable content. */
export const structureAnalyzer: Analyzer = {
  name: 'structure',
  analyze(skill) {
    const findings: Finding[] = [];
    const name = skill.metadata.name;

    if (typeof name !== 'string' || name.trim() === '') {
      findings.push({
        analyzer: this.name,
        severity: 'error',
        message: 'Skill is missing a name in its frontmatter.',
      });
    } else if (!KEBAB_CASE.test(name)) {
      findings.push({
        analyzer: this.name,
        severity: 'warning',
        message: `Skill name "${name}" should be kebab-case (lowercase letters, digits, hyphens).`,
      });
    }

    if (skill.body === '') {
      findings.push({
        analyzer: this.name,
        severity: 'error',
        message: 'Skill body is empty — there are no instructions for the agent to follow.',
      });
    }

    return findings;
  },
};
