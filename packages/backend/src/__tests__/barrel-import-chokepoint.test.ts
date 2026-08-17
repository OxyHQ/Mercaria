/**
 * A barrel re-export cannot be allowed to hide a forbidden import (#556).
 *
 * Every path-based isolation wall in this repository shares one detector shape:
 * it requires a directory SEGMENT before the module it forbids, so it matches
 * `from '../schema/referrals.js'` and matches NOTHING in `from '../schema/index.js'`.
 * `db/schema/index.ts` re-exports 79 sibling table modules, so a module that
 * imports the barrel reaches every domain in the schema while carrying no name
 * any census searches for.
 *
 * Measured before this gate existed: planting
 * `import { referralAttributions } from '../schema/referrals.js'` in
 * `db/retailReconciliation/adjustmentRepository.ts` turned
 * `retail-reconciliation-isolation.test.ts` RED on its referral wall; the SAME
 * symbol in the SAME file spelled `from '../schema/index.js'` passed **30/30
 * green**. Fourteen gates are fooled by this one barrel.
 *
 * ## Why this is a chokepoint and not fourteen widened detectors
 *
 * Widening a detector to also match `schema/index.js` fires on every module that
 * imports the barrel legitimately — which was all ten of them. So does the
 * two-hop path predicate "a guarded module imports a barrel that re-exports a
 * forbidden module": `export *` re-exports everything, so importing the barrel
 * always "reaches" everything and no path-level rule can separate a legitimate
 * importer from a violating one. The only predicate with no false positives is
 * symbol-level — resolve each named import through the barrel to its owning
 * module — and that has to be adopted by each of the fourteen gates separately.
 *
 * Removing the bypass instead makes every path-based wall barrel-proof by
 * construction, in one place, including the walls of gates nobody has written
 * yet. It is also the house rule (`~/AGENTS.md`: "no re-exports, barrel hacks or
 * compat shims — import from the owner") and the barrel's own docblock, which
 * names `drizzle.config.ts` and `db/postgres.ts` as its consumers.
 *
 * ## Nothing here is a hand list
 *
 * The barrels are DERIVED by walking for re-export density, and a barrel is
 * GUARDED only if it actually fools a detector belonging to a real gate — so
 * `lib/errors/index.ts` and `services/feed-import/parse/index.ts` (measured:
 * they fool nothing) stay unguarded and their documented reuse is untouched. A
 * barrel added tomorrow, or a detector added tomorrow that a barrel defeats,
 * brings itself under this gate with no edit here.
 *
 * Test files are deliberately out of the population: every gate in this
 * repository walks with `isFile()` or a `.ts` suffix filter at one directory
 * level, so `__tests__` is structurally excluded from all of them, and the
 * censuses that legitimately need the whole schema object are tests.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every import/export specifier in a source.
 *
 * The negated class must admit NEWLINES, and that is the whole reason this is
 * written out rather than reused from a gate: the first instrument built for
 * #556 used `[^;\n]*?`, which cannot cross a line, so every multi-line
 * `import {\n  a,\n  b,\n} from '...'` was invisible to it and it reported four
 * barrel importers where there were seven. Quotes and semicolons bound it
 * instead, which keeps it linear.
 */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^'";]*?from\s*['"]([^'"]+)['"]/g;

/** A re-export — the line a barrel is made of, and the line a wall cannot see. */
const RE_EXPORT =
  /(?:^|\n)\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"]/g;

/** A regex literal, as written in a gate's source. */
const REGEX_LITERAL = /\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+\/[gimsuyd]*/g;

function isTest(path: string): boolean {
  return path.includes('__tests__') || path.endsWith('.test.ts');
}

/** Every `.ts` under `src`, tests included — the partition happens at each use. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
    } else if (entry.name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

const ALL_FILES = walk(SRC_ROOT);
const MODULES = ALL_FILES.filter((path) => !isTest(path));
const GATES = ALL_FILES.filter((path) => path.endsWith('-isolation.test.ts'));

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function matches(pattern: RegExp, source: string): string[] {
  return [...source.matchAll(new RegExp(pattern.source, pattern.flags))].map((m) => m[1]);
}

/** Resolve a relative specifier to the file it actually names. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(fromFile), specifier);
  const candidates = base.endsWith('.js')
    ? [`${base.slice(0, -3)}.ts`]
    : [`${base}.ts`, join(base, 'index.ts'), base];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The barrels, derived                                                        */
/* -------------------------------------------------------------------------- */

interface Barrel {
  /** Absolute path of the barrel itself. */
  path: string;
  /** The modules it re-exports, as basenames. */
  targets: string[];
}

const BARRELS: Barrel[] = ALL_FILES.map((path) => ({
  path,
  targets: matches(RE_EXPORT, read(path)).map((specifier) =>
    specifier.replace(/^\.\//, '').replace(/\.js$/, ''),
  ),
}))
  .filter((barrel) => barrel.targets.length >= 2)
  .filter((barrel) => !isTest(barrel.path));

/* -------------------------------------------------------------------------- */
/* The detectors, derived from the real gates                                  */
/* -------------------------------------------------------------------------- */

interface Detector {
  gate: string;
  pattern: RegExp;
}

const DETECTORS: Detector[] = [];
/**
 * Candidates the literal scanner grabbed that are not regexes at all — a path
 * inside a string, a division. COUNTED rather than swallowed: a silent `catch`
 * here would let a systematic extraction change move detectors into this bucket
 * while the floor below still held, and the gate would go on measuring a
 * shrinking set of walls without saying so.
 */
let misSliced = 0;
for (const gate of GATES) {
  for (const literal of new Set(read(gate).match(REGEX_LITERAL) ?? [])) {
    if (!/from|import/.test(literal)) continue;
    const lastSlash = literal.lastIndexOf('/');
    try {
      DETECTORS.push({
        gate: relative(SRC_ROOT, gate),
        // `g`/`y` carry lastIndex between calls, which would make the same
        // detector answer differently on its second use.
        pattern: new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1).replace(/[gy]/g, '')),
      });
    } catch {
      misSliced += 1;
    }
  }
}

