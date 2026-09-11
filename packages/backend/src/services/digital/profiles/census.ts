/**
 * What the 3D profile package actually put in the database (#1015 Workstream 3).
 *
 * ## The failure this exists for
 *
 * A seed that silently did not run reports the same zeros as a clean pass, and a
 * report that sums its own steps is satisfied by `0 = 0 + 0 + 0`. So none of the
 * numbers here come from the run: every one is a `count(*)` against Postgres,
 * and every one is compared against a count the PACKAGE declares by hand —
 * which `three-d-profiles.test.ts` in turn re-derives from the package data, so
 * a fixture edit that forgets an expectation fails the build rather than quietly
 * lowering the bar.
 *
 * `scripts/seed-verticals/census.ts`' three layers, and they are not decoration:
 *
 * 1. **The vacuity floor.** `total === 0` is refused outright, BEFORE any
 *    comparison. Seven zeros compared against seven zeros is `0 === 0` seven
 *    times, which every per-entity equality accepts. It is its own verdict
 *    rather than a mismatch, because "nothing ran" and "one table is short" lead
 *    an operator to opposite actions.
 * 2. **Per-entity equality.** Exact, never `>=`. A floor a later edit satisfies
 *    by adding rows anywhere is a floor that ends at `>= 0`.
 * 3. **The positive control.** Every entity kind must be declared POSITIVE. A
 *    package declaring `profiles: 0` and finding zero would otherwise "match" —
 *    and unlike the catalogue packages, where a vehicle is legitimately absent,
 *    there is no kind here a real 3D package may declare none of. All seven are
 *    controls, which is the one place this census is stricter than the one it is
 *    modelled on.
 *
 * ## How it is SCOPED, and why the licences are scoped differently
 *
 * The catalogue half is counted by the keys the PACKAGE declares, not by the ids
 * the run produced: counting an id list can only find what the run already knew
 * about, and cannot notice a row the run failed to write, because that row has no
 * id to look up.
 *
 * The licences cannot be scoped that way and must not pretend to be.
 * `asset_licences` with `store_id IS NULL` is a GLOBAL set of three rows — its
 * slug is unique over the whole database by a partial index, there is exactly one
 * `mercaria-personal` forever, and a namespaced variant of it would be a second
 * reference licence claiming to be the platform's standard terms. So they are
 * counted by SLUG against the published tuple, and a test run shares them with
 * every other test run in the shared database. That is correct rather than
 * tolerated: they are the rows the epic asks to exist once.
 */

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { MERCARIA_REFERENCE_LICENCES } from '@mercaria/shared-types';

import type { DatabaseOrTransaction } from '../../../db/postgres.js';
import type { ThreeDNamespace } from './apply.js';
import { nsCategoryKey, nsKey } from './apply.js';
import type { ThreeDExpectation, ThreeDProfilePackage } from './types.js';

/**
 * A parenthesised, parameterised list for an `in (…)` predicate.
 *
 * The shape is forced: drizzle renders a bare JavaScript array inside an `sql`
 * template as a ROW CONSTRUCTOR, so `= any(${keys})` reaches Postgres as
 * `any(($1, $2, …))` and is refused with `cannot cast type record to text[]`.
 * An empty list would render `in ()`, which is a syntax error, so it renders a
 * value no key can be instead — and a census over an empty package is the
 * vacuity floor's business, not this function's.
 */
