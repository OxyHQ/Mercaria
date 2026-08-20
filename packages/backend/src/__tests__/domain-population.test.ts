/**
 * The shared domain-population derivation, mutation-tested.
 *
 * Every gate that consumes `domain-population.ts` inherits its traversal, so a
 * fault here is a fault in twenty-five walls at once — which is the cost of a
 * chokepoint and the reason it carries the proofs the individual gates cannot.
 * Each test below drives a MUTATION of the mechanism it defends and asserts the
 * result changes, because a traversal that is merely CALLED is a traversal whose
 * correctness nobody measured.
 */

import { describe, expect, it } from 'vitest';
import {
  type DirectoryEntry,
  type DirectoryReader,
  assertDirectoriesAreFlat,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  sweepSrcTreeForDomain,
  walkOwnedDirectory,
} from './domain-population.js';

const file = (name: string): DirectoryEntry => ({
  name,
  isDirectory: () => false,
  isFile: () => true,
});
const directory = (name: string): DirectoryEntry => ({
  name,
  isDirectory: () => true,
  isFile: () => false,
});

describe('the shared-directory sweep recurses', () => {
  /**
   * The defect this file exists for, driven against the REAL tree.
   *
   * `routes/admin/analytics.ts` is a real module in a real subdirectory. The
   * one-level shape every gate carried — `readdirSync(dir).filter(isFile())` —
   * cannot produce it, and this asserts both halves so the test measures the
   * difference rather than merely observing that the new one works.
   */
  it('reaches a module the one-level shape cannot', () => {
    const recursive = namedInSharedDirectories(['routes'], /analytics/i);
    expect(recursive).toContain('routes/admin/analytics.ts');

    const oneLevel = readSrcDirectory('routes')
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .filter((entry) => /analytics/i.test(entry.name))
      .map((entry) => `routes/${entry.name}`);
    expect(
      oneLevel,
      'the one-level shape now reaches routes/admin — this test no longer measures anything',
    ).not.toContain('routes/admin/analytics.ts');
  });

  it('matches the PATH, so a module named nothing sits inside a domain directory', () => {
    const readDir: DirectoryReader = (relative) => {
      if (relative === 'routes') return [directory('pickup')];
      if (relative === 'routes/pickup') return [file('index.ts')];
      return [];
    };
    // The file is called `index.ts` and names the domain nowhere. Matching the
    // filename finds nothing; matching the path finds it.
    expect(namedInSharedDirectories(['routes'], /pickup/i, readDir)).toEqual([
      'routes/pickup/index.ts',
    ]);
  });

  it('skips the test tree, or a gate scans the probes it wrote itself', () => {
    const readDir: DirectoryReader = (relative) => {
      if (relative === 'routes') return [directory('__tests__'), file('widget.ts')];
      if (relative === 'routes/__tests__') return [file('widget.test.ts')];
      return [];
    };
    expect(namedInSharedDirectories(['routes'], /widget/i, readDir)).toEqual(['routes/widget.ts']);
  });
});

describe('the whole-tree sweep', () => {
  /**
   * The leading-slash trap, driven rather than described.
   *
   * `${relative}/${entry.name}` at the root yields `/app.ts`, which is in no
   * population and equals no excluded path — so the wall reports every module in
   * `src/` as outside the population. Asserting a root-level file comes back
   * WITHOUT a leading slash is what pins it.
   */
  it('names a root-level module without a leading slash', () => {
    const readDir: DirectoryReader = (relative) =>
      relative === '' ? [file('widget.ts'), directory('lib')] : [file('widget-cache.ts')];
    expect(sweepSrcTreeForDomain(/widget/i, readDir)).toEqual([
      'lib/widget-cache.ts',
      'widget.ts',
    ]);
  });

  it('reaches the real tree at a depth no gate lists', () => {
    // A vacuity floor on the sweep itself: `db/schema/` is two levels down and
    // is the directory whose absence from every gate's hand list is defect 2.
    const swept = sweepSrcTreeForDomain(/analytics/i);
    expect(swept).toContain('db/schema/analytics.ts');
    expect(swept).toContain('routes/admin/analytics.ts');
    expect(swept.length).toBeGreaterThanOrEqual(20);
  });
});

describe('walkOwnedDirectory', () => {
  it('recurses and takes only .ts', () => {
    const readDir: DirectoryReader = (relative) => {
      if (relative === 'services/widget') return [directory('parse'), file('a.ts'), file('a.sql')];
      if (relative === 'services/widget/parse') return [file('b.ts')];
      return [];
    };
    expect(walkOwnedDirectory('services/widget', readDir)).toEqual([
      'services/widget/parse/b.ts',
      'services/widget/a.ts',
    ]);
  });
});

