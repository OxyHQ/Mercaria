/**
 * The folding recall matrix, measured against a REAL PostgreSQL server
 * (#367 Workstream 5, "define language-aware tokenization/folding behavior
 * **and benchmark it**").
 *
 * `folding.test.ts` proves the CORPUS could detect a broken fold. This proves
 * the folds actually behave the way the corpus says, which needs a server: two
 * of the three spaces are implemented in SQL, one of them as a stored generated
 * column, and a mocked `select` would agree with whatever the test expected.
 *
 * ## Each space is measured through the thing production uses
 *
 * The harness rule (`workload.ts`) is that a measurement calls the real reader
 * rather than a transcription of it, because a paste drifts silently and in the
 * direction that flatters whoever wrote it. Applied per space:
 *
 *  - **`search_vector`** — a real `listings` row plus a real
 *    `listing_localizations` row, whose generated column analyses the text, read
 *    back through `searchListingsPage`, the function `GET /listings` calls.
 *    Nothing here writes a `tsvector` or spells a `tsquery`.
 *  - **`normalized_alias`** — the write side is a GENERATED SQL expression and
 *    the read side is a TypeScript function, so this is the one space with TWO
 *    implementations that could disagree. The deployed expression is read out of
 *    `pg_get_expr` and asserted FIRST; only then is it evaluated, which is what
 *    makes evaluating it a measurement rather than a transcription.
 *  - **`normalized_name`** — one implementation, `normalizeEntityName`, used by
 *    the write service and by the query side alike. There is no second spelling
 *    to drift from, so calling it on both sides IS the real comparison.
 *
 * ## Its own database, and it is forced to
 *
 * Every localization insert fires `mercaria_listing_localization_revision`, and
 * `catalog_localization_revisions` refuses DELETE as well as UPDATE — so this
 * file physically cannot tear itself out of the shared throwaway. Same
 * arrangement, same reason, as `listing-localization.realdb.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, uuidv7 } from '@oxyhq/db';
import type postgres from 'postgres';
import type { Database } from '../postgres.js';
import * as schema from '../schema/index.js';
import { createMercariaTestDatabase, dropMercariaTestDatabase } from '../testDatabase.js';
import { listings } from '../schema/catalog.js';
import { listingLocalizations } from '../schema/catalogLocalization.js';
import { searchListingsPage } from '../catalog/listingRepository.js';
import {
  normalizeAliasLookup,
  normalizeEntityName,
} from '../../services/canonical/normalization.js';
import {
  FOLDING_PROBES,
  FOLDING_SPACES,
  SCRIPT_INTEGRITY_SAMPLES,
  configurationForProbe,
  findFoldingDisagreements,
  findFoldingVacuityViolations,
  renderFoldingReport,
  type FoldingCell,
  type FoldingProbe,
  type FoldingVerdict,
} from '../../services/graph-benchmark/folding.js';

const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;

/** Keeps fixture text distinctive in a failure message. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();

/** probe id -> the listing whose localization carries that probe's stored text. */
const listingForProbe = new Map<string, string>();

/**
 * The listing's own base text, which must contain NONE of a probe's words.
 *
 * `textMatch` is a UNION of the base vector and the localized one, so a probe
 * whose words also sat in `listings.title` would be found through the ENGLISH
 * base vector and the localized half would never be exercised. Every measured
 * `match` below is therefore attributable to the localized column.
 */
const NEUTRAL_BASE_TITLE = `folding fixture ${RUN}`;

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 4, onnotice: () => undefined },
  });
  client = instance.client;
  db = instance.db;

  for (const probe of FOLDING_PROBES) {
    const [row] = await db
      .insert(listings)
      .values({
        ownerType: 'user',
        oxyUserId: `folding_seller_${RUN}`,
        title: NEUTRAL_BASE_TITLE,
        description: 'base description with none of the probe words in it',
        condition: 'used_good',
        conditionAssertion: 'seller_declared',
        status: 'active',
      })
      .returning({ id: listings.id });
    if (!row) throw new Error(`could not create the listing for ${probe.id}`);
    listingForProbe.set(probe.id, row.id);

    await db.insert(listingLocalizations).values({
      listingId: row.id,
      locale: probe.locale,
      title: probe.stored,
      description: probe.stored,
      status: 'approved',
      sourceLocale: 'en',
      provenance: 'mercaria',
      reviewedByOxyUserId: `folding_reviewer_${RUN}`,
      reviewedAt: new Date(),
    });
  }
}, 300_000);