/**
 * Is this barrel able to defeat a real detector?
 *
 * The comparison is the defect itself: a specifier naming the TARGET against the
 * same specifier naming the BARREL. A detector that matches the first and not
 * the second is one an import through this barrel walks past.
 */
function detectorsFooledBy(barrel: Barrel): Detector[] {
  const directory = barrel.path.split('/').slice(-2, -1)[0];
  const parent = barrel.path.split('/').slice(-3, -2)[0];
  const barrelForms = [`../${directory}/index.js`, `../../${parent}/${directory}/index.js`];
  const fooled: Detector[] = [];
  for (const detector of DETECTORS) {
    const hitsBarrel = barrelForms.some((form) =>
      detector.pattern.test(`import { x } from '${form}';`),
    );
    if (hitsBarrel) continue;
    const hitsTarget = barrel.targets.some((target) =>
      [`../${directory}/${target}.js`, `../../${parent}/${directory}/${target}.js`].some((form) =>
        detector.pattern.test(`import { x } from '${form}';`),
      ),
    );
    if (hitsTarget) fooled.push(detector);
  }
  return fooled;
}

const GUARDED = BARRELS.filter((barrel) => detectorsFooledBy(barrel).length > 0);

/* -------------------------------------------------------------------------- */
/* Who may still import one                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The modules that need the whole schema OBJECT rather than a table, each with
 * the reason it cannot be spelled any other way. Both hand the namespace to
 * drizzle, so naming 79 modules would not even express what they do.
 */
const ALLOWED: { path: string; reason: string }[] = [
  { path: 'db/postgres.ts', reason: 'hands the namespace to drizzle() for the relational query API' },
  { path: 'services/graph-benchmark/runner.ts', reason: 'builds a benchmark client over the same namespace' },
];

function barrelImportsOf(file: string): Barrel[] {
  const source = read(file);
  const guardedPaths = new Set(GUARDED.map((barrel) => barrel.path));
  const hit: Barrel[] = [];
  for (const specifier of matches(SPECIFIER, source)) {
    const resolved = resolveSpecifier(file, specifier);
    if (resolved && guardedPaths.has(resolved) && resolved !== file) {
      const barrel = GUARDED.find((candidate) => candidate.path === resolved);
      if (barrel && !hit.includes(barrel)) hit.push(barrel);
    }
  }
  return hit;
}

const IMPORTERS = MODULES.filter((file) => barrelImportsOf(file).length > 0).map((file) =>
  relative(SRC_ROOT, file),
);

/* -------------------------------------------------------------------------- */

describe('the instrument reads a real tree', () => {
  it('walks the backend source', () => {
    // Floors per SHAPE, never one total: these three break independently, and a
    // single number lets one collapse to zero while the others carry it.
    expect(MODULES.length).toBeGreaterThanOrEqual(1400);
    expect(GATES.length).toBeGreaterThanOrEqual(70);
    expect(DETECTORS.length).toBeGreaterThanOrEqual(80);
    for (const gate of GATES.slice(0, 5)) expect(statSync(gate).isFile()).toBe(true);

    // Today: 121 compiled, 60 mis-sliced. The bound is what makes a change in
    // extraction VISIBLE — detectors quietly draining into the discard pile is
    // how this gate would come to guard fewer walls than it reports.
    expect(misSliced, 'the literal scanner is discarding far more than it did').toBeLessThanOrEqual(
      90,
    );
  });

  it('finds the barrels by shape, not by name', () => {
    expect(BARRELS.length).toBeGreaterThanOrEqual(3);
    const paths = BARRELS.map((barrel) => relative(SRC_ROOT, barrel.path));
    expect(paths).toContain('db/schema/index.ts');
  });

  it('reads a multi-line import (the shape that defeated the first instrument)', () => {
    // The positive control on the extractor's INPUT. A specifier regex that
    // cannot cross a newline reports fewer importers than exist, and a smaller
    // number is indistinguishable from a cleaner tree.
    const multiLine = "import {\n  alpha,\n  beta,\n} from '../schema/index.js';\n";
    expect(matches(SPECIFIER, multiLine)).toEqual(['../schema/index.js']);
  });
});

