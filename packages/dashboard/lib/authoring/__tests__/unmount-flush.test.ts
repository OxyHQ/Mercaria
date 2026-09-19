/**
 * The draft is flushed when the wizard unmounts, and NOT on every keystroke.
 *
 * ## Why this is a source gate rather than a behaviour test
 *
 * `packages/dashboard` runs vitest with **no renderer** — no testing-library, no
 * react-test-renderer, no jsdom. Its test files are pure logic, so a React
 * effect's cleanup cannot be executed here. That is stated rather than skipped
 * quietly: the behaviour below is unverified by execution, and closing that
 * needs a renderer before it needs code.
 *
 * What IS checkable is the structure, and the structure is where the bug lives.
 *
 * ## The two failures this encodes, which pull in opposite directions
 *
 * The silent loss being fixed: the autosave debounce is a 1200 ms timer, and
 * navigating away inside the app cancels it, discarding the delta with no
 * warning — `beforeunload` covers only a browser unload, and there is no
 * in-app navigation guard anywhere in the repository.
 *
 * The tempting fix is to flush in the debounce effect's cleanup instead of
 * clearing it. **That is wrong and expensive.** The debounce effect lists
 * `signature` in its dependencies, and `signature` changes on every content
 * change — so its cleanup runs on every keystroke, and `clearTimeout` there IS
 * the debounce. Flushing there turns a bounded 1.2 s loss into one request per
 * character.
 *
 * So the fix has to distinguish an unmount from a re-schedule, which a single
 * effect cannot do. Hence two facts, asserted together because either alone is
 * satisfiable by the wrong implementation:
 *
 *   1. an unmount-only effect (EMPTY dependency array) whose cleanup saves, and
 *   2. the debounce effect's cleanup still only clears its timer.
 *
 * Adding a dependency to (1) is the regression that would reintroduce the
 * per-keystroke save while still passing a test that only looked for a flush.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HOOK = new URL('../use-draft-wizard.ts', import.meta.url).pathname;

function source(): string {
  return readFileSync(HOOK, 'utf8');
}

/** Comments are stripped: this module DISCUSSES both effects at length. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('the wizard flushes a pending save when it unmounts', () => {
  it('reads a real module, not an empty string', () => {
    // The vacuity floor. Every assertion below passes over `''`, and a path
    // that resolved wrong is exactly how that happens.
    const text = source();
    expect(text.length, `${String(text.length)} chars`).toBeGreaterThan(4000);
    expect(text).toContain('AUTOSAVE_DELAY_MS');
  });

  it('has an unmount-only effect — an EMPTY dependency array — that saves', () => {
    const code = stripComments(source());
    // `useEffect(() => () => { … }, [])` — a cleanup-only effect that never
    // re-runs. The empty array is the whole point: it is what makes the cleanup
    // an UNMOUNT rather than a re-schedule.
    const unmountEffect =
      /useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[\s*\]\s*,?\s*\)/.exec(code);
    expect(unmountEffect, 'no unmount-only effect (empty deps) found').not.toBeNull();

    const body = unmountEffect?.[0] ?? '';
    // It must save, and it must read through refs — an empty-deps effect closes
    // over the FIRST render, so a value read directly would be permanently stale.
    expect(body, 'the unmount effect does not save').toMatch(/saveNowRef\.current\s*\(/);
    expect(body, 'the unmount effect does not guard on dirtiness').toContain('dirtyRef.current');
  });

  it('leaves the debounce cleanup clearing its timer, never saving', () => {
    const code = stripComments(source());
    // The debounce effect is the one carrying AUTOSAVE_DELAY_MS. Its cleanup
    // fires on EVERY content change, so a save there is a save per keystroke.
    const debounce = /setTimeout\([\s\S]*?AUTOSAVE_DELAY_MS\s*\)\s*;([\s\S]*?)\}\s*,\s*\[/.exec(
      code,
    );
    expect(debounce, 'no debounced autosave found').not.toBeNull();

    const cleanup = debounce?.[1] ?? '';
    expect(cleanup, 'the debounce cleanup no longer clears its timer').toContain('clearTimeout');
    expect(cleanup, 'the debounce cleanup SAVES — that is one request per keystroke').not.toMatch(
      /saveNow/,
    );
  });

  it('reports a missing flush and a per-keystroke flush when given them (self-test)', () => {
    // The detectors, driven. Without this the cases above cannot tell "correct"
    // from "the patterns match nothing".
    const withDeps = 'useEffect(() => () => { void saveNowRef.current(); }, [dirty]);';
    expect(
      /useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[\s*\]\s*,?\s*\)/.test(withDeps),
      'a non-empty dependency array must not read as an unmount-only effect',
    ).toBe(false);

    const flushingDebounce = 'setTimeout(fn, AUTOSAVE_DELAY_MS);\n  return () => { void saveNow(); }\n}, [';
    const match = /setTimeout\([\s\S]*?AUTOSAVE_DELAY_MS\s*\)\s*;([\s\S]*?)\}\s*,\s*\[/.exec(
      flushingDebounce,
    );
    expect(match?.[1] ?? '', 'a saving debounce cleanup must be detected').toMatch(/saveNow/);
  });
});
