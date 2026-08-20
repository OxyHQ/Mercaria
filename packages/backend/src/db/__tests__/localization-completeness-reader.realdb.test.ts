/**
 * The completeness READER answers for every domain the desk DECLARES, against a
 * REAL PostgreSQL server (#367 merge-order step 10).
 *
 * ## The failure this exists for, which every other census here is blind to
 *
 * `catalog-localization-desk.test.ts` gates the VOCABULARY — that
 * `LOCALIZATION_COVERAGE_DOMAINS` plus the uncovered list equals the family,
 * that every domain has a staleness descriptor, that every descriptor names a
 * real table. Every one of those reads a tuple.
 *
 * The reader is a hand-wired `Promise.all` of one query per domain. A domain
 * added to the tuple and not to that list returns **no rows** — silently, with
 * no error, no empty-array branch and no log line — and the desk renders one
 * fewer row than it declares. Measured in this repository: a lane shipped six
 * declared domains against four queried ones, and every tuple census stayed
 * green, because a tuple census cannot see a reader.
 *
 * So this asserts the one relation those cannot: **N declared, N returned.**
 *
 * ## Why it needs a real server
 *
 * The gap it catches is a missing SQL statement. With mocks there is no
 * statement to be missing — the mock returns whatever the test wants for as many
 * domains as the test asks about, which is precisely the assumption under test.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every assertion is about which DOMAINS are present and about `owed` being a
 * count of entities rather than of localization rows. Nothing here asserts a
 * magnitude, so a sibling seeding a category cannot break it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  LAUNCH_LOCALES,
  LOCALIZATION_COVERAGE_DOMAINS,
  MERCARIA_BASE_LOCALE,
  type LocalizedEntityKind,
} from '@mercaria/shared-types';

import { connectPostgres, type Database } from '../postgres.js';
import { readLocalizationCompletenessCounts } from '../catalogLocalization/completenessRepository.js';

let db: Database;
/** Two launch locales is enough to prove the grain; eleven would prove nothing more. */
const LOCALES = LAUNCH_LOCALES.filter((locale) => locale !== MERCARIA_BASE_LOCALE).slice(0, 2);

beforeAll(async () => {
  db = await connectPostgres();
}, 180_000);

describe('every declared coverage domain gets a figure', () => {
  it('returns one row per (domain, locale), for every domain in the tuple', async () => {
    // The floor first. An empty locale list makes the reader return `[]` by an
    // explicit early branch, and every assertion below would then pass by
    // comparing empty things.
    expect(LOCALES.length, `${String(LOCALES.length)} locales requested`).toBeGreaterThan(0);
    expect(
      LOCALIZATION_COVERAGE_DOMAINS.length,
      `${String(LOCALIZATION_COVERAGE_DOMAINS.length)} domains declared`,
    ).toBeGreaterThan(0);

    const counts = await readLocalizationCompletenessCounts(LOCALES, db);
    const returned = new Set<LocalizedEntityKind>(counts.map((row) => row.domain));
    const declared = new Set<LocalizedEntityKind>(LOCALIZATION_COVERAGE_DOMAINS);

    const missing = [...declared].filter((domain) => !returned.has(domain)).sort();
    expect(
      missing,
      'these domains are DECLARED by the desk and the reader returns no figure for them. ' +
        'The reader is a hand-wired Promise.all: a domain added to the tuple and not to that ' +
        'list is silently absent from the report, which renders as one fewer row rather than ' +
        'as an error.',
    ).toEqual([]);

    // And the other direction, so a reader querying something nobody declared
    // cannot hide either — that would put a figure on the dashboard with no
    // denominator rule and no staleness descriptor behind it.
    const undeclared = [...returned].filter((domain) => !declared.has(domain)).sort();
    expect(undeclared, 'the reader returned a domain the desk does not declare').toEqual([]);

    // The exact product, which is the count assertion proper.
    expect(
      counts.length,
      `${String(LOCALIZATION_COVERAGE_DOMAINS.length)} domains x ${String(LOCALES.length)} locales`,
    ).toBe(LOCALIZATION_COVERAGE_DOMAINS.length * LOCALES.length);
  }, 120_000);

  it('counts `owed` from the ENTITY population, not from localization rows', async () => {
    // The denominator rule, asserted rather than trusted. A ratio over
    // localization ROWS is vacuous — a locale nobody has started has no rows, so
    // `present / rows` is `0 / 0` and "we found nothing" is byte-identical to
    // "there is nothing to find". `owed` must therefore be IDENTICAL across
    // locales for a given domain: the entity population does not know what
    // language anybody is translating into.
    const counts = await readLocalizationCompletenessCounts(LOCALES, db);
    const owedByDomain = new Map<LocalizedEntityKind, Set<number>>();
    for (const row of counts) {
      const seen = owedByDomain.get(row.domain) ?? new Set<number>();
      seen.add(row.owed);
      owedByDomain.set(row.domain, seen);
    }

    const varying = [...owedByDomain.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([domain]) => domain)
      .sort();
    expect(
      varying,
      "these domains report a different `owed` per locale, so the denominator is counting " +
        'localization rows rather than the entity population — the vacuous ratio the desk ' +
        'exists to avoid.',
    ).toEqual([]);
    expect(owedByDomain.size).toBe(LOCALIZATION_COVERAGE_DOMAINS.length);
  }, 120_000);
});
