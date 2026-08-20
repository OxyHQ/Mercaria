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
import { existsSync, readdirSync, statSync } from 'node:fs';
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
 * filename swept 10 of one domain's 29 modules.
 *
 * **The free-ness is a property of the DIRECTORIES, not of the pattern**, and
 * that distinction is load-bearing rather than pedantic. Matching the path costs
 * nothing for the four shared directories above because none of `routes`,
 * `controllers`, `middleware` or `db/schema` carries a domain token. It is NOT
 * free for a pattern that would match a SIBLING DOMAIN's directory: `gatesA`
 * reports that an unanchored `checkout` matched against the path pulls in
 * `services/retail-checkout/*` and `services/payments/checkout-payment.service.ts`,
 * so its `checkout-contact` gate keeps an anchored FILENAME rule and stays out
 * of this helper deliberately.
 *
 * So before passing a pattern here, ask what it matches over a PATH rather than
 * over a name. A domain whose token appears inside a sibling's directory name
 * needs an anchor (`seo`, `reviews` — see their gates) or needs to keep its own
 * filename rule. The failure is loud either way — a population full of
 * strangers rather than silence — but it is cheaper to see it here.
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
 * Real modules belonging to the COMMERCE CORE, foreign to every domain that has
 * a gate here — the control that catches a population containing everything.
 *
 * This exists because the reader-parameterised control below is NOT sufficient
 * on its own, and I claimed it was. Measured: a population expression that USES
 * the reader it is handed (`(readDir) => sweepSrcTreeForDomain(p, readDir)`)
 * absorbs the plant and fires, as intended — but one that IGNORES it
 * (`() => sweepSrcTreeForDomain(p)`, capturing the REAL sweep) does not, because
 * the plant is not on disk and so is outside the captured sweep exactly as it is
 * outside a correct population. `gatesA` found the same hole in the array-shaped
 * control on `main` and its remedy is this one.
 *
 * A plant that does not exist can only ever prove the comparison is not
 * degenerate. A REAL module that exists and belongs elsewhere proves the
 * population did not swallow the tree — and it works whatever the reader
 * plumbing does, because it never goes through the reader at all.
 *
 * Each is asserted to EXIST: without that the clause goes vacuous the day
 * somebody renames the file, and excluding a path that is not there proves
 * nothing.
 */
export const FOREIGN_CONTROL_MODULES = [
  'controllers/orders.controller.ts',
  'routes/cart.ts',
  'db/schema/orders.ts',
  'middleware/auth.ts',
] as const;

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
   * How many exclusions there are supposed to be. REQUIRED, and `0` where the
   * list is empty.
   *
   * ## Why the count is a parameter rather than each gate's own line
   *
   * The three assertions below already hold every exclusion to something — it is
   * REACHED by the sweep, it is ABSENT from the population, and it carries a
   * reason. All three are about an entry that EXISTS. None of them notices an
   * entry being ADDED, which is the direction #448 is about: an excusing entry
   * is a predicate, not an identity, so a list with no count lets a module be
   * excused without anybody deciding to.
   *
   * Twelve callers had worked that out and written `expect(X.length).toBe(N)` by
   * hand. Two could not: they pass `notThisDomain` INLINE, so there is no
   * identifier to take a `.length` of and no pin was expressible at all. That is
   * the tell that this belongs at the chokepoint — a rule whose observance
   * depends on the caller's array having been given a name is not a rule.
   *
   * REQUIRED rather than optional for the same reason `assertDirectoriesAreFlat`
   * takes its floor rather than defaulting one: an optional count is omitted by
   * exactly the caller who needed it. Forty-two of the fifty-four call sites pass
   * `0`, which is trivially true and states out loud that the gate excuses
   * nothing — a fact worth reading in the call.
   */
  readonly expectedExclusions: number;
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
  /**
   * Real, EXISTING modules of other domains that must stay OUT of the
   * population. Defaults to the commerce-core set above; override only where a
   * domain legitimately owns one of them.
   */
  readonly foreignModules?: readonly string[];
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

  // The count, FIRST, because it is the only clause here that can fail on an
  // entry somebody ADDED — every assertion below is about an entry that already
  // exists, and each of them passes for a list that has just grown.
  expect(
    notThisDomain.length,
    `this gate excuses ${notThisDomain.length} domain-named module(s) and declares ` +
      `${options.expectedExclusions}. An excusing entry is a predicate rather than an identity ` +
      '(#448): if the new exclusion is right, move `expectedExclusions` in the same diff, which ' +
      'is the decision being recorded rather than a line that appeared',
  ).toBe(options.expectedExclusions);
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

  // The clause that catches a population containing everything, and it does not
  // go through the reader — so it holds even when the population expression
  // ignores the one it is handed, which is the case the plant below cannot see.
  const foreign = options.foreignModules ?? FOREIGN_CONTROL_MODULES;
  expect(foreign.length, 'the foreign-module control is empty, so it cannot fail').toBeGreaterThan(
    2,
  );
  for (const other of foreign) {
    expect(
      existsSync(join(SRC_ROOT, other)) && statSync(join(SRC_ROOT, other)).isFile(),
      `${other} no longer exists, so excluding it from the population proves nothing`,
    ).toBe(true);
    expect(
      derived,
      `${other} belongs to another domain and is in this population — the derivation has ` +
        'widened to swallow modules nobody reviewed',
    ).not.toContain(other);
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

/**
 * Every directory in `directories` has NO subdirectory — the LATENT half of
 * #668, asserted rather than assumed.
 *
 * A gate may legitimately read a directory one level deep when that directory
 * cannot contain another. That is a claim about the tree, and it goes stale
 * silently: the reader keeps returning names, the floors keep being met, and the
 * modules inside the new subdirectory were never in the population to begin
 * with. This makes the claim fail the build on the day it stops being true.
 *
 * ## It is here, and not copied into each gate, because I shipped the copy wrong
 *
 * #691 put this loop inline in four gates over an inline array, with no floor on
 * the array. Mutation-tested afterwards: replacing the array with `[]` left all
 * **26 tests in the file green**. The loop body never runs, so it asserts
 * nothing — `expect(scanned).toBe(LIST.length)` wearing a different costume, in a
 * change whose whole subject was that shape. A shared function takes the floor
 * with it and cannot be forgotten by the fifth caller.
 *
 * `assertEachOf` in `./assert-each-of.ts` is the generic form of the same
 * remedy, for a loop over a hand list that is not a directory list (#706). Reach
 * for this one when the list IS directories, because it also asserts what a flat
 * read requires; reach for that one otherwise.
 *
 * Three assertions, and each closes a different way of being vacuous: the
 * directory LIST is non-empty, each directory LISTS something, and none of them
 * holds a subdirectory.
 */
export function assertDirectoriesAreFlat(
  directories: readonly string[],
  readDir: DirectoryReader = readSrcDirectory,
): void {
  expect(
    directories.length,
    'the flat-directory list is empty, so this assertion cannot fail',
  ).toBeGreaterThan(0);
  for (const relative of directories) {
    const entries = readDir(relative);
    expect(entries.length, `${relative} listed nothing`).toBeGreaterThan(0);
    expect(
      entries
        .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
        .map((entry) => entry.name),
      `${relative} grew a subdirectory, and a one-level readdirSync cannot see into it — ` +
        'either recurse there or move the directory out of this list with a reason',
    ).toEqual([]);
  }
}
