/**
 * Unit tests for src/markdown.ts — ATX heading scanner with fenced-block tracking.
 *
 * Design rule (plan §3 P2 / flow §2 stage ⑥ / decision F2):
 *   • ATX headings (`#`…`######` + space) are extracted from body text.
 *   • Lines inside a fenced code block (triple-backtick or triple-tilde) are
 *     suppressed — `#` there is code, not a heading.
 *   • `#` that appears inside an inline backtick span (` `#` `) is NOT
 *     suppressed — only block-level fences suppress, not inline code.
 *
 * Two exports are tested:
 *   • extractHeadings(text) — convenience wrapper (headings only)
 *   • scanMarkdown(text)    — full scan: headings + linkTargets + inlineCode
 *     (P4 references.ts consumes linkTargets + inlineCode; tests here ensure
 *     the extraction logic is correct and achieve line/branch coverage of the
 *     extractLinkTargets and extractInlineCode helpers.)
 */
import { describe, expect, it } from 'vitest';
import { extractHeadings, scanMarkdown } from '../src/markdown.js';

// ── ATX heading basics ────────────────────────────────────────────────────────

describe('ATX heading depths', () => {
  it('depth-1 heading', () => {
    expect(extractHeadings('# Hello\n')).toEqual([{ depth: 1, text: 'Hello' }]);
  });

  it('all depths 1–6 are recognized', () => {
    const text = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n';
    expect(extractHeadings(text)).toEqual([
      { depth: 1, text: 'H1' },
      { depth: 2, text: 'H2' },
      { depth: 3, text: 'H3' },
      { depth: 4, text: 'H4' },
      { depth: 5, text: 'H5' },
      { depth: 6, text: 'H6' },
    ]);
  });

  it('7 or more hashes is NOT a heading', () => {
    expect(extractHeadings('####### Not a heading\n')).toEqual([]);
  });

  it('# without a trailing space is NOT a heading', () => {
    expect(extractHeadings('#NoSpace\n')).toEqual([]);
  });

  it('heading text is right-trimmed', () => {
    // Trailing spaces on the heading line are stripped
    expect(extractHeadings('# Hello World   \n')).toEqual([{ depth: 1, text: 'Hello World' }]);
  });

  it('# not at the beginning of the line is NOT a heading', () => {
    expect(extractHeadings('  # Indented, not a heading\n')).toEqual([]);
    expect(extractHeadings('text # not a heading\n')).toEqual([]);
  });

  it('empty body → no headings', () => {
    expect(extractHeadings('')).toEqual([]);
  });

  it('body with no headings → empty array', () => {
    expect(extractHeadings('Just some body text.\nAnother paragraph.\n')).toEqual([]);
  });

  it('multiple headings are returned in document order', () => {
    const text = '# First\n\nParagraph.\n\n## Second\n\n### Third\n';
    expect(extractHeadings(text)).toEqual([
      { depth: 1, text: 'First' },
      { depth: 2, text: 'Second' },
      { depth: 3, text: 'Third' },
    ]);
  });

  it('heading with no trailing newline (EOF)', () => {
    expect(extractHeadings('# No newline at EOF')).toEqual([
      { depth: 1, text: 'No newline at EOF' },
    ]);
  });

  it('heading marker followed by only whitespace is NOT a heading', () => {
    // `# ` + spaces: HEADING_RE matches but stripHeadingTrail leaves empty text.
    expect(extractHeadings('#   \n')).toEqual([]);
  });
});

// ── Fenced code block suppression (F2) ───────────────────────────────────────

