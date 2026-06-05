/**
 * Unit tests for src/body.ts — stage ⑥ body analysis.
 *
 * Stage ⑥ (flow §2): given the SKILL.md body text, produce:
 *   • lines      — total line count
 *   • headings   — ATX headings (delegates to markdown.ts with fence suppression)
 *   • bodyTokens — token count via the supplied tokenizer (or DEFAULT_TOKENIZER)
 *   • body-too-long / body-too-many-lines budget diagnostics
 *
 * Thresholds (approved 2026-06-05):
 *   BODY_LINE_LIMIT  = 500  → body-too-many-lines when lines  > 500 (warning)
 *   BODY_TOKEN_LIMIT = 4000 → body-too-long       when tokens > 4000 (warning)
 *
 * All threshold assertions import the constants rather than hardcoding the
 * numbers, so threshold changes propagate automatically to fixtures.
 *
 * Section 0: pure function unit tests (analyzeBody)
 * Section 1: integration tests via analyze() — body field of SkillAnalysis
 */
import { describe, expect, it } from 'vitest';
import { analyze, SkillAnalysisSchema } from '../src/index.js';
import { analyzeBody, BODY_LINE_LIMIT, BODY_TOKEN_LIMIT } from '../src/body.js';
import { DiagnosticCollector } from '../src/diagnostics.js';
import { mem } from './helpers.js';

// ── Section 0: Pure unit tests ────────────────────────────────────────────────

