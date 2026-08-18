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
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/was NOT reported outside it/);
  });

  it('fails when the sweep reached almost nothing', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: analyticsPopulation,
        pattern: /analytics/i,
        notThisDomain: [],
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
        sweepFloor: 20,
        plantIn: 'lib',
        plantName: 'analytics-cache.ts',
      }),
    ).toThrow(/the exclusion is doing nothing/);
  });

  it('fails a planted control that already exists on disk', () => {
    expect(() =>
      assertNothingOutsideDomainPopulation({
        population: analyticsPopulation,
        pattern: /analytics/i,
        notThisDomain: [],
        sweepFloor: 20,
        plantIn: 'db/schema',
        plantName: 'analytics.ts',
      }),
    ).toThrow(/already exists on disk/);
  });
});