describe('fenced code block suppression (F2 — only fences suppress, not inline code)', () => {
  it('# inside triple-backtick fence is NOT a heading', () => {
    const text = '```\n# inside backtick fence\n```\n';
    expect(extractHeadings(text)).toEqual([]);
  });

  it('# inside triple-tilde fence is NOT a heading', () => {
    const text = '~~~\n# inside tilde fence\n~~~\n';
    expect(extractHeadings(text)).toEqual([]);
  });

  it('fence with language specifier: body content is still suppressed', () => {
    const text = '```typescript\n# not a heading\nconst x = 1;\n```\n# Real heading\n';
    expect(extractHeadings(text)).toEqual([{ depth: 1, text: 'Real heading' }]);
  });

  it('headings before and after a fence are both extracted', () => {
    const text = '# Before\n\n```\n# Inside — suppressed\n```\n\n# After\n';
    expect(extractHeadings(text)).toEqual([
      { depth: 1, text: 'Before' },
      { depth: 1, text: 'After' },
    ]);
  });

  it('multiple headings inside a fence are all suppressed', () => {
    const text = '```\n# H1 suppressed\n## H2 suppressed\n```\n# Real\n';
    expect(extractHeadings(text)).toEqual([{ depth: 1, text: 'Real' }]);
  });

  it('unclosed fence at EOF — everything after opening fence is suppressed', () => {
    // Fence opens but never closes — all content including headings is suppressed
    const text = '# Before fence\n\n```\n# Inside unclosed fence — suppressed\n# Also suppressed\n';
    expect(extractHeadings(text)).toEqual([{ depth: 1, text: 'Before fence' }]);
  });

  it('a closing fence indented 4+ spaces does NOT close the fence', () => {
    // Spec §4.5: a closing fence may be indented at most 3 spaces — 4+ is content.
    const text = '```\n    ```\n# still suppressed\n```\n# After\n';
    expect(extractHeadings(text)).toEqual([{ depth: 1, text: 'After' }]);
  });

  it('nested-looking backtick run: fence opened with ``` closes with ```', () => {
    // Inner ``` does NOT re-open a second fence — we stay in the existing fence
    // until the first bare ``` line that closes it.
    const text =
      '```\n# suppressed inside outer fence\n```still inside (lang specifier means this is content)\n# still suppressed\n```\n# After outer fence closed\n';
    // Opening ```, then a ``` with trailing text is content (not a closer because it has non-whitespace after),
    // then ``` (bare) closes the fence, then # is a heading.
    expect(extractHeadings(text)).toEqual([{ depth: 1, text: 'After outer fence closed' }]);
  });

  it('tilde fence closes with ~~~, not with ```', () => {
    // ``` does NOT close a ~~~ fence
    const text =
      '~~~\n# suppressed\n```\n# still suppressed — ``` does not close ~~~ fence\n~~~\n# Real heading\n';
    expect(extractHeadings(text)).toEqual([{ depth: 1, text: 'Real heading' }]);
  });
});

// ── Inline code does NOT suppress (F2 corollary) ──────────────────────────────

describe('inline backtick code spans do not suppress headings', () => {
  it('heading line with inline code is still a heading', () => {
    // The # is at the start of the line — it IS a heading; inline ` ` does not suppress
    const text = '# Heading with `inline code` inside\n';
    expect(extractHeadings(text)).toEqual([
      { depth: 1, text: 'Heading with `inline code` inside' },
    ]);
  });

  it('# inside an inline code span mid-line does not create a spurious heading', () => {
    // Line does NOT start with # — the inline `#` should not be extracted as a heading
    const text = 'Use the `# comment` syntax for Python.\n';
    expect(extractHeadings(text)).toEqual([]);
  });

  it('line starting with backtick-wrapped content is NOT a heading', () => {
    const text = '`# Not a heading` some trailing text\n';
    expect(extractHeadings(text)).toEqual([]);
  });

  it('heading with # inside inline code: the OUTER # still makes it a heading', () => {
    // The heading text includes the backtick-wrapped content verbatim
    const text = '## `#` is the comment character in Python\n';
    expect(extractHeadings(text)).toEqual([
      { depth: 2, text: '`#` is the comment character in Python' },
    ]);
  });
});

// ── Mixed content ─────────────────────────────────────────────────────────────

describe('mixed content (headings + prose + fences)', () => {
  it('realistic SKILL.md body excerpt', () => {
    const text = [
      '# Research Assistant',
      '',
      'Use this skill to run structured research.',
      '',
      '## Steps',
      '',
      '1. Clarify scope.',
      '2. Search:',
      '',
      '```bash',
      '# This is a shell comment, not a heading',
      'grep -r "pattern" ./src',
      '```',
      '',
      '## Output',
      '',
      'A cited brief.',
    ].join('\n');

    expect(extractHeadings(text)).toEqual([
      { depth: 1, text: 'Research Assistant' },
      { depth: 2, text: 'Steps' },
      { depth: 2, text: 'Output' },
    ]);
  });
});

// ── scanMarkdown: full scan (headings + linkTargets + inlineCode) ─────────────
//
// These tests cover the extractLinkTargets and extractInlineCode helpers which
// are private functions called by scanMarkdown. Lines 107-108 in markdown.ts
// (the extractLinkTargets while-loop body) are only reached when a [text](url)
// pattern matches — none of the extractHeadings tests above include links, so
// this section is required for 100% line/branch coverage.