describe('analyzeBody — pure unit tests', () => {
  /**
   * Run analyzeBody with an optional always-N tokenizer and return the result
   * plus emitted diagnostic codes. Uses DEFAULT_TOKENIZER when no tokenizer given.
   */
  function run(text: string, tokenizerOverride?: { name: string; count: () => number }) {
    const collector = new DiagnosticCollector();
    const result = analyzeBody(text, collector, tokenizerOverride);
    return { result, codes: collector.all().map((d) => d.code) };
  }

  // ── Line counting ──

  describe('line counting', () => {
    it('empty body → 0 lines', () => {
      expect(run('').result.lines).toBe(0);
    });

    it('single line with no newline → 1 line', () => {
      expect(run('Just one line.').result.lines).toBe(1);
    });

    it('two lines separated by one newline → 2 lines', () => {
      expect(run('Line 1\nLine 2').result.lines).toBe(2);
    });

    it('three lines → 3 lines', () => {
      expect(run('Line 1\nLine 2\nLine 3').result.lines).toBe(3);
    });

    it('body with blank lines counts them', () => {
      // A blank line is still a line
      expect(run('Para 1\n\nPara 2').result.lines).toBe(3);
    });
  });

  // ── Heading extraction (delegates to markdown.ts) ──

  describe('heading extraction', () => {
    it('empty body → no headings', () => {
      expect(run('').result.headings).toEqual([]);
    });

    it('body with no ATX headings → empty headings array', () => {
      expect(run('Just prose, no headings here.').result.headings).toEqual([]);
    });

    it('single h1 heading', () => {
      expect(run('# Main Heading\n\nBody.').result.headings).toEqual([
        { depth: 1, text: 'Main Heading' },
      ]);
    });

    it('multiple headings of different depths in document order', () => {
      const text = '# Title\n\nParagraph.\n\n## Section\n\n### Sub-section\n\nMore text.';
      expect(run(text).result.headings).toEqual([
        { depth: 1, text: 'Title' },
        { depth: 2, text: 'Section' },
        { depth: 3, text: 'Sub-section' },
      ]);
    });

    it('# inside fenced code block is NOT a heading (F2)', () => {
      const text =
        '# Real Heading\n\n```bash\n# Shell comment — suppressed\n```\n\n## After Fence\n';
      expect(run(text).result.headings).toEqual([
        { depth: 1, text: 'Real Heading' },
        { depth: 2, text: 'After Fence' },
      ]);
    });

    it('unclosed fence: headings after opening fence are suppressed', () => {
      const text = '# Before\n\n```\n# Inside unclosed fence — suppressed\n';
      expect(run(text).result.headings).toEqual([{ depth: 1, text: 'Before' }]);
    });
  });

  // ── bodyTokens ──

  describe('bodyTokens (default tokenizer)', () => {
    it('empty body → 0 tokens', () => {
      expect(run('').result.bodyTokens).toBe(0);
    });

    it('non-empty body → positive token count', () => {
      expect(run('Some body text.').result.bodyTokens).toBeGreaterThan(0);
    });

    it('custom always-N tokenizer drives bodyTokens', () => {
      const always7 = { name: 'always-7', count: () => 7 };
      expect(run('any text', always7).result.bodyTokens).toBe(7);
    });
  });

  // ── Budget diagnostics ──

  describe('budget diagnostics', () => {
    it('normal-length body emits no budget diagnostics', () => {
      const text = '# Heading\n\nSome normal body text.\n';
      const { codes } = run(text);
      expect(codes).not.toContain('body-too-long');
      expect(codes).not.toContain('body-too-many-lines');
    });

    // ── body-too-many-lines ──

    it('body with exactly BODY_LINE_LIMIT lines → no body-too-many-lines', () => {
      // BODY_LINE_LIMIT = 500; split('\n').length must be ≤ 500 → no trigger.
      // Array(500).fill('x').join('\n') = 500 'x' with 499 '\n' → 500 parts.
      const text = Array(BODY_LINE_LIMIT).fill('x').join('\n');
      const { codes } = run(text);
      expect(codes).not.toContain('body-too-many-lines');
    });

    it('body with BODY_LINE_LIMIT + 1 lines emits body-too-many-lines (warning)', () => {
      // Array(501).fill('x').join('\n') = 501 parts → 501 > 500 → triggers.
      const text = Array(BODY_LINE_LIMIT + 1)
        .fill('x')
        .join('\n');
      const { codes, result } = run(text);
      expect(result.lines).toBe(BODY_LINE_LIMIT + 1);
      expect(codes).toContain('body-too-many-lines');
    });

    it('body-too-many-lines has severity warning', () => {
      const text = Array(BODY_LINE_LIMIT + 1)
        .fill('x')
        .join('\n');
      const collector = new DiagnosticCollector();
      analyzeBody(text, collector);
      const diag = collector.all().find((d) => d.code === 'body-too-many-lines');
      expect(diag?.severity).toBe('warning');
    });

    // ── body-too-long ──

    it('body at exactly BODY_TOKEN_LIMIT tokens → no body-too-long', () => {
      // Use an always-N tokenizer so the count is precise and deterministic.
      const atLimit = { name: 'at-limit', count: () => BODY_TOKEN_LIMIT };
      const { codes } = run('some text', atLimit);
      expect(codes).not.toContain('body-too-long');
    });

    it('body at BODY_TOKEN_LIMIT + 1 tokens emits body-too-long (warning)', () => {
      const overLimit = { name: 'over-limit', count: () => BODY_TOKEN_LIMIT + 1 };
      const { codes } = run('some text', overLimit);
      expect(codes).toContain('body-too-long');
    });

    it('body-too-long has severity warning', () => {
      const overLimit = { name: 'over-limit', count: () => BODY_TOKEN_LIMIT + 1 };
      const collector = new DiagnosticCollector();
      analyzeBody('any text', collector, overLimit);
      const diag = collector.all().find((d) => d.code === 'body-too-long');
      expect(diag?.severity).toBe('warning');
    });

    it('both budget limits exceeded → both diagnostics emitted', () => {
      const manyLines = Array(BODY_LINE_LIMIT + 1)
        .fill('x')
        .join('\n');
      const overToken = { name: 'over-all', count: () => BODY_TOKEN_LIMIT + 1 };
      const { codes } = run(manyLines, overToken);
      expect(codes).toContain('body-too-many-lines');
      expect(codes).toContain('body-too-long');
    });
  });
});

// ── Section 1: Integration via analyze() ──────────────────────────────────────

