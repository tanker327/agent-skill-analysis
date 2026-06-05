import type { Skill, SkillMetadata } from './types.js';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse the raw content of a SKILL.md file into a {@link Skill}.
 *
 * Frontmatter parsing is intentionally minimal (flat `key: value` pairs).
 * Skills with nested YAML frontmatter will have unrecognized lines ignored.
 */
export function parseSkill(content: string): Skill {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) {
    return { metadata: {}, body: content.trim(), raw: content };
  }

  const metadata = parseFrontmatter(match[1] ?? '');
  const body = content.slice(match[0].length).trim();
  return { metadata, body, raw: content };
}

function parseFrontmatter(block: string): SkillMetadata {
  const metadata: SkillMetadata = {};
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    // Skip indented (nested) keys and comments — flat keys only.
    if (!key || key.startsWith('#') || /^\s/.test(line)) continue;
    const value = stripQuotes(line.slice(separator + 1).trim());
    metadata[key] = value;
  }
  return metadata;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
