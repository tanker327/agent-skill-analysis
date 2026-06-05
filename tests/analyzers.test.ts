import { describe, expect, it } from 'vitest';
import { analyzeSkill, parseSkill } from '../src/index.js';

const GOOD_SKILL = `---
name: good-skill
description: Formats SQL queries for readability. Use when the user pastes raw SQL.
---

# Good Skill

1. Read the query.
2. Format it.
`;

describe('analyzeSkill', () => {
  it('gives a clean skill a perfect score', () => {
    const result = analyzeSkill(parseSkill(GOOD_SKILL));
    expect(result.findings).toEqual([]);
    expect(result.score).toBe(100);
  });

  it('reports a missing description as an error', () => {
    const result = analyzeSkill(parseSkill('---\nname: no-desc\n---\nbody'));
    const errors = result.findings.filter((f) => f.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.analyzer).toBe('description');
    expect(result.score).toBeLessThan(100);
  });

  it('warns on non-kebab-case names', () => {
    const result = analyzeSkill(
      parseSkill('---\nname: My_Skill\ndescription: Does a thing. Use when needed.\n---\nbody'),
    );
    expect(result.findings.some((f) => f.analyzer === 'structure' && f.severity === 'warning')).toBe(
      true,
    );
  });

  it('reports an empty body as an error', () => {
    const result = analyzeSkill(
      parseSkill('---\nname: empty-body\ndescription: Does a thing. Use when needed.\n---\n'),
    );
    expect(result.findings.some((f) => f.message.includes('body is empty'))).toBe(true);
  });

  it('never scores below zero', () => {
    const result = analyzeSkill(parseSkill(''));
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
