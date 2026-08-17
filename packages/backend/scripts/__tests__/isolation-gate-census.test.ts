/**
 * The census instrument's own bag-directory list (#593).
 *
 * `isolation-gate-census.ts` is what the whole #460 programme reads when
 * deciding which gates need converting, so a defect here is not one wrong row —
 * it is every row wrong in the same direction at once. It had three, all
 * silent, and they survived because two of them point OPPOSITE ways and cancel
 * in the aggregate.
 *
 * Four things are asserted, and the last is the only one that measures the
 * instrument's actual OUTPUT rather than its source text:
 *
 * 1. ONE spelling of the list (it was two literals, which is how they parted).
 * 2. Every listed directory is real and non-empty — a floor, so an entry that
 *    stops existing is loud instead of silently deriving nothing.
 * 3. A TRIPWIRE for a bag nobody listed, with its own vacuity floor.
 * 4. An end-to-end mutation over a synthetic tree: adding and removing a
 *    `db/schema/<domain>.ts` must move the derived count by exactly one, and a
 *    SECOND domain's schema module must never be derived.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SHARED_FLAT_DIRS } from '../isolation-gate-census.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'isolation-gate-census.ts');
const SRC = join(HERE, '..', '..', 'src');

/** Comment-stripped source, because this file's prose names the very literals it forbids. */
function strippedCensusSource(): string {
  return readFileSync(SCRIPT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('SHARED_FLAT_DIRS is spelled once', () => {
  /**
   * Keyed on the COUNT, not on the shape.
   *
   * The first version of this test matched an array literal starting
   * `['controllers', … 'routes'` — which is the legitimate `SHARED_FLAT_DIRS`
   * declaration, so the detector flagged its own subject and could never pass.
   * A detector cannot tell a legitimate value from its quarry by looking at the
   * value; it has to count uses. The defect was two spellings, so the
   * measurement is: each bag name occurs EXACTLY ONCE in the source.
   */
  const occurrences = (src: string, name: string): number =>
    src.split(`'${name}'`).length - 1;

  it.each(['controllers', 'routes', 'middleware', 'db/schema'])(
    "'%s' is written exactly once",
    (name) => {
      expect(occurrences(strippedCensusSource(), name)).toBe(1);
    },
  );

  it('SELF-TEST: a reintroduced second literal is counted', () => {
    const original = strippedCensusSource();
    const mutated = original.replace(
      'const SHARED_DIRS = new Set<string>(SHARED_FLAT_DIRS);',
      "const flat2 = ['controllers', 'routes', 'middleware'];",
    );
    // The mutation must have APPLIED, or the assertions below prove nothing.
    expect(mutated).not.toBe(original);
    for (const name of ['controllers', 'routes', 'middleware']) {
      expect(occurrences(original, name)).toBe(1);
      expect(occurrences(mutated, name)).toBe(2);
    }
  });
});

describe('every listed bag directory is real and carries modules', () => {
  // A floor. Seven today; a future removal should be a deliberate edit here.
  it('names at least seven directories', () => {
    expect(SHARED_FLAT_DIRS.length).toBeGreaterThanOrEqual(7);
  });

  it.each([...SHARED_FLAT_DIRS])('%s exists and holds .ts modules', (dir) => {
    const files = execFileSync('sh', ['-c', `ls ${join(SRC, dir)}/*.ts 2>/dev/null | wc -l`])
      .toString()
      .trim();
    expect(Number(files)).toBeGreaterThan(0);
  });

  it('does not list db, whose flat files are infrastructure rather than domains', () => {
    // `db/postgres.ts`, `db/migrate.ts`, `db/protectedColumns.ts` — named after
    // no domain, so slug-matching them would derive noise into every figure.
    expect([...SHARED_FLAT_DIRS]).not.toContain('db');
  });
});

describe('TRIPWIRE: a bag directory nobody listed', () => {
  /**
   * The half of the signal that discriminates: how many of a directory's
   * filenames are the LEAF NAME of some domain directory. `db/schema` scores 67
   * of 82; a real domain directory scores 0.
   *
   * It cannot see a `middleware`-shaped bag (2 of 70) — those are named after
   * concerns owning no directory — so this is a tripwire for the shape that
   * actually bit, not a derivation of the whole list. Stated, not implied.
   */
  const THRESHOLD = 10;

  function domainLeaves(): Set<string> {
    const out = execFileSync('sh', [
      '-c',
      `ls -d ${SRC}/services/*/ ${SRC}/db/*/ 2>/dev/null | sed 's|.*/\\([^/]*\\)/$|\\1|' | tr 'A-Z' 'a-z'`,
    ])
      .toString()
      .split('\n')
      .filter(Boolean);
    return new Set(out);
  }

  function bagScore(dir: string, leaves: Set<string>): number {
    const names = execFileSync('sh', [
      '-c',
      `ls ${join(SRC, dir)}/*.ts 2>/dev/null | xargs -r -n1 basename`,
    ])
      .toString()
      .split('\n')
      .filter(Boolean);
    return names.filter((n) => leaves.has(n.replace(/\..*$/, '').toLowerCase())).length;
  }

  function candidateDirs(): string[] {
    return execFileSync('sh', [
      '-c',
      `cd ${SRC} && find . -mindepth 1 -maxdepth 2 -type d -not -path '*/__tests__*' | sed 's|^\\./||'`,
    ])
      .toString()
      .split('\n')
      .filter(Boolean);
  }

  it('scores the known bags, so the tripwire is not measuring nothing', () => {
    const leaves = domainLeaves();
    // Vacuity floor + positive control: without this, a broken `bagScore` makes
    // every assertion below pass by finding no candidates at all.
    expect(leaves.size).toBeGreaterThan(50);
    expect(bagScore('db/schema', leaves)).toBeGreaterThanOrEqual(THRESHOLD);
    // And a negative control: a real domain directory must NOT score.
    expect(bagScore('db/payments', leaves)).toBeLessThan(THRESHOLD);
  });

  it('finds no scoring directory that is absent from the list', () => {
    const leaves = domainLeaves();
    const unlisted = candidateDirs().filter(
      (d) => !SHARED_FLAT_DIRS.includes(d as (typeof SHARED_FLAT_DIRS)[number]) && bagScore(d, leaves) >= THRESHOLD,
    );
    expect(unlisted).toEqual([]);
  });
});

describe('END TO END: a schema module moves the derived count by exactly one', () => {
  function buildTree(root: string, withWidgetSchema: boolean): void {
    const write = (rel: string, body: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    write('services/widget/engine.ts', 'export const a = 1;\n');
    write('services/widget/policy.ts', 'export const b = 2;\n');
    write('db/widget/widgetRepository.ts', 'export const c = 3;\n');
    write('controllers/widget.controller.ts', 'export const d = 4;\n');
    // A SECOND domain's schema module. It must never be derived for `widget` —
    // that is the over-report half, where `db/schema` was walked whole.
    write('db/schema/unrelated.ts', 'export const e = 5;\n');
    if (withWidgetSchema) write('db/schema/widget.ts', 'export const f = 6;\n');
    write(
      'services/widget/__tests__/widget-isolation.test.ts',
      [
        "const WIDGET_PATHS = ['services/widget/engine.ts', 'services/widget/policy.ts'];",
        'for (const p of WIDGET_PATHS) { void p; }',
      ].join('\n') + '\n',
    );
  }

  function derivedFor(root: string): { count: number; added: string[] } {
    const out = execFileSync('bun', ['run', SCRIPT, root], { encoding: 'utf8' });
    const match = out.match(/walk [^\n]*-> (\d+), \+(\d+) outside the list:\n([\s\S]*?)(?:\n\n|\n=)/);
    if (match === null) throw new Error(`census produced no bucket-A row:\n${out}`);
    return {
      count: Number(match[1]),
      added: (match[3] ?? '')
        .split('\n')
        .map((l) => l.replace(/^\s*\+\s*/, '').trim())
        .filter(Boolean),
    };
  }

  it('derives db/schema/<domain>.ts, and never another domain’s schema module', () => {
    const root = mkdtempSync(join(tmpdir(), 'census-with-'));
    try {
      buildTree(root, true);
      const { count, added } = derivedFor(root);
      expect(added).toContain('db/schema/widget.ts');
      expect(added).toContain('controllers/widget.controller.ts');
      // The over-report half: `db/schema` must be a BAG, not an owned walk.
      expect(added).not.toContain('db/schema/unrelated.ts');
      // 4, not 5: `db/widget/widgetRepository.ts` is NOT derived, because no
      // listed path lives under `db/widget`, so it never becomes an owned
      // directory. That is the instrument working as designed — the derivation
      // is taken from the array's OWN entries — and the first version of this
      // test asserted 5 by counting the files I had written rather than the
      // ones the rule reaches.
      expect(count).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('MUTATION: removing the schema module drops the count by exactly one', () => {
    const root = mkdtempSync(join(tmpdir(), 'census-without-'));
    try {
      buildTree(root, false);
      const { count, added } = derivedFor(root);
      expect(added).not.toContain('db/schema/widget.ts');
      // Exactly one fewer — not merely "different", which a broken parse gives.
      expect(count).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