describe('assertNothingOutsideDomainPopulation', () => {
  /**
   * The wall bites on the real tree: `db/schema/analytics.ts` and
   * `routes/admin/analytics.ts` are exactly the two shapes the copied gates
   * missed, so a population lacking either is reported.
   */
  const analyticsPopulation = (readDir: DirectoryReader): string[] => [
    ...walkOwnedDirectory('services/analytics', readDir),
    ...walkOwnedDirectory('db/analytics', readDir),
    ...namedInSharedDirectories(
      ['controllers', 'routes', 'middleware', 'db/schema'],
      /analytics/i,
      readDir,
    ),
  ];

  it('passes on a population that really covers the tree', () => {
    assertNothingOutsideDomainPopulation({
      population: analyticsPopulation,
      pattern: /analytics/i,
      notThisDomain: [],
      expectedExclusions: 0,
      sweepFloor: 20,
      plantIn: 'lib',
      plantName: 'analytics-cache.ts',
    });
  });

  it('reports a module the population drops — the schema shape', () => {
    const withoutSchema = (readDir: DirectoryReader): string[] =>
      analyticsPopulation(readDir).filter((relative) => relative !== 'db/schema/analytics.ts');
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: withoutSchema,
        pattern: /analytics/i,
        notThisDomain: [],
        expectedExclusions: 0,
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/db\/schema\/analytics\.ts/);
  });

  it('reports a module the population drops — the admin-subdirectory shape', () => {
    const withoutAdmin = (readDir: DirectoryReader): string[] =>
      analyticsPopulation(readDir).filter((relative) => relative !== 'routes/admin/analytics.ts');
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: withoutAdmin,
        pattern: /analytics/i,
        notThisDomain: [],
        expectedExclusions: 0,
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/routes\/admin\/analytics\.ts/);
  });

  /**
   * The mutation `docs/isolation-gates.md` §"An empty exclusion list needs a
   * positive control" names: a population containing EVERYTHING satisfies
   * `toEqual([])` exactly as a correct tree does, and only the planted module
   * tells them apart.
   */
  it('fails when the derivation is broad enough to absorb a module nobody reviewed', () => {
    // The realistic over-broad shape: walk a bag directory whole rather than
    // narrowing it by name. It covers every real module, so the wall passes —
    // and it ABSORBS the plant, which is what the control is for.
    const walksLibWhole = (readDir: DirectoryReader): string[] => [
      ...analyticsPopulation(readDir),
      ...walkOwnedDirectory('lib', readDir),
    ];
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: walksLibWhole,
        pattern: /analytics/i,
        notThisDomain: [],
        expectedExclusions: 0,
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/was NOT reported outside it/);
  });

  /**
   * The mutation `docs/isolation-gates.md` credits to #609 as the fix — and
   * which does NOT bite on the array-shaped control.
   *
   * Measured by `gatesA` on `main`: replacing a gate's wall population with
   * `new Set(swept)` leaves all ten of that gate's tests green, because a plant
   * that is absent from the REAL sweep reads as outside a sweep-derived
   * population exactly as it reads outside a correct one. Sharing the
   * comparison catches a population replaced by a LITERAL LIST and not one
   * built FROM the sweep.
   *
   * The reader-parameterised population is what closes it: the control
   * re-derives against the SEEDED reader, so a population defined as "whatever
   * the sweep found" absorbs the plant and the comparison fires. This asserts
   * the failure message is the CONTROL's, not an incidental one — a mutation
   * that throws for the wrong reason is not a measurement.
   */
  it('fails when the population IS the sweep — the shape that defeats a shared comparison', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: (readDir) => sweepSrcTreeForDomain(/analytics/i, readDir),
        pattern: /analytics/i,
        notThisDomain: [],
        expectedExclusions: 0,
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/was NOT reported outside it/);
  });

  /**
   * What the reader-parameterised control does NOT close, stated rather than
   * papered over — and why the remaining case is not the hazard it looks like.
   *
   * `gatesA` measured that replacing a wall's population with the SWEEP ITSELF
   * leaves every test green, and that is true here too: the plant is not on
   * disk, so it is outside a captured real sweep exactly as it is outside a
   * correct population, and no reader plumbing can see the difference.
   *
   * Reading what that state actually IS changes the verdict. A population equal
   * to "every module whose path names this domain" is not a narrowed population
   * — it is a reasonable one derived another way, and the gate's REAL walls go
   * on scanning the same set. What it makes tautological is only this meta-wall,
   * whose job is to catch a population that is too NARROW; and the narrow
   * direction is caught, by the tests above.
   *
   * So the honest statement is: this shape silences the meta-wall and cannot
   * hide a missing module from the walls that matter. It is left uncaught
   * deliberately, because the checks that would catch it (population != sweep)
   * fire on legitimate gates — every module of `ingestion` sits under an
   * ingestion-named path, so its population and its sweep ARE the same set.
   */
  it('a population equal to the sweep silences this wall — known, and named', () => {
    // Asserted so the limit is a measured fact in the suite rather than a
    // sentence in a docblock that nobody re-runs.
    assertNothingOutsideDomainPopulation({
      population: () => sweepSrcTreeForDomain(/analytics/i),
      pattern: /analytics/i,
      notThisDomain: [],
      expectedExclusions: 0,
      sweepFloor: 20,
      plantIn: 'lib',
      plantName: 'analytics-cache.ts',
    });
  });

  /**
   * The case the foreign-module clause exists for, and which the plant alone
   * does NOT catch: a population that swallowed the tree.
   */
  it('fails when the population swallows the tree — foreign modules are in it', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: (readDir) => walkOwnedDirectory('', readDir),
        pattern: /analytics/i,
        notThisDomain: [],
        expectedExclusions: 0,
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/belongs to another domain and is in this population/);
  });

  it('the foreign-module control refuses a path that no longer exists', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: analyticsPopulation,
        pattern: /analytics/i,
        notThisDomain: [],
        expectedExclusions: 0,
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
        foreignModules: ['controllers/orders.controller.ts', 'routes/cart.ts', 'routes/gone.ts'],
      }),
    ).toThrow(/no longer exists, so excluding it from the population proves nothing/);
  });

  it('fails when the sweep reached almost nothing', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: analyticsPopulation,
        pattern: /analytics/i,
        notThisDomain: [],
        expectedExclusions: 0,
        sweepFloor: 10_000,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/cannot report one outside the population/);
  });

  it('fails an exclusion the sweep never reaches', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: analyticsPopulation,
        pattern: /analytics/i,
        notThisDomain: [
          { path: 'services/analytics-that-never-existed.ts', why: 'a stale exemption, by construction' },
        ],
        expectedExclusions: 1,
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/the sweep never reaches it/);
  });

  it('fails an exclusion that is also in the population', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: analyticsPopulation,
        pattern: /analytics/i,
        notThisDomain: [
          { path: 'db/schema/analytics.ts', why: 'excused and covered at the same time' },
        ],
        expectedExclusions: 1,
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/the exclusion is doing nothing/);
  });

  /**
   * The parameter's own self-tests (#460).
   *
   * The three clauses beside it — reached by the sweep, absent from the
   * population, carries a reason — are each about an entry that EXISTS, so all
   * three pass for a list that has just GROWN. Nothing here could fail on the
   * one direction #448 is about until the count became a required argument, and
   * two callers could not express it at all because they pass the array inline.
   *
   * Both directions are asserted. An exclusion REMOVED is also a decision: the
   * module rejoins every wall in that gate, which is usually right and is never
   * something to discover from a passing build.
   */
  it('fails an exclusion list that GREW past its declared count', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: analyticsPopulation,
        pattern: /analytics/i,
        notThisDomain: [
          { path: 'db/schema/analytics.ts', why: 'a second entry nobody declared' },
        ],
        expectedExclusions: 0,
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/excuses 1 domain-named module\(s\) and declares 0/);
  });

  it('fails an exclusion list that SHRANK below its declared count', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: analyticsPopulation,
        pattern: /analytics/i,
        notThisDomain: [],
        expectedExclusions: 2,
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/excuses 0 domain-named module\(s\) and declares 2/);
  });

  it('fails a planted control that already exists on disk', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: analyticsPopulation,
        pattern: /analytics/i,
        notThisDomain: [],
        expectedExclusions: 0,
        sweepFloor: 20,
        plantIn: 'db/schema',
        plantName: 'analytics.ts',
      }),
    ).toThrow(/already exists on disk/);
  });
});

