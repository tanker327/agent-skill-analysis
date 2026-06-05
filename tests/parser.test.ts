import { describe, expect, it } from 'vitest';
import { parseSkill } from '../src/parser.js';

const SKILL_MD = `---
name: my-skill
description: "Does something useful. Use when the user asks for it."
---

# My Skill

Follow these steps.
`;

describe('parseSkill', () => {
  it('parses frontmatter and body', () => {
    const skill = parseSkill(SKILL_MD);
    expect(skill.metadata.name).toBe('my-skill');
    expect(skill.metadata.description).toBe('Does something useful. Use when the user asks for it.');
    expect(skill.body).toContain('# My Skill');
    expect(skill.raw).toBe(SKILL_MD);
  });

  it('handles content without frontmatter', () => {
    const skill = parseSkill('# Just markdown\n');
    expect(skill.metadata).toEqual({});
    expect(skill.body).toBe('# Just markdown');
  });

  it('strips single quotes from values', () => {
    const skill = parseSkill("---\nname: 'quoted'\n---\nbody");
    expect(skill.metadata.name).toBe('quoted');
  });

  it('ignores nested and comment lines in frontmatter', () => {
    const skill = parseSkill('---\nname: top\nmetadata:\n  type: nested\n# comment: x\n---\nbody');
    expect(skill.metadata.name).toBe('top');
    expect(skill.metadata.type).toBeUndefined();
  });
});