describe('body analysis via analyze()', () => {
  const FULL_SKILL =
    '---\nname: body-skill\ndescription: Body analysis integration test.\nmetadata:\n  version: "1.0.0"\n---\n\n# Main\n\nSome content.\n\n## Section\n\nMore content.';

  function codes(result: Awaited<ReturnType<typeof analyze>>): string[] {
    return result.diagnostics.map((d) => d.code);
  }

  it('body field is non-null for a skill with SKILL.md', async () => {
    const result = await analyze(mem({ 'SKILL.md': FULL_SKILL }));
    expect(result.body).not.toBeNull();
  });

  it('body.text contains the body content (post-fence)', async () => {
    const result = await analyze(mem({ 'SKILL.md': FULL_SKILL }));
    expect(result.body?.text).toContain('# Main');
    expect(result.body?.text).toContain('Some content.');
  });

  it('body.lines matches text.split("\\n").length', async () => {
    const result = await analyze(mem({ 'SKILL.md': FULL_SKILL }));
    const bodyText = result.body?.text ?? '';
    const expectedLines = bodyText === '' ? 0 : bodyText.split('\n').length;
    expect(result.body?.lines).toBe(expectedLines);
  });

  it('body.headings extracted from SKILL.md body', async () => {
    const result = await analyze(mem({ 'SKILL.md': FULL_SKILL }));
    expect(result.body?.headings).toEqual([
      { depth: 1, text: 'Main' },
      { depth: 2, text: 'Section' },
    ]);
  });

  it('body.headings: # inside fenced block is suppressed', async () => {
    const skill =
      '---\nname: fence-skill\ndescription: Fence test.\nmetadata:\n  version: "1.0.0"\n---\n\n# Real\n\n```python\n# Not a heading\n```\n\n## Also Real\n';
    const result = await analyze(mem({ 'SKILL.md': skill }));
    expect(result.body?.headings).toEqual([
      { depth: 1, text: 'Real' },
      { depth: 2, text: 'Also Real' },
    ]);
  });

  it('no-skill-md → body is null', async () => {
    const result = await analyze(mem({}));
    expect(result.body).toBeNull();
  });

  it('empty SKILL.md body (only frontmatter) → body.lines=0, no headings', async () => {
    const skill =
      '---\nname: empty-body\ndescription: Empty body test.\nmetadata:\n  version: "1.0.0"\n---\n';
    const result = await analyze(mem({ 'SKILL.md': skill }));
    if (result.body !== null) {
      expect(result.body.lines).toBe(0);
      expect(result.body.headings).toEqual([]);
    }
  });

  it('output passes SkillAnalysisSchema.parse()', async () => {
    const result = await analyze(mem({ 'SKILL.md': FULL_SKILL }));
    expect(() => SkillAnalysisSchema.parse(result)).not.toThrow();
  });

  // ── Budget integration tests ──

  it('body with > BODY_LINE_LIMIT lines emits body-too-many-lines in analyze()', async () => {
    const manyLines = Array(BODY_LINE_LIMIT + 2)
      .fill('x')
      .join('\n');
    const skill = `---\nname: manylines\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\n${manyLines}`;
    const result = await analyze(mem({ 'SKILL.md': skill }));
    expect(codes(result)).toContain('body-too-many-lines');
    expect(result.diagnostics.find((d) => d.code === 'body-too-many-lines')?.severity).toBe(
      'warning',
    );
  });

  it('body with > BODY_TOKEN_LIMIT tokens emits body-too-long in analyze()', async () => {
    // approx-chars-4: tokens = Math.ceil(chars / 4).
    // BODY_TOKEN_LIMIT * 4 + 4 chars → BODY_TOKEN_LIMIT + 1 tokens → triggers.
    const longBody = 'x'.repeat(BODY_TOKEN_LIMIT * 4 + 4);
    const skill = `---\nname: longbody\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\n${longBody}`;
    const result = await analyze(mem({ 'SKILL.md': skill }));
    expect(codes(result)).toContain('body-too-long');
    expect(result.diagnostics.find((d) => d.code === 'body-too-long')?.severity).toBe('warning');
  });

  it('body-too-long: ok stays true (warning, not error)', async () => {
    const longBody = 'x'.repeat(BODY_TOKEN_LIMIT * 4 + 4);
    const skill = `---\nname: longbody\ndescription: y.\nmetadata:\n  version: "1.0.0"\n---\n\n${longBody}`;
    const result = await analyze(mem({ 'SKILL.md': skill }));
    expect(result.ok).toBe(true); // warnings don't make ok=false
  });

  // ── Degradation matrix rows ──

  it('bad frontmatter (frontmatter-parse) → body is still analyzed (not null)', async () => {
    // Flow §6: frontmatter-parse does not skip ⑥ — body analysis still runs.
    const skill = '---\n: : invalid yaml : :\n---\n\n# Heading after bad yaml\n\nBody text.';
    const result = await analyze(mem({ 'SKILL.md': skill }));
    expect(result.body).not.toBeNull();
    expect(result.body?.headings).toEqual([{ depth: 1, text: 'Heading after bad yaml' }]);
  });

  it('no frontmatter fence → whole file is body, headings extracted', async () => {
    // When there's no --- fence, the whole SKILL.md text IS the body.
    const skill = '# Just Markdown\n\nNo frontmatter fence.\n\n## Section Two\n';
    const result = await analyze(mem({ 'SKILL.md': skill }));
    expect(result.body).not.toBeNull();
    expect(result.body?.headings).toEqual([
      { depth: 1, text: 'Just Markdown' },
      { depth: 2, text: 'Section Two' },
    ]);
  });
});