describe('assertDirectoriesAreFlat', () => {
  it('refuses an EMPTY directory list — the vacuity #691 shipped', () => {
    // Not a hypothetical. The inline version of this loop had no floor on its
    // array, and emptying that array left all 26 tests in the calling file
    // green. Under mutation the floor fires; this makes it fire under TEST, so
    // the guard is not merely present but exercised (a mechanism can be green
    // and inert).
    expect(() => assertDirectoriesAreFlat([])).toThrow(/cannot fail/);
  });

  it('refuses a directory that HOLDS a subdirectory, naming it', () => {
    const seeded: DirectoryReader = () => [
      { name: 'thing.ts', isDirectory: () => false, isFile: () => true },
      { name: 'admin', isDirectory: () => true, isFile: () => false },
    ];
    expect(() => assertDirectoriesAreFlat(['routes'], seeded)).toThrow(/grew a subdirectory/);
  });

  it('refuses a directory that lists NOTHING', () => {
    // The third way to be vacuous: a reader that returned an empty result reads
    // exactly like a flat directory.
    expect(() => assertDirectoriesAreFlat(['routes'], () => [])).toThrow(/listed nothing/);
  });

  it('passes a genuinely flat directory, so the three refusals above are not blanket', () => {
    const flat: DirectoryReader = () => [
      { name: 'thing.ts', isDirectory: () => false, isFile: () => true },
      { name: '__tests__', isDirectory: () => true, isFile: () => false },
    ];
    expect(() => assertDirectoriesAreFlat(['middleware'], flat)).not.toThrow();
  });
});