describe('a barrel is guarded only when it actually defeats a wall', () => {
  it('classifies the schema barrel as guarded', () => {
    // The vacuity floor for everything below: if this derivation broke, GUARDED
    // would be empty, no file could be an importer, and the chokepoint would
    // pass while measuring nothing.
    const guarded = GUARDED.map((barrel) => relative(SRC_ROOT, barrel.path));
    expect(guarded).toContain('db/schema/index.ts');
  });

  it('leaves a barrel that defeats nothing unguarded', () => {
    // `lib/errors/index.ts` and `feed-import/parse/index.ts` re-export within
    // their own module and no wall names what they carry. `parse/index.ts` is
    // documented as the reusable seam #66's Awin adapter calls, so flagging it
    // would be the noise that gets a gate disabled.
    const guarded = GUARDED.map((barrel) => relative(SRC_ROOT, barrel.path));
    expect(guarded).not.toContain('lib/errors/index.ts');
    expect(guarded).not.toContain('services/feed-import/parse/index.ts');
  });

  it('WOULD catch a barrel that defeats a wall (mutation self-test)', () => {
    // A synthetic barrel carrying a module a real detector forbids, run through
    // the same derivation. A `detectorsFooledBy` that stopped matching would
    // otherwise leave GUARDED empty and every assertion here green forever.
    const synthetic: Barrel = { path: join(SRC_ROOT, 'db', 'schema', 'index.ts'), targets: ['referrals'] };
    expect(detectorsFooledBy(synthetic).length).toBeGreaterThan(0);

    // And the negative control: a barrel carrying nothing any wall names is not
    // guarded, so the classifier is not simply answering yes.
    const inert: Barrel = { path: join(SRC_ROOT, 'db', 'schema', 'index.ts'), targets: ['zzz_no_wall_names_this'] };
    expect(detectorsFooledBy(inert)).toEqual([]);
  });
});

describe('nothing reaches a domain through a barrel', () => {
  it('is imported only by the modules that need the whole namespace', () => {
    const excused = ALLOWED.map((entry) => entry.path);

    const unexpected = IMPORTERS.filter((path) => !excused.includes(path));
    expect(
      unexpected.sort(),
      'imports a domain through a barrel, where every path-based isolation wall goes blind ' +
        "(#556). Import the owning module — `db/schema/<domain>.js` — instead. If this module " +
        'genuinely needs the whole namespace, add it to ALLOWED with the reason.',
    ).toEqual([]);

    // The other direction: an excused module that no longer imports a barrel
    // leaves an entry that excuses nothing, and the list stops describing the
    // tree. `keeps every exemption true` below is the sharper form of this.
    const departed = excused.filter((path) => !IMPORTERS.includes(path));
    expect(departed.sort(), 'is excused but imports no guarded barrel — remove the entry').toEqual(
      [],
    );
  });

  it('keeps every exemption true', () => {
    // An exemption is only safe while it is still TRUE. A module that stopped
    // importing the barrel is a stale excuse, and a stale excuse is what makes
    // the list above stop describing the tree.
    for (const entry of ALLOWED) {
      const path = join(SRC_ROOT, entry.path);
      expect(existsSync(path), `${entry.path} is excused and does not exist`).toBe(true);
      expect(
        barrelImportsOf(path).length,
        `${entry.path} is excused (${entry.reason}) but imports no guarded barrel`,
      ).toBeGreaterThan(0);
    }
  });

  it('WOULD catch an import through the barrel (mutation self-test)', () => {
    // The detector run against the exact line that passed 30/30 green before
    // this gate existed.
    const violation = join(SRC_ROOT, 'db', 'retailReconciliation', 'adjustmentRepository.ts');
    const source = read(violation);
    expect(source).not.toMatch(/from\s+'\.\.\/schema\/index\.js'/);

    const specifiers = matches(SPECIFIER, "import { referralAttributions } from '../schema/index.js';");
    expect(specifiers).toEqual(['../schema/index.js']);
    expect(resolveSpecifier(violation, specifiers[0])).toBe(join(SRC_ROOT, 'db', 'schema', 'index.ts'));
  });
});