afterAll(async () => {
  // The whole database goes, so there is no per-row teardown to get wrong and
  // no append-only trail to fail on.
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

/* -------------------------------------------------------------------------- */

/** Does the localized full-text predicate find this probe's own listing? */
async function measureSearchVector(probe: FoldingProbe): Promise<FoldingCell> {
  const listingId = listingForProbe.get(probe.id);
  if (!listingId) throw new Error(`no listing seeded for ${probe.id}`);

  const { rows } = await searchListingsPage(
    { text: probe.query, locale: probe.locale },
    'newest',
    1,
    200,
    db,
  );
  const found = rows.some((row) => row.id === listingId);

  const [vector] = await db.execute<{ lexemes: string }>(sql`
    select ${listingLocalizations.searchVector}::text as lexemes
      from ${listingLocalizations}
     where ${listingLocalizations.listingId} = ${listingId}
  `);

  return {
    probeId: probe.id,
    space: 'search_vector',
    expected: probe.expected.search_vector,
    actual: found ? 'match' : 'no_match',
    evidence: vector?.lexemes ?? '',
  };
}

/**
 * The alias space, evaluated by the SERVER using the expression the server
 * actually stores — see `pins the deployed alias expression` below, which is
 * what makes this a measurement rather than a paste.
 */
async function measureAlias(probe: FoldingProbe): Promise<FoldingCell> {
  const [row] = await db.execute<{ stored: string; queried: string }>(sql`
    select lower(btrim(${probe.stored})) as stored,
           lower(btrim(${probe.query})) as queried
  `);
  const storedSide = row?.stored ?? '';
  // The READ side is the TypeScript function. Comparing the SQL write-side fold
  // against the TS read-side fold is the whole point: two implementations of
  // one rule, and this is the only place they meet.
  const querySide = normalizeAliasLookup(probe.query);
  const actual: FoldingVerdict = storedSide === querySide ? 'match' : 'no_match';
  return {
    probeId: probe.id,
    space: 'normalized_alias',
    expected: probe.expected.normalized_alias,
    actual,
    evidence: `sql:${storedSide} ts:${querySide}`,
  };
}

/** The name space. One implementation, used by both sides. */
function measureName(probe: FoldingProbe): FoldingCell {
  const storedSide = normalizeEntityName(probe.stored);
  const querySide = normalizeEntityName(probe.query);
  return {
    probeId: probe.id,
    space: 'normalized_name',
    expected: probe.expected.normalized_name,
    actual: storedSide === querySide ? 'match' : 'no_match',
    evidence: `${storedSide} | ${querySide}`,
  };
}

async function measureAll(): Promise<FoldingCell[]> {
  const cells: FoldingCell[] = [];
  for (const probe of FOLDING_PROBES) {
    cells.push(measureName(probe));
    cells.push(await measureAlias(probe));
    cells.push(await measureSearchVector(probe));
  }
  return cells;
}

/* -------------------------------------------------------------------------- */

describe('the folding recall matrix', () => {
  it('refuses to run a corpus that could not have measured anything', () => {
    // The floors run BEFORE the database is touched, so a corpus incapable of
    // telling a working fold from a broken one is refused rather than executed
    // — and the refusal is what a reader sees instead of a green grid.
    const violations = findFoldingVacuityViolations();
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('measures every probe in all three spaces', async () => {
    const cells = await measureAll();
    // A vacuity floor on the measurement itself: a loop that silently skipped
    // would leave a shorter matrix that reads exactly like a healthy one.
    expect(cells).toHaveLength(FOLDING_PROBES.length * FOLDING_SPACES.length);
    for (const space of FOLDING_SPACES) {
      expect(cells.filter((cell) => cell.space === space)).toHaveLength(FOLDING_PROBES.length);
    }
  }, 120_000);

  it('every space behaves the way this repository DEFINES it to', async () => {
    const cells = await measureAll();
    const disagreements = findFoldingDisagreements({ cells });
    expect(disagreements, disagreements.join('\n')).toEqual([]);
  }, 120_000);

  it('the three spaces really do disagree — the finding, measured', async () => {
    // Not a restatement of the corpus: these are MEASURED verdicts, and the
    // assertion is that the measurement separates the spaces. If a future
    // change made all three folds identical this goes red even though every
    // individual cell would still match its (also updated) expectation.
    const cells = await measureAll();
    const byProbe = new Map<string, Map<string, FoldingVerdict>>();
    for (const cell of cells) {
      const bucket = byProbe.get(cell.probeId) ?? new Map<string, FoldingVerdict>();
      bucket.set(cell.space, cell.actual);
      byProbe.set(cell.probeId, bucket);
    }

    const separated = new Set<string>();
    for (const spaces of byProbe.values()) {
      for (const left of FOLDING_SPACES) {
        for (const right of FOLDING_SPACES) {
          if (left >= right) continue;
          if (spaces.get(left) !== spaces.get(right)) separated.add(`${left}|${right}`);
        }
      }
    }
    expect(separated.size, `separated pairs: ${[...separated].join(', ')}`).toBe(3);
  }, 120_000);

  it("a locale's own analyser reaches inflections `simple` does not — the A/B", async () => {
    // The whole of property 2, with everything except the configuration held
    // constant: identical stored text, identical query, two locales.
    const analysed = FOLDING_PROBES.find((probe) => probe.id === 'analyser-french');
    const simple = FOLDING_PROBES.find((probe) => probe.id === 'analyser-simple');
    expect(analysed, 'analyser-french is missing').toBeDefined();
    expect(simple, 'analyser-simple is missing').toBeDefined();
    if (!analysed || !simple) return;

    expect(analysed.stored).toBe(simple.stored);
    expect(analysed.query).toBe(simple.query);

    const analysedCell = await measureSearchVector(analysed);
    const simpleCell = await measureSearchVector(simple);

    expect(configurationForProbe(analysed)).toBe('french');
    expect(configurationForProbe(simple)).toBe('simple');
    expect(analysedCell.actual, `french vector: ${analysedCell.evidence}`).toBe('match');
    expect(simpleCell.actual, `simple vector: ${simpleCell.evidence}`).toBe('no_match');
  }, 120_000);

  it('accent folding in the tsvector space is per-CONFIGURATION, not global', async () => {
    // The finding `docs/catalog-search-configurations.md` states without
    // qualification ("accents are not folded") and which is false for two of
    // the ten arms. Measured here so the exception cannot be edited away in
    // prose without a red build.
    const cells = new Map<string, FoldingCell>();
    for (const id of ['fr-accent', 'es-accent', 'pt-accent', 'de-accent', 'ar-accent']) {
      const probe = FOLDING_PROBES.find((entry) => entry.id === id);
      expect(probe, `${id} is missing`).toBeDefined();
      if (probe) cells.set(id, await measureSearchVector(probe));
    }
    expect(cells.get('fr-accent')?.actual).toBe('no_match');
    expect(cells.get('es-accent')?.actual).toBe('no_match');
    expect(cells.get('pt-accent')?.actual).toBe('no_match');
    // The stemmers that DO fold their own diacritics.
    expect(cells.get('de-accent')?.actual).toBe('match');
    expect(cells.get('ar-accent')?.actual).toBe('match');
  }, 120_000);

  it('the matrix detects a broken fold — the mutation self-test', async () => {
    // Every assertion above is "measured equals defined", which passes just as
    // well if the measurement returned a constant. So: corrupt one expectation
    // and confirm the comparison goes red naming the cell. Without this, a
    // `findFoldingDisagreements` that always returned `[]` would be invisible.
    const cells = await measureAll();
    const healthy = findFoldingDisagreements({ cells });
    expect(healthy).toEqual([]);

    const mutated = cells.map((cell) =>
      cell.probeId === 'fr-accent' && cell.space === 'search_vector'
        ? { ...cell, expected: 'match' as const }
        : cell,
    );
    const violations = findFoldingDisagreements({ cells: mutated });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/fr-accent \/ search_vector/);
  }, 120_000);

  it('publishes a matrix when it measured, and a refusal when it did not', async () => {
    const cells = await measureAll();
    const report = renderFoldingReport({ cells }, findFoldingVacuityViolations());
    expect(report).not.toMatch(/THIS RUN MEASURED NOTHING/);
    expect(report).toMatch(/\| `fr-accent` \|/);
    // And the refusal branch, on the same rendering path.
    const refused = renderFoldingReport({ cells }, ['a floor nobody cleared']);
    expect(refused).toMatch(/THIS RUN MEASURED NOTHING/);
    expect(refused).not.toMatch(/\| `fr-accent` \|/);
  }, 120_000);
});

describe('the alias space has two implementations, and they are pinned together', () => {
  it('pins the deployed alias expression, so evaluating it is a measurement', async () => {
    // Read the generated column's definition out of the DATABASE. A
    // source-to-source comparison agrees with itself even when the deployed
    // column says otherwise — #826's reasoning, and the reason `measureAlias`
    // may spell `lower(btrim(...))` at all.
    const [row] = await db.execute<{ expression: string }>(sql`
      select pg_get_expr(d.adbin, d.adrelid) as expression
        from pg_attrdef d
        join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
       where d.adrelid = 'canonical_product_aliases'::regclass
         and a.attname = 'normalized_alias'
    `);
    expect(row?.expression, 'canonical_product_aliases has no generated normalized_alias').toBeDefined();
    expect(row?.expression ?? '').toMatch(/lower/i);
    expect(row?.expression ?? '').toMatch(/btrim/i);
    // And NOT a deeper fold: the alias column is case-only on purpose
    // (`normalization.ts` says so), and an `unaccent` appearing here would mean
    // the alias space had silently become the name space.
    expect(row?.expression ?? '').not.toMatch(/unaccent/i);
  });

  it('the SQL write side and the TypeScript read side agree on every probe', async () => {
    // The cross-implementation check. These two folds are spelled in different
    // languages in different files and nothing but this compares them.
    for (const probe of FOLDING_PROBES) {
      const [row] = await db.execute<{ folded: string }>(sql`
        select lower(btrim(${probe.query})) as folded
      `);
      expect(row?.folded, `SQL and TS disagree on ${probe.id}`).toBe(
        normalizeAliasLookup(probe.query),
      );
    }
  }, 120_000);
});

describe('script integrity under `normalizeEntityName`', () => {
  it('gives every catalogue script its own letters back', () => {
    // Since #830 these rows assert HEALTH. They used to pin a defect — four of
    // twelve catalogue languages did not survive the fold — and the table now
    // carries what each one returned beforehand so a regression stays legible.
    // See `docs/performance/folding-and-tokenization.md`.
    for (const sample of SCRIPT_INTEGRITY_SAMPLES) {
      expect(normalizeEntityName(sample.input), `${sample.language} moved`).toBe(
        sample.normalized,
      );
    }
  });

  it('no longer returns the string #830 measured, for any repaired script', () => {
    // The regression guard proper, and the assertion the defect-pinning version
    // could not make. Reverting ANY part of the fold — the `\p{M}` in the token
    // class, the Latin-only accent strip, or the NFC recomposition — turns this
    // red naming the language it broke.
    const repaired = SCRIPT_INTEGRITY_SAMPLES.filter((s) => s.corruptedBeforeFix !== null);
    // Vacuity floor: an empty list would pass this loop while measuring nothing.
    //
    // A FLOOR and not an exact count. It was `toBe(4)`, which is a vacuity guard
    // whose cheapest green is "do not add a measurement" — #833 measured the
    // hiragana half of Japanese, and an exact count reported that new evidence as
    // a broken test. WHICH languages are on record is pinned by name in
    // `services/graph-benchmark/__tests__/folding.test.ts`; this only has to
    // catch the list going empty.
    expect(repaired.length, 'no repaired scripts on record').toBeGreaterThanOrEqual(4);
    for (const sample of repaired) {
      expect(normalizeEntityName(sample.input), `${sample.language} regressed`).not.toBe(
        sample.corruptedBeforeFix,
      );
      // Stronger than "not the broken value": the word comes back UNCHANGED.
      expect(normalizeEntityName(sample.input), `${sample.language} not intact`).toBe(sample.input);
    }
  });

  it('two different Hindi words no longer collide in the name space', () => {
    // The sharp end of #830, inverted. `normalized_name` is the space #53
    // generates MERGE CANDIDATES in, and these two genuinely different words
    // used to become one string — a false merge, which looks exactly like a
    // correct match and is discovered by a customer.
    const singular = normalizeEntityName('साइकिल');
    const plural = normalizeEntityName('साइकिलें');
    expect(singular).not.toBe(plural);
    // Both survive intact rather than merely differing — two DIFFERENT
    // corruptions would also satisfy the line above.
    expect(singular).toBe('साइकिल');
    expect(plural).toBe('साइकिलें');
    // The control that made the original finding trustworthy, kept: the
    // collision never happened in a Latin script, so this was a property of the
    // fold meeting Devanagari and not of the two words being similar.
    expect(normalizeEntityName('bicicleta')).not.toBe(normalizeEntityName('bicicletas'));
    // And the fold still folds: the Latin accent case is untouched by #830.
    expect(normalizeEntityName('Nestlé')).toBe('nestle');
  });
});
