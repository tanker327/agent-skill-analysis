/**
 * Unit tests for src/diagnostics.ts internal utilities.
 *
 * DiagnosticCollector and compareDiagnostics are NOT on the public surface
 * (index.ts only exports DIAGNOSTIC_REGISTRY and its types), so we import
 * them directly from the module here — this is the approved pattern for
 * unit-testing unexported pure utilities.
 */
import { describe, expect, it } from 'vitest';
import {
  compareDiagnostics,
  DiagnosticCollector,
  DIAGNOSTIC_REGISTRY,
} from '../src/diagnostics.js';

// ── DIAGNOSTIC_REGISTRY ────────────────────────────────────────────────────────

describe('DIAGNOSTIC_REGISTRY', () => {
  it('has at least the no-skill-md entry (P0 baseline)', () => {
    expect(DIAGNOSTIC_REGISTRY['no-skill-md']).toBeDefined();
    expect(DIAGNOSTIC_REGISTRY['no-skill-md'].defaultSeverity).toBe('error');
  });

  it('every entry has a non-empty message', () => {
    for (const [code, spec] of Object.entries(DIAGNOSTIC_REGISTRY)) {
      expect(spec.message, `code "${code}" has empty message`).toBeTruthy();
    }
  });
});

// ── DiagnosticCollector ────────────────────────────────────────────────────────

describe('DiagnosticCollector', () => {
  it('starts empty', () => {
    const c = new DiagnosticCollector();
    expect(c.all()).toHaveLength(0);
  });

  it('emit() adds a diagnostic with spec defaults', () => {
    const c = new DiagnosticCollector();
    c.emit('no-skill-md');
    const items = c.all();
    expect(items).toHaveLength(1);
    expect(items[0]?.code).toBe('no-skill-md');
    expect(items[0]?.severity).toBe('error');
    expect(items[0]?.message).toBe(DIAGNOSTIC_REGISTRY['no-skill-md'].message);
    expect(items[0]?.hint).toBe(DIAGNOSTIC_REGISTRY['no-skill-md'].hint);
  });

  it('emit() overrides message when provided', () => {
    const c = new DiagnosticCollector();
    c.emit('no-skill-md', { message: 'custom message' });
    expect(c.all()[0]?.message).toBe('custom message');
  });

  it('emit() sets field when provided', () => {
    const c = new DiagnosticCollector();
    c.emit('no-skill-md', { field: 'SKILL.md' });
    expect(c.all()[0]?.field).toBe('SKILL.md');
  });

  it('emit() does not set field when not provided', () => {
    const c = new DiagnosticCollector();
    c.emit('no-skill-md');
    expect(c.all()[0]?.field).toBeUndefined();
  });

  it('emit() overrides hint when provided', () => {
    const c = new DiagnosticCollector();
    c.emit('no-skill-md', { hint: 'custom hint' });
    expect(c.all()[0]?.hint).toBe('custom hint');
  });

  it('emit() preserves spec hint when no hint override', () => {
    const c = new DiagnosticCollector();
    const specHint = DIAGNOSTIC_REGISTRY['no-skill-md'].hint;
    c.emit('no-skill-md');
    // If the spec has a hint, it should appear; if not, it should be absent
    if (specHint !== undefined) {
      expect(c.all()[0]?.hint).toBe(specHint);
    } else {
      expect(c.all()[0]?.hint).toBeUndefined();
    }
  });

  it('all() returns items in emission order', () => {
    const c = new DiagnosticCollector();
    c.emit('no-skill-md', { message: 'first' });
    c.emit('no-skill-md', { message: 'second' });
    const items = c.all();
    expect(items[0]?.message).toBe('first');
    expect(items[1]?.message).toBe('second');
  });
});

// ── compareDiagnostics ─────────────────────────────────────────────────────────

describe('compareDiagnostics', () => {
  const err = (code: string, field?: string) => ({ severity: 'error' as const, code, field });
  const warn = (code: string, field?: string) => ({ severity: 'warning' as const, code, field });

  it('error sorts before warning', () => {
    expect(compareDiagnostics(err('a'), warn('a'))).toBeLessThan(0);
    expect(compareDiagnostics(warn('a'), err('a'))).toBeGreaterThan(0);
  });

  it('same severity: sorts by code alphabetically', () => {
    expect(compareDiagnostics(err('apple'), err('banana'))).toBeLessThan(0);
    expect(compareDiagnostics(err('banana'), err('apple'))).toBeGreaterThan(0);
    expect(compareDiagnostics(warn('x'), warn('y'))).toBeLessThan(0);
  });

  it('same severity and code: sorts by field (empty field first)', () => {
    expect(compareDiagnostics(err('c', undefined), err('c', 'file.md'))).toBeLessThan(0);
    expect(compareDiagnostics(err('c', 'file.md'), err('c', undefined))).toBeGreaterThan(0);
    expect(compareDiagnostics(err('c', 'a.md'), err('c', 'b.md'))).toBeLessThan(0);
  });

  it('completely equal diagnostics return 0', () => {
    expect(compareDiagnostics(err('x', 'f'), err('x', 'f'))).toBe(0);
    expect(compareDiagnostics(err('x'), err('x'))).toBe(0);
  });

  it('is stable for array.sort() — multiple diagnostics come out in deterministic order', () => {
    const diags = [
      warn('z-code', 'b.md'),
      err('a-code'),
      warn('a-code', 'a.md'),
      err('b-code'),
      warn('z-code', 'a.md'),
    ];
    const sorted = [...diags].sort(compareDiagnostics);
    expect(sorted.map((d) => `${d.severity}:${d.code}:${d.field ?? ''}`)).toEqual([
      'error:a-code:',
      'error:b-code:',
      'warning:a-code:a.md',
      'warning:z-code:a.md',
      'warning:z-code:b.md',
    ]);
  });
});