describe('scanMarkdown — full scan result', () => {
  it('empty text → all arrays empty', () => {
    const scan = scanMarkdown('');
    expect(scan.headings).toEqual([]);
    expect(scan.linkTargets).toEqual([]);
    expect(scan.inlineCode).toEqual([]);
  });

  it('headings field matches extractHeadings result', () => {
    const text = '# Hello\n\n## World\n';
    expect(scanMarkdown(text).headings).toEqual(extractHeadings(text));
  });

  it('extracts a single link target from [text](url)', () => {
    const text = 'See [the guide](references/guide.md) for details.\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual(['references/guide.md']);
  });

  it('extracts multiple link targets from the same line', () => {
    const text = 'See [A](a.md) and [B](b.md) for more.\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual(['a.md', 'b.md']);
  });

  it('extracts link targets across multiple lines in document order', () => {
    const text = 'See [intro](intro.md).\n\nAlso [ref](refs/guide.md) and [faq](faq.md).\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual(['intro.md', 'refs/guide.md', 'faq.md']);
  });

  it('handles absolute URL link targets', () => {
    const text = 'Visit [docs](https://example.com/docs).\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual(['https://example.com/docs']);
  });

  it('handles fragment-only link targets (#id)', () => {
    const text = 'Jump to [section](#installation).\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual(['#installation']);
  });

  it('does NOT extract links inside a fenced code block', () => {
    const text = '```\nSee [inside-fence](suppressed.md)\n```\n[outside](real.md)\n';
    const scan = scanMarkdown(text);
    // Only the link outside the fence is extracted.
    expect(scan.linkTargets).toEqual(['real.md']);
  });

  it('extracts single-backtick inline code spans', () => {
    const text = 'Run `npm test` to execute tests.\n';
    const scan = scanMarkdown(text);
    expect(scan.inlineCode).toContain('npm test');
  });

  it('extracts double-backtick inline code spans', () => {
    const text = 'Use ``import { analyze }`` to import.\n';
    const scan = scanMarkdown(text);
    expect(scan.inlineCode).toContain('import { analyze }');
  });

  it('does NOT extract inline code from inside a fenced code block', () => {
    const text = '```\n`suppressed` inline code\n```\n`real` inline code\n';
    const scan = scanMarkdown(text);
    // Only the inline code outside the fence appears.
    expect(scan.inlineCode).toEqual(['real']);
  });

  it('linkTargets and inlineCode are both populated in the same scan', () => {
    const text =
      '# Overview\n\nRun `analyze()` to process.\n\nSee [guide](docs/guide.md) for details.\n';
    const scan = scanMarkdown(text);
    expect(scan.headings).toEqual([{ depth: 1, text: 'Overview' }]);
    expect(scan.linkTargets).toEqual(['docs/guide.md']);
    expect(scan.inlineCode).toContain('analyze()');
  });

  it('does NOT extract a link target written inside an inline code span (F6)', () => {
    // `[name](url)` inside backticks is documentation OF link syntax, not a real
    // link — its target must not leak into linkTargets (it would become a phantom
    // broken-ref). The span content is still captured in inlineCode.
    const text = 'Every citation is an inline markdown link `[name](url)`. Never raw.\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual([]);
    expect(scan.inlineCode).toContain('[name](url)');
  });

  it('still extracts a real link on the same line as an inline-code link (F6)', () => {
    // Masking only blanks the code span; a genuine link elsewhere on the line stays.
    const text = 'Format is `[name](url)` — see [the guide](docs/guide.md).\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual(['docs/guide.md']);
    expect(scan.inlineCode).toContain('[name](url)');
  });

  it('does NOT extract a link inside a double-backtick span (F6)', () => {
    const text = 'Use ``[text](path.md)`` to link.\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual([]);
    expect(scan.inlineCode).toContain('[text](path.md)');
  });

  it('multi-backtick span containing backticks does not leak a later backticked link (F18)', () => {
    // CommonMark: `` `x` `` is a 2-backtick span whose content holds single
    // backticks. The following `[t](url)` is itself a 1-backtick span and must be
    // masked too — its target must NOT leak as a link.
    const text = 'syntax: inline `` `x` ``, links `[t](url)`, done\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual([]);
  });

  it('an unclosed backtick run is literal and does not swallow the rest of the line (F18)', () => {
    // No closing fence for the lone backtick → it is literal; a real link after it
    // is still extracted.
    const text = 'price is 5 ` dollars, see [guide](docs/g.md)\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual(['docs/g.md']);
  });

  it('a different-length backtick run is skipped when seeking the closer (F18)', () => {
    // Opening `` (len 2); a single ` mid-content is not a valid closer; the trailing
    // `` closes. The contained [a](b) is masked, the later real link is kept.
    const text = '``code ` tick``  and  [real](r.md)\n';
    const scan = scanMarkdown(text);
    expect(scan.linkTargets).toEqual(['r.md']);
    expect(scan.inlineCode).toContain('code ` tick');
  });

  it('inline code on a heading line is captured in inlineCode array', () => {
    // The heading is still a heading (F2 corollary); inline code is also captured.
    const text = '## Use `#` for comments\n';
    const scan = scanMarkdown(text);
    expect(scan.headings).toEqual([{ depth: 2, text: 'Use `#` for comments' }]);
    expect(scan.inlineCode).toContain('#');
  });
});
