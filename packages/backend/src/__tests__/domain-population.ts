/**
 * ONE derivation of a DOMAIN's own population, for the isolation gates that
 * assert some domain cannot reach something.
 *
 * `ranking-surface.ts` is the same idea pointed the other way: it derives the
 * OUTSIDE a wall protects, shared by the eleven gates that scan it. This file
 * derives the INSIDE — the modules a wall is applied TO — and the reason it
 * exists is that the inside had three copied mistakes rather than one.
 *
 * ## The three defects, all measured on `8aea4a92`
 *
 * **1. A recursive `walk()` beside a one-level name sweep, in the same file.**
 * Twenty-seven gates pair
 *
 *     ...walk('services/<domain>')                       // recursive
 *     ...SHARED_DIRECTORIES.flatMap((directory) =>
 *         readdirSync(join(SRC_ROOT, directory))         // ONE LEVEL
 *           .filter((entry) => entry.isFile() && …)
 *
 * ten lines apart, so the gate reads as though it recurses throughout. It does
 * not: `routes/admin/` holds 23 modules and `controllers/admin/` holds 19, and
 * a name sweep written with `entry.isFile()` reaches none of them. Live, not
 * latent — `routes/admin/analytics.ts` was outside its own domain's wall until
 * #609, and `routes/admin/feeds.ts`, `routes/admin/fees.ts`,
 * `routes/admin/referral-partner.ts` and
 * `controllers/admin/pickup-admin.controller.ts` are the same shape.
 *
 * **2. The domain's own `db/schema/<domain>.ts` is not in the population.** The
 * four-name list `routes`, `controllers`, `middleware`, sometimes `routes/admin`
 * was copied from gate to gate and from `scripts/isolation-gate-census.ts`'s own
 * bag-directory list, and it carries no schema directory. So the tables a domain
 * owns — the one place a forbidden COLUMN would be declared — sat behind none of
 * its walls.
 *
 * **3. Neither of the first two is detectable from inside the gate.** Every
 * floor, every count and every mutation self-test stays green, because they all
 * measure the population the gate derived rather than the one it should have.
 *
 * ## So the remedy is the third function here, not the first two
 *
 * `walkOwnedDirectory` and `namedInSharedDirectories` close today's two gaps.
 * `assertNothingOutsideDomainPopulation` closes the CLASS: it sweeps the whole
 * of `src/` for paths naming the domain and requires each to be in the derived
 * population or in a counted exclusion. A bag directory nobody has invented yet
 * brings its modules under the wall with no edit in any gate.
 *
 * That is why the shared code lives here rather than being pasted twenty-five
 * times. `barrel-import-chokepoint.test.ts` is the precedent and the argument is
 * the same: fixing the next mechanism at the chokepoint covers gates nobody has
 * written yet, where fixing it in twenty-five copies covers the copies somebody
 * remembered to edit.
 *
 * ## What stays with each gate, deliberately
 *
 * The NAME pattern, the owned directories, the floors, the exclusions and their
 * reasons. Those are claims about one domain and there is no derivation that
 * could produce them — `docs/isolation-gates.md` §"Domain populations" is the
 * measured evidence that an instrument cannot tell a domain population from a
 * deliberately narrow subset. This file makes the TRAVERSAL uniform, and takes
 * no position on what belongs in it.
 */

import { expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The shape of a `readdirSync(…, { withFileTypes: true })` entry. */
export interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * A reader of one directory, RELATIVE to `src/`.
 *
 * Injected everywhere rather than called directly so a positive control can hand
 * a traversal a module that does not exist. Without that, every
 * `toEqual([])` in this file would be satisfied three ways — by a correct tree,
 * by a sweep that reached nothing, and by a population containing everything —
 * and only the first is what the gate means.
 */
export type DirectoryReader = (relative: string) => DirectoryEntry[];

export const readSrcDirectory: DirectoryReader = (relative) =>
  readdirSync(join(SRC_ROOT, relative), { withFileTypes: true });

/**
 * Join a parent to a child, correctly at the ROOT.
 *
 * `${relative}/${entry.name}` yields a LEADING SLASH when `relative` is `''`,
 * and `/app.ts` is in no population, matches no `startsWith` floor and equals no
 * excluded path — so a whole-tree sweep written that way reports every module in
 * `src/` as sitting outside the population. It fails loudly rather than
 * silently, which is the only reason it is a footnote here instead of a section.
 */
const childPath = (relative: string, name: string): string =>
  relative === '' ? name : `${relative}/${name}`;

/** Every `.ts` under `relative`, recursively, excluding the test tree. */
export function walkOwnedDirectory(
  relative: string,
  readDir: DirectoryReader = readSrcDirectory,
): string[] {
  const found: string[] = [];
  for (const entry of readDir(relative)) {
    if (entry.name === '__tests__') continue;
    const child = childPath(relative, entry.name);
    if (entry.isDirectory()) found.push(...walkOwnedDirectory(child, readDir));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/**
 * Every `.ts` under a SHARED directory whose PATH names the domain, RECURSIVELY.
 *
 * Two decisions, and both were bugs in the shape this replaces.
 *
 * **Recursively**, because `routes/admin/analytics.ts` is as much a module of
 * its domain as `routes/analytics.ts` and a one-level sweep reaches neither the
 * admin surface nor anything under a directory somebody adds next year.
 *
 * **The PATH, not the filename.** A module inside a directory named for the
 * domain names it nowhere in its own name; measured in #609, matching the
 * filename swept 10 of one domain's 29 modules. Matching the path costs nothing
 * here because no shared directory name (`routes`, `controllers`, `middleware`,
 * `db/schema`) carries a domain token — a domain whose name collides with one
 * of those would need its own narrowing, and would see it immediately as a
 * population full of strangers rather than as silence.
 */
export function namedInSharedDirectories(
  directories: readonly string[],
  pattern: RegExp,
  readDir: DirectoryReader = readSrcDirectory,
): string[] {
  const found: string[] = [];
  const sweep = (relative: string): void => {
    for (const entry of readDir(relative)) {
      if (entry.name === '__tests__') continue;
      const child = childPath(relative, entry.name);
      if (entry.isDirectory()) sweep(child);
      else if (entry.name.endsWith('.ts') && pattern.test(child)) found.push(child);
    }
  };
  for (const directory of directories) sweep(directory);
  return found.sort();
}

/** Every `.ts` under `src/` whose PATH names the domain. */
export function sweepSrcTreeForDomain(
  pattern: RegExp,
  readDir: DirectoryReader = readSrcDirectory,
): string[] {
  const found: string[] = [];
  const sweep = (relative: string): void => {
    for (const entry of readDir(relative)) {
      if (entry.name === '__tests__') continue;
      const child = childPath(relative, entry.name);
      if (entry.isDirectory()) sweep(child);
      else if (entry.name.endsWith('.ts') && pattern.test(child)) found.push(child);
    }
  };
  sweep('');
  return found.sort();
}

/**
 * A module that NAMES the domain and is not OF it.
 *
 * EXACT paths, never a prefix: a directory-shaped exclusion excuses everything
 * inside it forever, including the module somebody adds there tomorrow.
 */
export interface ForeignModule {
  /** The exact path, relative to `src/`. */
  readonly path: string;
  /** Why it is not a module of this domain. Read by a person, not by code. */
  readonly why: string;
}

export interface OutsidePopulationOptions {
  /**
   * The population every wall in the gate is applied to, as a FUNCTION of the
   * reader rather than a finished array.
   *
   * This is what makes the positive control below measure the wall rather than
   * the sweep. Handed the seeded reader, an over-broad derivation — one that walks
   * a whole bag directory, or `src/` itself — ABSORBS the planted module, and
   * the control then reports nothing outside the population and fires. A
   * finished array cannot express that: the plant is not on disk, so it is
   * outside any disk-derived population and the control passes whatever the
   * derivation does.
   */
  readonly population: (readDir: DirectoryReader) => string[];
  /** What a module of this domain is called, wherever it lives. */
  readonly pattern: RegExp;
  /** Domain-named modules that are deliberately NOT in the population. */
  readonly notThisDomain: readonly ForeignModule[];
  /**
   * A floor on what the SWEEP reached — never on the population.
   *
   * A traversal that reached nothing reports no module outside the population,
   * which is exactly what a correct tree reports. Set below today's count: a
   * floor set AT it is a pin wearing a floor's name, and makes "bump the number"
   * the cheapest green for the legitimate case (a module added tomorrow).
   */
  readonly sweepFloor: number;
  /**
   * A directory the sweep reaches, and a `.ts` name that does NOT exist in it.
   *
   * The planted module is the only thing that can distinguish a correct tree
   * from a population containing everything, and it is asserted absent from disk
   * so the control cannot quietly become an assertion about the real tree.
   */
  readonly plantIn: string;
  readonly plantName: string;
}

/**
 * The population's own defence: nothing named for this domain sits outside it.
 *
 * ONE comparison serves the wall and its control. Two spellings would let the
 * control pass while the wall went vacuous — measured in #609, where mutating a
 * wall's population to contain everything left all ten tests green because the
 * control computed a population of its own.
 */
export function assertNothingOutsideDomainPopulation(options: OutsidePopulationOptions): void {
  const { population, pattern, notThisDomain, sweepFloor, plantIn, plantName } = options;
  const excused = notThisDomain.map((entry) => entry.path);
  // ONE comparison, parameterised by the reader, serving the wall and its
  // control. Two spellings would let the control pass while the wall went
  // vacuous — measured in #609.
  const outsidePopulation = (paths: readonly string[], readDir: DirectoryReader): string[] => {
    const covered = new Set([...population(readDir), ...excused]);
    return paths.filter((relative) => !covered.has(relative));
  };

  const derived = population(readSrcDirectory);
  const swept = sweepSrcTreeForDomain(pattern);
  expect(
    swept.length,
    `the whole-tree sweep for ${pattern} found ${swept.length} modules — it cannot report one ` +
      'outside the population if it never reached one',
  ).toBeGreaterThanOrEqual(sweepFloor);
  expect(
    outsidePopulation(swept, readSrcDirectory),
    'a module naming this domain sits outside the scanned population, so none of the walls in ' +
      'this gate covers it — add its directory to the population, or excuse it in the ' +
      "gate's notThisDomain list with a reason and move its count",
  ).toEqual([]);

  // The exclusion's own count, in BOTH directions (#448): an exemption pointing
  // at a path the sweep never produces excuses nothing while looking like a
  // decision, and one that is ALSO in the population is doing nothing at all.
  for (const entry of notThisDomain) {
    expect(swept, `${entry.path} is excused but the sweep never reaches it`).toContain(entry.path);
    expect(
      derived,
      `${entry.path} is excused AND in the population — the exclusion is doing nothing`,
    ).not.toContain(entry.path);
    expect(entry.why.length, `${entry.path} is excused with no reason`).toBeGreaterThan(20);
  }

  // Every member of the population is a file that exists, so a listing that has
  // started returning stale or cached names goes red rather than handing the
  // walls paths that no longer resolve.
  for (const relative of derived) {
    expect(
      statSync(join(SRC_ROOT, relative)).isFile(),
      `${relative} is in the population but is not a file — did it move?`,
    ).toBe(true);
  }

  // The positive control, sharing the comparison above. Without it `toEqual([])`
  // is satisfied by a population containing everything, and the derivation is
  // re-run against the SEEDED reader so an over-broad one absorbs the plant and
  // fires here rather than passing.
  const planted = `${plantIn}/${plantName}`;
  expect(pattern.test(planted), `the planted control ${planted} does not match ${pattern}`).toBe(
    true,
  );
  expect(swept, 'the planted control already exists on disk').not.toContain(planted);
  const seededReader: DirectoryReader = (relative) =>
    relative === plantIn
      ? [
          ...readSrcDirectory(relative),
          { name: plantName, isDirectory: () => false, isFile: () => true },
        ]
      : readSrcDirectory(relative);
  const seeded = sweepSrcTreeForDomain(pattern, seededReader);
  expect(seeded, 'the sweep did not reach the planted control').toContain(planted);
  expect(
    outsidePopulation(seeded, seededReader),
    'a module the population does not cover was NOT reported outside it — either the wall above ' +
      'is satisfied by a population containing everything, or the derivation is broad enough to ' +
      'absorb a module nobody reviewed',
  ).toEqual([planted]);
}