function inList(values: readonly string[]): SQL {
  if (values.length === 0) return sql`null`;
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/** One row of the census: what was declared, what Postgres holds. */
export interface ProfileCensusLine {
  readonly entity: keyof ThreeDExpectation;
  readonly expected: number;
  readonly found: number;
}

export type ProfileCensusVerdict =
  | {
      readonly outcome: 'matched';
      readonly lines: readonly ProfileCensusLine[];
      readonly total: number;
    }
  /**
   * Nothing at all was found. A distinct verdict from `mismatched`, because the
   * remedy is "run the seed" rather than "look at which table is short", and a
   * census reporting this as seven mismatches would bury that.
   */
  | { readonly outcome: 'vacuous'; readonly lines: readonly ProfileCensusLine[] }
  | {
      readonly outcome: 'mismatched';
      readonly lines: readonly ProfileCensusLine[];
      readonly total: number;
      readonly failures: readonly ProfileCensusLine[];
    }
  /**
   * The package declares zero of something, so a matching zero would prove
   * nothing. Refused before any comparison.
   */
  | { readonly outcome: 'unmeasurable'; readonly entities: readonly (keyof ThreeDExpectation)[] };

/**
 * Every entity kind, and all of them are controls.
 *
 * Stated as a list anyway rather than "all of them", because the next profile
 * package may legitimately seed no licence (a vertical whose creators all bring
 * their own terms), and at that point this is where the decision is recorded —
 * not in a predicate that silently admits it.
 */
export const PROFILE_CENSUS_POSITIVE_CONTROL_ENTITIES: readonly (keyof ThreeDExpectation)[] = [
  'categories',
  'attributes',
  'enumValues',
  'profiles',
  'profileFields',
  'licences',
  'licenceVersions',
];

/**
 * The counts the package DATA implies.
 *
 * Separate from the declared `expect`, and the two are compared before a run
 * writes anything. A declaration computed from the arrays would agree with this
 * by construction for any package, including a broken one.
 */
export function deriveExpectation(pkg: ThreeDProfilePackage): ThreeDExpectation {
  return {
    categories: pkg.categories.length,
    attributes: pkg.attributes.length,
    enumValues: pkg.attributes.reduce(
      (sum, attribute) => sum + (attribute.enumValues?.length ?? 0),
      0,
    ),
    profiles: pkg.profiles.length,
    profileFields: pkg.profiles.reduce((sum, profile) => sum + profile.fields.length, 0),
    licences: pkg.licences.length,
    licenceVersions: pkg.licences.length,
  };
}

/**
 * The JUDGEMENT, separated from the counting so it can be tested directly.
 *
 * None of the three layers above can be exercised through a database: proving
 * that all-zero counts answer `vacuous` means supplying all-zero counts, which a
 * seeded namespace by definition cannot. `three-d-profiles.test.ts` calls this
 * with hand-built numbers, which is the only arrangement in which the vacuity
 * floor has a control at all.
 */
export function judgeProfileCensus(
  pkg: ThreeDProfilePackage,
  found: Record<keyof ThreeDExpectation, number>,
): ProfileCensusVerdict {
  const missingControls = PROFILE_CENSUS_POSITIVE_CONTROL_ENTITIES.filter(
    (entity) => pkg.expect[entity] <= 0,
  );
  if (missingControls.length > 0) {
    return { outcome: 'unmeasurable', entities: missingControls };
  }

  const lines: ProfileCensusLine[] = (
    Object.keys(pkg.expect) as (keyof ThreeDExpectation)[]
  ).map((entity) => ({ entity, expected: pkg.expect[entity], found: found[entity] }));
  const total = lines.reduce((sum, line) => sum + line.found, 0);
  if (total === 0) return { outcome: 'vacuous', lines };

  const failures = lines.filter((line) => line.expected !== line.found);
  if (failures.length > 0) return { outcome: 'mismatched', lines, total, failures };
  return { outcome: 'matched', lines, total };
}

/**
 * Count what is actually there, then judge it.
 *
 * Every predicate is an exact `in` list over the keys the package DECLARES,
 * namespaced the same way the apply namespaced them — never a `like` prefix, the
 * way a vertical package counts. Under the canonical namespace the prefix would
 * be the empty string, so `like '%'` would count every category and every
 * attribute in the database: a census that passes for a reason that has nothing
 * to do with this package. An exact list is the same statement under both
 * namespaces and cannot degrade into one.
 *
 * It is still not a count of what the RUN wrote — the keys come from the package,
 * so a row the run failed to write is a key the count does not find, which is
 * exactly the failure an id list cannot see.
 */
export async function censusThreeDProfiles(
  db: DatabaseOrTransaction,
  pkg: ThreeDProfilePackage,
  ns: ThreeDNamespace | null,
): Promise<ProfileCensusVerdict> {
  const categoryKeys = pkg.categories.map((category) => nsCategoryKey(ns, category.key));
  const attributeKeys = pkg.attributes.map((attribute) => nsKey(ns, attribute.key));
  const profileKeys = pkg.profiles.map((profile) => nsKey(ns, profile.key));
  const licenceSlugs = MERCARIA_REFERENCE_LICENCES.map((licence) => licence.slug);

  // `in (${list})` and never `= any(${array})`: drizzle renders a bare
  // JavaScript array into an `sql` template as a ROW CONSTRUCTOR, so
  // `any(($1, $2, …))` is refused by Postgres with `cannot cast type record to
  // text[]`. The vertical fixture's teardown carries the same note one domain
  // over, and it cost a run to rediscover.
  const rows = await db.execute<{
    categories: number;
    attributes: number;
    enum_values: number;
    profiles: number;
    profile_fields: number;
    licences: number;
    licence_versions: number;
  }>(sql`
    select
      (select count(*)::int from categories
         where key in (${inList(categoryKeys)})) as categories,
      (select count(*)::int from attribute_definitions
         where key in (${inList(attributeKeys)}) and lifecycle_state = 'active') as attributes,
      (select count(*)::int from attribute_enum_values v
         join attribute_definitions d on d.id = v.attribute_definition_id
        where d.key in (${inList(attributeKeys)}) and d.lifecycle_state = 'active') as enum_values,
      (select count(*)::int from product_type_definitions
         where key in (${inList(profileKeys)}) and lifecycle = 'published') as profiles,
      (select count(*)::int from product_type_fields f
         join product_type_definitions d on d.id = f.product_type_definition_id
        where d.key in (${inList(profileKeys)}) and d.lifecycle = 'published') as profile_fields,
      -- A NULL store_id is half the IDENTITY of a reference licence rather than
      -- a filter for tidiness: without it a creator who happened to choose the
      -- slug mercaria-personal for their own licence would be counted as
      -- Mercaria's.
      (select count(*)::int from asset_licences
         where store_id is null and authorship = 'mercaria_reference'
           and slug in (${inList(licenceSlugs)})) as licences,
      (select count(*)::int from asset_licence_versions v
         join asset_licences l on l.id = v.licence_id
        where l.store_id is null and l.authorship = 'mercaria_reference'
          and l.slug in (${inList(licenceSlugs)})
          and v.state = 'published') as licence_versions
  `);

  const row = [...rows][0];
  if (row === undefined) {
    throw new Error('The 3D profile census returned no row, which its own aggregates make impossible.');
  }
  return judgeProfileCensus(pkg, {
    categories: row.categories,
    attributes: row.attributes,
    enumValues: row.enum_values,
    profiles: row.profiles,
    profileFields: row.profile_fields,
    licences: row.licences,
    licenceVersions: row.licence_versions,
  });
}

/** The operator-facing rendering. */
export function formatProfileCensus(verdict: ProfileCensusVerdict): string {
  if (verdict.outcome === 'unmeasurable') {
    return (
      'census UNMEASURABLE — the package declares zero of ' +
      `${verdict.entities.join(', ')}, so a matching zero would prove nothing.`
    );
  }
  const lines = verdict.lines
    .map(
      (line) =>
        `  ${line.expected === line.found ? '=' : '!'} ${String(line.entity).padEnd(16)} expected ${String(line.expected).padStart(4)}  found ${String(line.found).padStart(4)}`,
    )
    .join('\n');
  if (verdict.outcome === 'vacuous') {
    return `census VACUOUS — nothing was found at all. Run the seed with --apply.\n${lines}`;
  }
  if (verdict.outcome === 'mismatched') {
    return `census MISMATCHED — ${verdict.failures.length} of ${verdict.lines.length} entity kinds disagree.\n${lines}`;
  }
  return `census matched — ${verdict.total} rows across ${verdict.lines.length} entity kinds.\n${lines}`;
}
