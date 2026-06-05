/** Parsed frontmatter of a SKILL.md file. */
export interface SkillMetadata {
  name?: string;
  description?: string;
  /** Additional frontmatter fields not covered by the known keys. */
  [key: string]: unknown;
}

/** A parsed skill: frontmatter metadata plus the markdown body. */
export interface Skill {
  metadata: SkillMetadata;
  /** Markdown content after the frontmatter block. */
  body: string;
  /** The original raw file content. */
  raw: string;
}

export type Severity = 'info' | 'warning' | 'error';

/** A single issue or observation reported by an analyzer. */
export interface Finding {
  /** Name of the analyzer that produced this finding. */
  analyzer: string;
  severity: Severity;
  message: string;
}

/** The aggregated result of running analyzers against a skill. */
export interface AnalysisResult {
  findings: Finding[];
  /** Heuristic quality score from 0 (worst) to 100 (best). */
  score: number;
}

/** An analyzer inspects a skill and reports findings. */
export interface Analyzer {
  name: string;
  analyze(skill: Skill): Finding[];
}
