/**
 * Native listing localization against a REAL Postgres server (#367 Translation
 * model, ADR 0007 D6/D7).
 *
 * Everything here is a property the database holds, or one only the database can
 * demonstrate. A mocked `insert` accepts any statement including one the server
 * rejects outright, and three of the properties below are triggers — which have
 * no mocked counterpart at all.
 *
 * ## What this file is actually about
 *
 * `listing_localizations` is the family's first `seller_authored` member, so it
 * is the first table anywhere that exercises `exact_locale_then_base`. Two cases
 * carry that: an `es-mx` request must NOT be answered from a stranger's `es`
 * row, and must still be answered from the SELLER'S OWN base text. Both were
 * enforced against zero registered fields until this table existed.
 *
 * ## It takes its OWN database, and is forced to
 *
 * Every localization insert here fires the revision trigger, and
 * `catalog_localization_revisions` refuses DELETE as well as UPDATE — so this
 * file physically cannot tear itself out of the shared database. See the
 * arrangement below.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, sql, TransactionRollbackError } from 'drizzle-orm';
import { createDatabase, uuidv7 } from '@oxyhq/db';
import type postgres from 'postgres';
import {
  CATALOG_LOCALIZED_FIELDS,
  LISTING_BASE_TEXT_SEARCH_CONFIGURATION,
  LOCALE_TEXT_SEARCH_CONFIGURATIONS,
  MERCARIA_BASE_LOCALE,
  SUPPORTED_LOCALES,
  UNANALYZED_TEXT_SEARCH_CONFIGURATION,
  localesByTextSearchConfiguration,
  textSearchConfigurationForLocale,
  type LocalizationCandidate,
} from '@mercaria/shared-types';
import type { Database, DatabaseOrTransaction } from '../postgres.js';
import * as schema from '../schema/index.js';
import { createMercariaTestDatabase, dropMercariaTestDatabase } from '../testDatabase.js';
import { listings } from '../schema/catalog.js';
import {
  catalogLocalizationRevisions,
  listingLocalizations,
} from '../schema/catalogLocalization.js';
import { searchListingsPage } from '../catalog/listingRepository.js';
import { resolveLocalizedField } from '../../services/catalog-localization/resolve.js';
import { reviewListingLocalization } from '../../services/catalog-localization/side-by-side.service.js';

/**
 * The write was REFUSED, by the thing this case names.
 *
 * Two properties, and both are load-bearing:
 *
 *  - it THROWS when the statement was ACCEPTED, so a case that stops refusing
 *    fails loudly instead of passing by never entering the `catch`;
 *  - it matches on the error's CAUSE, never its `message`. drizzle wraps a
 *    driver failure in a `Failed query: …` message of its own, so matching the
 *    top level would pass against ANY refusal — a CHECK, a foreign key, a
 *    unique — which is the check that cannot tell one failure from another.
 */
async function expectRefusal(pattern: RegExp, run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(
      `expected the write to be refused matching ${String(pattern)}, but it was ACCEPTED`,
    );
  }
  const cause = (thrown as { cause?: { message?: string } }).cause;
  expect(String(cause?.message ?? thrown)).toMatch(pattern);
}

/**
 * Its OWN throwaway database, and that is forced rather than chosen.
 *
 * Every insert here fires `mercaria_listing_localization_revision`, and
 * `catalog_localization_revisions` is APPEND-ONLY against DELETE as well as
 * UPDATE — a trigger refuses the statement outright. So this file cannot clean
 * up after itself in the shared database, and leaving a growing trail behind for
 * every other file to read is worse than paying for a database.
 *
 * Measured, not assumed: the first run of this file tore down against the shared
 * database and failed with `catalog_localization_revisions is append-only`.
 * `localization-revisions.realdb.test.ts` reached the same place for the same
 * reason and this is its arrangement, reused.
 *
 * The consequence worth stating: a private database means the shared-database
 * scoping rules do not apply here, so the assertions below can be exact counts
 * rather than floors.
 */
const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;

/** Kept so fixture text is still distinctive in a failure message. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();

/**
 * One inflected word per Snowball stemmer, so the locale census can tell every
 * configuration in the map apart.
 *
 * Chosen by MEASUREMENT rather than by looking plausible. `stops running
 * quickly` was the first attempt and it collapses `simple`, `arabic`, `german`,
 * `portuguese` and `spanish` onto ONE vector — under which a bug routing `es`
 * to `simple` is invisible. `estacoes` is here because it is the only pair
 * tried that separates Portuguese (`estaco`) from Spanish (`estac`); `stops` is
 * an English stop word, which is what separates `english` from everything that
 * keeps it. On `postgis/postgis:17-3.5` this yields ten distinct vectors for the
 * map's ten configurations, and the census asserts exactly that.
 */
const LOCALE_PROBE_TEXT =
  'stops running bicyclettes niños Häuser cavalos cavalls estacoes книги الكتب किताबें';

const listingIds: string[] = [];

/**
 * A P2P listing, deliberately — `ownerType: 'user'` needs no store fixture, and
 * an individual seller's own words are the sharpest case for `seller_authored`.
 */
async function createListing(title: string, description: string): Promise<string> {
  const [row] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: `l10n_seller_${RUN}`,
      title,
      description,
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning({ id: listings.id });
  if (!row) throw new Error('createListing returned no row');
  listingIds.push(row.id);
  return row.id;
}

async function candidatesFor(listingId: string): Promise<LocalizationCandidate[]> {
  const rows = await db
    .select()
    .from(listingLocalizations)
    .where(eq(listingLocalizations.listingId, listingId));
  return rows.map((row) => ({
    locale: row.locale,
    status: row.status,
    provenance: row.provenance,
    value: row.title,
  }));
}

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 4, onnotice: () => undefined },
  });
  client = instance.client;
  db = instance.db;
}, 300_000);

afterAll(async () => {
  // The whole database goes, so there is no per-row teardown to get wrong and
  // no append-only trail to fail on.
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

/* -------------------------------------------------------------------------- */

describe('the row shape a seller-authored localization may take', () => {
  it('refuses a base-locale row, because the seller’s own words live on the listing', async () => {
    const listingId = await createListing(`Base ${RUN}`, 'the seller’s own description');
    await expectRefusal(/listing_localizations_locale_not_base_check/u, () =>
      db.insert(listingLocalizations).values({
        listingId,
        locale: 'en',
        status: 'approved',
        provenance: 'mercaria',
        title: 'a second English title',
        reviewedByOxyUserId: 'reviewer',
        reviewedAt: new Date(),
      }),
    );
  });

  it('ties `missing` to the TITLE alone, so a translated title with no description is valid', async () => {
    const listingId = await createListing(`Partial ${RUN}`, 'base description');
    // `title` is the `primaryText`. A translator who has settled the title and
    // not the description holds a row that is genuinely not `missing`, and this
    // is the case that would break if `description` were made primary too.
    const [row] = await db
      .insert(listingLocalizations)
      .values({
        listingId,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        title: 'Título en español',
        description: null,
        reviewedByOxyUserId: 'reviewer',
        reviewedAt: new Date(),
      })
      .returning();
    expect(row.description).toBeNull();
    expect(row.status).toBe('approved');

    // …and the biconditional still bites in the other direction.
    await expectRefusal(/listing_localizations_missing_text_check/u, () =>
      db.insert(listingLocalizations).values({
        listingId,
        locale: 'fr',
        status: 'missing',
        provenance: 'mercaria',
        title: 'a title on a row claiming nothing is translated',
      }),
    );
  });

  it('refuses a machine row wearing an approved status — the INSERT the trigger never sees', async () => {
    /*
     * The three machine CHECKs OVERLAP by design, and `_machine_status_check`
     * turns out not to be isolable at all. To violate only it a row would need
     * `provenance = 'machine'`, `status in ('reviewed','approved')` and NO
     * reviewer — and `_reviewed_audit_check` refuses exactly that. Add a
     * reviewer and `_machine_reviewer_check` refuses it instead.
     *
     * So the assertion is on the OUTCOME plus the SET of constraints that could
     * have produced it. The first draft of this case named
     * `_machine_status_check` alone and failed against a real server, which is
     * how the overlap was found: Postgres reports whichever constraint it
     * evaluates first and does not promise which.
     *
     * The overlap is the family's stated intent — "neither covers the other" —
     * and this is what it looks like from the outside.
     */
    const listingId = await createListing(`Machine ${RUN}`, 'base description');
    await expectRefusal(
      /listing_localizations_(machine_status|machine_reviewer|reviewed_audit)_check/u,
      () =>
        db.insert(listingLocalizations).values({
          listingId,
          locale: 'de',
          status: 'approved',
          provenance: 'machine',
          title: 'maschinell übersetzt',
          reviewedByOxyUserId: 'reviewer',
          reviewedAt: new Date(),
        }),
    );
    // Without a reviewer it is STILL refused, which is what makes the claim
    // "machine may never be approved" rather than "machine may never name a
    // reviewer". Two rows, because one cannot separate the two constraints.
    await expectRefusal(
      /listing_localizations_(machine_status|reviewed_audit)_check/u,
      () =>
        db.insert(listingLocalizations).values({
          listingId,
          locale: 'ja',
          status: 'approved',
          provenance: 'machine',
          title: '機械翻訳',
        }),
    );
    // …and the isolable one: a machine row at a status it MAY hold, wearing
    // somebody else's review. Only `_machine_reviewer_check` refuses this.
    await expectRefusal(/listing_localizations_machine_reviewer_check/u, () =>
      db.insert(listingLocalizations).values({
        listingId,
        locale: 'pt',
        status: 'machine_translated',
        provenance: 'machine',
        title: 'traduzido por máquina',
        reviewedByOxyUserId: 'reviewer',
        reviewedAt: new Date(),
      }),
    );
    // THE POSITIVE CONTROL. A machine row at a status it may hold, with no
    // review, is ACCEPTED — so the three refusals above are about the machine
    // provenance beside human settlement, not about `provenance = 'machine'`
    // being unwritable at all.
    const [accepted] = await db
      .insert(listingLocalizations)
      .values({
        listingId,
        locale: 'de',
        status: 'machine_translated',
        provenance: 'machine',
        title: 'maschinell übersetzt',
      })
      .returning();
    expect(accepted.provenance).toBe('machine');
    expect(accepted.status).toBe('machine_translated');
  });

  it('runs the SHARED machine-write guard, refusing a machine UPDATE over approved text', async () => {
    const listingId = await createListing(`Guarded ${RUN}`, 'base description');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      title: 'Traducción aprobada',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });

    // The guard is `mercaria_localization_machine_write_guard`, migration 0091's,
    // ATTACHED here rather than cloned. A clone would be a second answer to "may
    // a machine overwrite human-settled text" and the two could drift.
    await expectRefusal(/machine translation may not overwrite|machine/iu, () =>
      db
        .update(listingLocalizations)
        .set({ status: 'machine_translated', provenance: 'machine', title: 'sobrescrito' })
        .where(
          and(
            eq(listingLocalizations.listingId, listingId),
            eq(listingLocalizations.locale, 'es'),
          ),
        ),
    );

    // The positive control on the refusal above: the row is UNCHANGED, so the
    // guard refused rather than the statement having failed for some other
    // reason after writing.
    const [after] = await db
      .select()
      .from(listingLocalizations)
      .where(
        and(eq(listingLocalizations.listingId, listingId), eq(listingLocalizations.locale, 'es')),
      );
    expect(after.title).toBe('Traducción aprobada');
    expect(after.provenance).toBe('professional');
  });
});

/* -------------------------------------------------------------------------- */

describe('the stale trigger watches BOTH seller-authored columns', () => {
  async function seedApproved(listingId: string, locale: string, title: string): Promise<void> {
    await db.insert(listingLocalizations).values({
      listingId,
      locale: locale as 'es',
      status: 'approved',
      provenance: 'professional',
      title,
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });
  }

  async function statusOf(listingId: string, locale: string): Promise<string> {
    const [row] = await db
      .select({ status: listingLocalizations.status })
      .from(listingLocalizations)
      .where(
        and(
          eq(listingLocalizations.listingId, listingId),
          eq(listingLocalizations.locale, locale as 'es'),
        ),
      );
    return row.status;
  }

  it('marks translations stale when the seller edits the TITLE', async () => {
    const listingId = await createListing(`Title edit ${RUN}`, 'base description');
    await seedApproved(listingId, 'es', 'Título aprobado');
    await db
      .update(listings)
      .set({ title: `Title edit ${RUN} v2` })
      .where(eq(listings.id, listingId));
    expect(await statusOf(listingId, 'es')).toBe('stale');
  });

  it('marks translations stale when the seller edits the DESCRIPTION — the case the category trigger MISSES', async () => {
    // `mercaria_categories_localization_stale` watches `name` ALONE, and that
    // blind spot is published in `LOCALIZATION_STALENESS_DETECTIONS.unwatched`
    // precisely so it stops being inherited. This is the assertion that fails if
    // somebody "makes it consistent" by copying the category trigger's WHEN
    // clause — which is the direction a reviewer would wave through.
    const listingId = await createListing(`Desc edit ${RUN}`, 'base description');
    await seedApproved(listingId, 'es', 'Título aprobado');
    await db
      .update(listings)
      .set({ description: 'the seller rewrote the description' })
      .where(eq(listings.id, listingId));
    expect(await statusOf(listingId, 'es')).toBe('stale');
  });

  it('marks NOTHING stale when the edit touches no seller-authored text', async () => {
    // The WHEN clause is what keeps this trigger off a hot table's critical
    // path, and the case that proves it is a real column moving. An ARCHIVE is
    // the one that matters: it is a soft delete on the same row, so a restore
    // must find its translations exactly as they were.
    const listingId = await createListing(`Archived ${RUN}`, 'base description');
    await seedApproved(listingId, 'es', 'Título aprobado');
    await db
      .update(listings)
      .set({ status: 'archived', archivedBy: 'merchant_delete', archivedFromStatus: 'active' })
      .where(eq(listings.id, listingId));
    expect(await statusOf(listingId, 'es')).toBe('approved');
  });

  it('leaves a `missing` row alone and never blanks the text it stales', async () => {
    const listingId = await createListing(`Preserve ${RUN}`, 'base description');
    await seedApproved(listingId, 'es', 'Título aprobado');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'fr',
      status: 'missing',
      provenance: 'mercaria',
      title: null,
    });
    await db.update(listings).set({ title: `Preserve ${RUN} v2` }).where(eq(listings.id, listingId));

    const [spanish] = await db
      .select()
      .from(listingLocalizations)
      .where(
        and(eq(listingLocalizations.listingId, listingId), eq(listingLocalizations.locale, 'es')),
      );
    // A stale translation is still the best text available; withdrawing it would
    // show the shopper the seller's English, which is the failure the whole
    // family exists to prevent.
    expect(spanish.status).toBe('stale');
    expect(spanish.title).toBe('Título aprobado');
    // `missing` has nothing to stale, so restating it would turn a source edit
    // into a status a reviewer has to undo.
    expect(await statusOf(listingId, 'fr')).toBe('missing');
  });
});

/* -------------------------------------------------------------------------- */

describe('`exact_locale_then_base` resolves a seller-authored field', () => {
  it('is the policy the registry gives both listing fields', () => {
    // Stated here as well as in the static gate, because every case below is
    // only meaningful under this policy: on `language_then_base` the first one
    // would answer from the `es` row and pass for the wrong reason.
    expect(CATALOG_LOCALIZED_FIELDS['listing.title'].fallback).toBe('exact_locale_then_base');
    expect(CATALOG_LOCALIZED_FIELDS['listing.description'].fallback).toBe('exact_locale_then_base');
  });

  it('never answers an es-mx request from a stranger’s `es` row', async () => {
    const listingId = await createListing(`Cross market ${RUN}`, 'base description');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      title: 'Título peninsular',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });

    const resolved = resolveLocalizedField({
      field: 'listing.title',
      requestedLocale: 'es-mx',
      candidates: await candidatesFor(listingId),
      baseValue: `Cross market ${RUN}`,
    });

    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    // The `es` row EXISTS and is approved. It is withheld because it is another
    // market's copy — written for Spain, by whoever wrote it, about a different
    // market — which is D4's exclusion.
    expect(resolved.value).not.toBe('Título peninsular');
    expect(resolved.basis).toBe('authored_base_text');
    expect(resolved.value).toBe(`Cross market ${RUN}`);
  });

  it('answers from the seller’s OWN base text rather than emptying the page', async () => {
    // `listings.title` is NOT NULL, so `exact_locale_only` would have rendered a
    // French shopper a listing page with no title on it. The seller's own
    // English is not another market's copy — same seller, same item, the words
    // they actually wrote.
    const listingId = await createListing(`Own base ${RUN}`, 'base description');
    const resolved = resolveLocalizedField({
      field: 'listing.title',
      requestedLocale: 'fr',
      candidates: await candidatesFor(listingId),
      baseValue: `Own base ${RUN}`,
    });
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    expect(resolved.basis).toBe('authored_base_text');
    expect(resolved.step).toBe('base');
    // The branch carries NO `provenance` at all, so a storefront cannot label a
    // seller's own words as Mercaria's copy. Asserted on the VALUE rather than
    // by type, because the type is what makes it unwritable and this is what
    // makes it unread.
    expect(Object.hasOwn(resolved, 'provenance')).toBe(false);
  });

  it('answers the EXACT locale from its own row, with its status and provenance', async () => {
    const listingId = await createListing(`Exact ${RUN}`, 'base description');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'es-mx',
      status: 'approved',
      provenance: 'professional',
      title: 'Título mexicano',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });
    const resolved = resolveLocalizedField({
      field: 'listing.title',
      requestedLocale: 'es-mx',
      candidates: await candidatesFor(listingId),
      baseValue: `Exact ${RUN}`,
    });
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome !== 'resolved') return;
    expect(resolved.basis).toBe('localization_row');
    expect(resolved.value).toBe('Título mexicano');
    expect(resolved.step).toBe('exact');
    // Narrowed with an `if` and not by the `expect` above, which narrows
    // nothing. That is not ceremony here: writing `resolved.provenance` after
    // only the assertion is a TS2339 against BOTH branches of the union, which
    // is the compiler stating the property this domain is built on — only a
    // localization ROW knows who produced a translation.
    if (resolved.basis !== 'localization_row') throw new Error('expected a row to answer');
    expect(resolved.provenance).toBe('professional');
  });
});

/* -------------------------------------------------------------------------- */

describe('the revision trail covers this table, or rollback lies', () => {
  it('writes one revision per FIELD on insert, under entity kind `listing`', async () => {
    const listingId = await createListing(`Revised ${RUN}`, 'base description');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      title: 'Título',
      description: 'Descripción',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });

    const rows = await db
      .select()
      .from(catalogLocalizationRevisions)
      .where(
        and(
          eq(catalogLocalizationRevisions.entityKind, 'listing'),
          eq(catalogLocalizationRevisions.entityId, listingId),
        ),
      )
      .orderBy(desc(catalogLocalizationRevisions.createdAt));

    // One row per FIELD and not per save, which is what makes a per-field diff a
    // `lag()` over one partition rather than a comparison of two blobs.
    expect(rows.map((row) => row.fieldKey).sort()).toEqual([
      'listing.description',
      'listing.title',
    ]);
    for (const row of rows) expect(row.action).toBe('create');
    // The widened `field_pair` CHECK is what admits these two rows at all; the
    // insert above is the statement that would have failed had the CHECK been
    // split into a later migration.
    expect(rows.every((row) => row.status === 'approved')).toBe(true);
  });

  it('records an update, and only for the field that moved', async () => {
    const listingId = await createListing(`Updated ${RUN}`, 'base description');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      title: 'Título',
      description: 'Descripción',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });
    await db
      .update(listingLocalizations)
      .set({ title: 'Título corregido' })
      .where(
        and(eq(listingLocalizations.listingId, listingId), eq(listingLocalizations.locale, 'es')),
      );

    const updates = await db
      .select()
      .from(catalogLocalizationRevisions)
      .where(
        and(
          eq(catalogLocalizationRevisions.entityId, listingId),
          eq(catalogLocalizationRevisions.action, 'update'),
        ),
      );
    expect(updates.map((row) => row.fieldKey)).toEqual(['listing.title']);
    expect(updates[0].value).toBe('Título corregido');
  });
});

/* -------------------------------------------------------------------------- */

describe('what carries these rows, and what removes them', () => {
  it('cascades from the listing — the property ~20 realdb teardowns depend on', async () => {
    // Production never hard-deletes a listing, but the suites do, and a
    // `restrict` here would turn every one of them into a `23503` raised in a
    // file that never mentioned localization. Exercised on a listing this case
    // creates and immediately destroys, so nothing else in the run is touched.
    const [row] = await db
      .insert(listings)
      .values({
        ownerType: 'user',
        oxyUserId: `l10n_cascade_${RUN}`,
        title: `Cascade ${RUN}`,
        description: 'base description',
        condition: 'used_good',
        conditionAssertion: 'seller_declared',
        status: 'active',
      })
      .returning({ id: listings.id });
    await db.insert(listingLocalizations).values({
      listingId: row.id,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      title: 'Título',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });
    await db.delete(listings).where(eq(listings.id, row.id));

    const left = await db
      .select()
      .from(listingLocalizations)
      .where(eq(listingLocalizations.listingId, row.id));
    expect(left).toHaveLength(0);

    // …and the trail SURVIVES the subject, which is the other half of the same
    // decision: `catalog_localization_revisions.entity_id` carries no foreign
    // key permanently, because the history of what a listing used to say in
    // Spanish is precisely the thing that must outlive the listing going away.
    // A cascade here would delete the record along with its subject; a
    // `restrict` would block the delete the cascade above exists to allow.
    const trail = await db
      .select()
      .from(catalogLocalizationRevisions)
      .where(eq(catalogLocalizationRevisions.entityId, row.id));
    expect(trail.length).toBeGreaterThan(0);
  });

  it('is unique per (listing, locale), so “the Spanish one” is a single row', async () => {
    const listingId = await createListing(`Unique ${RUN}`, 'base description');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      title: 'Primero',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });
    await expectRefusal(/listing_localizations_locale_key/u, () =>
      db.insert(listingLocalizations).values({
        listingId,
        locale: 'es',
        status: 'approved',
        provenance: 'professional',
        title: 'Segundo',
        reviewedByOxyUserId: 'reviewer',
        reviewedAt: new Date(),
      }),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('full-text search reads localized listing text, under its own analyser', () => {
  /**
   * #367 Workstream 5, and it REPLACES a characterisation case.
   *
   * The case that stood here pinned the LIMITATION as a measured fact — a
   * listing found by its English title was not found by its French one — with a
   * positive control so it could not pass against a vector that was simply
   * empty. Both halves survive below, because both are still true and both are
   * what make the localized vector necessary: `listings.search_vector` still
   * holds no French, and the base term still matches. What changed is the
   * CONSEQUENCE — the French title is now findable, through
   * `listing_localizations.search_vector`.
   */

  /** A listing whose French translation is the only place the French word appears. */
  async function bicycle(): Promise<string> {
    const listingId = await createListing(`Bicycle ${RUN}`, 'a bicycle in good condition');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'fr',
      status: 'approved',
      provenance: 'professional',
      title: `Bicyclette ${RUN}`,
      description: 'une bicyclette en bon etat',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });
    return listingId;
  }

  it('leaves `listings.search_vector` untouched — the base half is genuinely unchanged', async () => {
    /*
     * A generation expression may reference only columns of its own row, so a
     * sibling table's text cannot enter the base vector — a PostgreSQL
     * restriction, not a decision, and the reason the localized index is a
     * SECOND column rather than a wider expression over there.
     *
     * Asserted rather than argued: writing the translation must move nothing on
     * `listings`, or "additive" is a claim instead of a property.
     */
    const listingId = await createListing(`Untouched ${RUN}`, 'a bicycle in good condition');
    const [before] = await db
      .select({ vector: sql<string>`${listings.searchVector}::text` })
      .from(listings)
      .where(eq(listings.id, listingId));

    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'fr',
      status: 'approved',
      provenance: 'professional',
      title: `Bicyclette intouchee ${RUN}`,
      description: 'une bicyclette en bon etat',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });

    const [after] = await db
      .select({ vector: sql<string>`${listings.searchVector}::text` })
      .from(listings)
      .where(eq(listings.id, listingId));
    expect(after.vector).toBe(before.vector);

    // The POSITIVE CONTROL the original case carried, kept for the reason it
    // was written: without it this passes against a vector that is empty or a
    // query spelling that matches nothing.
    const english = await db
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.id, listingId),
          sql`${listings.searchVector} @@ websearch_to_tsquery('english', 'bicycle')`,
        ),
      );
    expect(english, 'the base-locale term must match, or this case measures nothing').toHaveLength(
      1,
    );

    // …and the base vector still holds NO French. This is the half of the old
    // characterisation that remains true, and it is what makes the localized
    // vector necessary rather than redundant.
    const french = await db
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.id, listingId),
          sql`${listings.searchVector} @@ websearch_to_tsquery('english', 'bicyclette')`,
        ),
      );
    expect(french).toHaveLength(0);
  });

  it('finds the French title through the localized vector, INFLECTED', async () => {
    const listingId = await bicycle();

    // `bicyclettes`, not `bicyclette`: an exact-string match would pass against
    // a vector that stored the title verbatim, which is what
    // `array_to_tsvector` did to tags and what `simple` would do here. Only a
    // French analyser reduces both the stored `bicyclette` and the queried
    // `bicyclettes` to `bicyclet`.
    const matched = await db
      .select({ id: listingLocalizations.listingId })
      .from(listingLocalizations)
      .where(
        and(
          eq(listingLocalizations.listingId, listingId),
          sql`${listingLocalizations.searchVector} @@ websearch_to_tsquery('french', 'bicyclettes')`,
        ),
      );
    expect(matched).toHaveLength(1);
  });

  it('matches NOTHING when the query is built under the wrong configuration', async () => {
    const listingId = await bicycle();

    // The hazard the one-map design exists to remove, measured rather than
    // asserted in prose. Two stemmers sometimes agree on a word and sometimes
    // do not — over ten configurations, 96 of 270 cross-configuration pairings
    // still match — so a mismatch is ARBITRARY rather than uniformly broken.
    // This exact pairing is one that fails, and a predicate returning nothing
    // is indistinguishable from a term nobody sells, which is why the case is
    // pinned rather than left to review.
    const wrong = await db
      .select({ id: listingLocalizations.listingId })
      .from(listingLocalizations)
      .where(
        and(
          eq(listingLocalizations.listingId, listingId),
          sql`${listingLocalizations.searchVector} @@ websearch_to_tsquery('english', 'bicyclettes')`,
        ),
      );
    expect(wrong).toHaveLength(0);

    // The CONTROL for that zero: the same row, the same term, the RIGHT
    // configuration.
    const right = await db
      .select({ id: listingLocalizations.listingId })
      .from(listingLocalizations)
      .where(
        and(
          eq(listingLocalizations.listingId, listingId),
          sql`${listingLocalizations.searchVector} @@ websearch_to_tsquery('french', 'bicyclettes')`,
        ),
      );
    expect(right).toHaveLength(1);
  });

  it('analyses a locale PostgreSQL cannot stem with `simple`, never with `english`', async () => {
    /*
     * Japanese has no bundled configuration. The requirement is not that it
     * search WELL — `simple` cannot segment a script written without spaces —
     * but that it never be analysed by the English stemmer, which would produce
     * lexemes no Japanese query reproduces and leave the row indexed and
     * permanently unmatchable.
     */
    const listingId = await createListing(`Camera ${RUN}`, 'a camera in good condition');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'ja',
      status: 'approved',
      provenance: 'professional',
      title: `カメラ Nikkor S9000 stops ${RUN}`,
      description: 'カメラ',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });

    const [row] = await db
      .select({ vector: sql<string>`${listingLocalizations.searchVector}::text` })
      .from(listingLocalizations)
      .where(
        and(eq(listingLocalizations.listingId, listingId), eq(listingLocalizations.locale, 'ja')),
      );

    // The DISCRIMINATOR, and it is what makes this case about the ELSE branch
    // rather than merely about a row existing: `stops` is an English STOP WORD.
    // `to_tsvector('english', 'stops')` is EMPTY and `to_tsvector('simple', …)`
    // keeps it verbatim, so its presence is reachable under `simple` and
    // unreachable under `english`. Measured, not assumed — `english` also stems
    // it to `stop`, so the un-stemmed spelling is the tell.
    expect(row.vector).toContain("'stops'");
    expect(row.vector, '`simple` must keep the CJK run as a lexeme of its own').toContain(
      "'カメラ'",
    );

    // The Latin model number is the part `simple` genuinely indexes and the
    // part a shopper actually types, so it is worth asserting reachable.
    const found = await db
      .select({ id: listingLocalizations.listingId })
      .from(listingLocalizations)
      .where(
        and(
          eq(listingLocalizations.listingId, listingId),
          sql`${listingLocalizations.searchVector} @@ websearch_to_tsquery('simple', 's9000')`,
        ),
      );
    expect(found).toHaveLength(1);
  });

  it('indexes Bengali and Japanese HIRAGANA the same way, under `simple`', async () => {
    /*
     * #833. Two scripts the product ships bundles for that no fixture in this
     * repository reached before: `bn.json` is 89% Bengali and `ja.json` is 46%
     * HIRAGANA, while every Japanese fixture here was written in katakana.
     *
     * Neither has a bundled PostgreSQL configuration, so both take the `CASE`'s
     * `ELSE` and are analysed by `simple`. The assertion is the same one the
     * katakana case above makes and for the same reason: not that either
     * searches well, but that neither is analysed by the English stemmer, which
     * would index lexemes no Bengali or Japanese query reproduces.
     */
    for (const [locale, script, title] of [
      ['bn', 'Bengali', `বইগুলি Nikkor B7000 stops ${RUN}`],
      ['ja', 'Hiragana', `じてんしゃ Nikkor H7000 stops ${RUN}`],
    ] as const) {
      const listingId = await createListing(`Probe ${script} ${RUN}`, 'a probe listing');
      await db.insert(listingLocalizations).values({
        listingId,
        locale,
        status: 'approved',
        provenance: 'professional',
        title,
        description: title,
        reviewedByOxyUserId: 'reviewer',
        reviewedAt: new Date(),
      });

      const [row] = await db
        .select({ vector: sql<string>`${listingLocalizations.searchVector}::text` })
        .from(listingLocalizations)
        .where(
          and(
            eq(listingLocalizations.listingId, listingId),
            eq(listingLocalizations.locale, locale),
          ),
        );

      // The discriminator, exactly as above: `stops` is an English STOP WORD, so
      // `to_tsvector('english', …)` drops it and `simple` keeps it verbatim. Its
      // presence is reachable under `simple` and unreachable under `english`.
      expect(row.vector, `${script} was not analysed by simple`).toContain("'stops'");
      // …and the script's own run survives as a lexeme rather than being dropped.
      const word = title.split(' ')[0];
      expect(row.vector, `${script} lost its own word`).toContain(`'${word}'`);
    }
  });

  it('binds the deployed columns and both query sides to ONE map', async () => {
    /*
     * Read out of `pg_get_expr` — the DEPLOYED expression — and not out of the
     * schema module that wrote it. A source-to-source comparison agrees with
     * itself even when the database says something else, which is exactly the
     * drift a `CREATE OR REPLACE` under an unchanged name produces.
     */
    const [base] = await db.execute<{ expression: string }>(sql`
      select pg_get_expr(d.adbin, d.adrelid) as expression
        from pg_attrdef d
        join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
       where d.adrelid = 'listings'::regclass and a.attname = 'search_vector'
    `);
    const baseConfigurations = [
      ...new Set([...base.expression.matchAll(/'([a-z_]+)'::regconfig/gu)].map((m) => m[1])),
    ];
    expect(
      baseConfigurations,
      '`listings.search_vector` must be analysed by exactly the configuration `baseTextMatch` queries in',
    ).toEqual([LISTING_BASE_TEXT_SEARCH_CONFIGURATION]);

    const [localized] = await db.execute<{ expression: string }>(sql`
      select pg_get_expr(d.adbin, d.adrelid) as expression
        from pg_attrdef d
        join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
       where d.adrelid = 'listing_localizations'::regclass and a.attname = 'search_vector'
    `);
    const deployed = [
      ...new Set([...localized.expression.matchAll(/'([a-z_]+)'::regconfig/gu)].map((m) => m[1])),
    ].sort();
    const expectedConfigurations = [
      ...new Set<string>([
        UNANALYZED_TEXT_SEARCH_CONFIGURATION,
        ...localesByTextSearchConfiguration().map((arm) => arm.configuration),
      ]),
    ].sort();
    expect(deployed).toEqual(expectedConfigurations);
  });

  it('routes EVERY supported locale to the arm the map names', async () => {
    /*
     * Asked of the DATABASE rather than of the expression's text: the column is
     * `GENERATED ALWAYS`, so the only way to ask which arm a locale takes is to
     * store a row and read the column back. That is also the only form of the
     * question that cannot be answered by reading the same source twice.
     */
    const listingId = await createListing(`Every locale ${RUN}`, 'a bicycle in good condition');
    for (const locale of SUPPORTED_LOCALES) {
      // The base locale is UNREPRESENTABLE here — `_locale_not_base_check`.
      if (locale === MERCARIA_BASE_LOCALE) continue;
      await db.insert(listingLocalizations).values({
        listingId,
        locale,
        status: 'approved',
        provenance: 'professional',
        title: LOCALE_PROBE_TEXT,
        reviewedByOxyUserId: 'reviewer',
        reviewedAt: new Date(),
      });
    }

    const rows = await db
      .select({
        locale: listingLocalizations.locale,
        stored: sql<string>`${listingLocalizations.searchVector}::text`,
      })
      .from(listingLocalizations)
      .where(eq(listingLocalizations.listingId, listingId));
    expect(
      rows.length,
      'the census must cover every non-base locale, or it measures a subset',
    ).toBe(SUPPORTED_LOCALES.length - 1);

    const mismatched: string[] = [];
    for (const row of rows) {
      const configuration = textSearchConfigurationForLocale(row.locale);
      const [expected] = await db.execute<{ vector: string }>(
        sql`select (to_tsvector(${configuration}::regconfig, ${LOCALE_PROBE_TEXT})
                    || to_tsvector(${configuration}::regconfig, '')) ::text as vector`,
      );
      if (row.stored !== expected.vector) {
        mismatched.push(`${row.locale} stored ${row.stored} but ${configuration} gives ${expected.vector}`);
      }
    }
    expect(mismatched).toEqual([]);

    /*
     * The VACUITY FLOOR, and it is the assertion that makes the census above
     * mean anything.
     *
     * The loop compares each stored vector against ITS OWN configuration's
     * analysis, so it passes trivially for any two configurations the probe
     * cannot tell apart. Measured: `stops running quickly` — the first probe
     * tried — collapses `simple`, `arabic`, `german`, `portuguese` and `spanish`
     * onto ONE vector, so a bug routing `es` to `simple` would have been
     * invisible. `LOCALE_PROBE_TEXT` carries one inflected word per stemmer
     * (including `estacoes`, which is the only pair that separates Portuguese
     * from Spanish) and separates all ten.
     */
    const distinctStored = new Set(rows.map((row) => row.stored)).size;
    const distinctConfigurations = new Set(Object.values(LOCALE_TEXT_SEARCH_CONFIGURATIONS)).size;
    expect(
      distinctStored,
      'the probe must analyse differently under EVERY configuration in the map, or the census above cannot fail',
    ).toBe(distinctConfigurations);
  });

  it('carries the GIN index, and the predicate can be served by it', async () => {
    const [index] = await db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
       where tablename = 'listing_localizations'
         and indexname = 'listing_localizations_search_vector_idx'
    `);
    expect(index?.indexdef ?? '').toContain('USING gin (search_vector)');

    /*
     * What this proves and what it does not.
     *
     * PROVES: the predicate `listingRepository` sends — a `tsquery` built from a
     * BOUND `::regconfig` parameter rather than a literal — is one this index
     * CAN serve. That is the real risk, because an expression the opclass cannot
     * match is chosen at no scale and the symptom is a silent sequential scan.
     *
     * DOES NOT PROVE: that the planner would prefer it on a production-sized
     * table. `enable_seqscan = off` is what makes the question answerable on a
     * fixture of a few dozen rows; cost behaviour at scale is #61's harness and
     * not this file's.
     */
    async function planFor(tx: DatabaseOrTransaction): Promise<string> {
      await tx.execute(sql`set local enable_seqscan = off`);
      const rows = await tx.execute<Record<string, string>>(sql`
        explain select 1 from listing_localizations
         where search_vector @@ websearch_to_tsquery(${'french'}::regconfig, 'bicyclette')
      `);
      return rows.map((row) => Object.values(row).join(' ')).join('\n');
    }

    let planned = '';
    let mutated = '';
    try {
      await db.transaction(async (tx) => {
        planned = await planFor(tx);
        // The MUTATION, inside a transaction that is rolled back: with the index
        // gone the assertion below must fail, or it is measuring nothing.
        await tx.execute(sql`drop index listing_localizations_search_vector_idx`);
        mutated = await planFor(tx);
        tx.rollback();
      });
    } catch (error: unknown) {
      // drizzle signals `tx.rollback()` by THROWING, so the `catch` is the
      // success path. Matched on the exported CLASS and not on a message or a
      // name substring: a rethrow that only recognised the happy case would
      // swallow a real failure (`graph-plan-regression.realdb.test.ts`'s
      // spelling, reused).
      if (!(error instanceof TransactionRollbackError)) throw error;
    }

    expect(planned).toContain('listing_localizations_search_vector_idx');
    expect(
      mutated,
      'dropping the index must change the plan, or the assertion above cannot fail',
    ).not.toContain('listing_localizations_search_vector_idx');

    // …and the index is BACK, which is what makes the rollback a real rollback
    // rather than a claim the rest of the file then runs without.
    const [restored] = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
       where indexname = 'listing_localizations_search_vector_idx'
    `);
    expect(restored?.indexname).toBe('listing_localizations_search_vector_idx');
  });
});

/* -------------------------------------------------------------------------- */

describe('the browse predicate searches the requested locale beside the base text', () => {
  /**
   * `listingRepository.textMatch` through `searchListingsPage` — the function
   * `GET /listings` actually calls, not a re-spelling of its SQL. A test that
   * re-implements the code under test measures the re-implementation.
   */

  async function idsFor(text: string, locale?: string): Promise<string[]> {
    const { rows } = await searchListingsPage(
      { text, ...(locale === undefined ? {} : { locale }) },
      'newest',
      1,
      50,
      db,
    );
    return rows.map((row) => row.id);
  }

  it('finds a listing by its French title only when the French locale is asked for', async () => {
    const listingId = await createListing(
      `Velo ${RUN}`,
      'a good bicycle, sturdy and reliable, ridden little',
    );
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'fr',
      status: 'approved',
      provenance: 'professional',
      title: `Bicyclette pliante ${RUN}`,
      description: 'une bicyclette pliante, solide et fiable',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });

    expect(await idsFor('pliante', 'fr')).toContain(listingId);

    // WITHOUT the locale the predicate is what it always was, so the French word
    // reaches nothing. This is the defect, still measurable — and it is what
    // makes the case above a fact about the LOCALE rather than about the row
    // having become findable somehow.
    expect(await idsFor('pliante')).not.toContain(listingId);

    // NO REGRESSION: the base text still answers, with and without a locale.
    expect(await idsFor('sturdy')).toContain(listingId);
    expect(await idsFor('sturdy', 'fr')).toContain(listingId);
  });

  it('matches the EXACT locale and never a neighbouring market’s row', async () => {
    /*
     * `listing.title` is `seller_authored`, so `exact_locale_then_base` decides
     * what a reader is SHOWN: an `es-mx` shopper sees their own `es-mx` row or
     * the seller's base text, never the `es` row a different seller wrote for a
     * different market (ADR 0007 D4). Search has to agree, or it sends somebody
     * to a page that does not contain the word they typed.
     */
    const listingId = await createListing(`Chair ${RUN}`, 'a wooden chair in good condition');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      title: `Silla plegable ${RUN}`,
      description: 'una silla plegable de madera',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });

    expect(await idsFor('plegable', 'es')).toContain(listingId);
    expect(await idsFor('plegable', 'es-mx')).not.toContain(listingId);

    // The CONTROL for that negative: `es-mx` IS a locale the predicate searches
    // in, so the assertion above is about the ROW's locale and not about `es-mx`
    // being ignored wholesale.
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'es-mx',
      status: 'approved',
      provenance: 'professional',
      title: `Silla abatible ${RUN}`,
      description: 'una silla abatible de madera',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });
    expect(await idsFor('abatible', 'es-mx')).toContain(listingId);
  });

  it('leaves the base predicate alone for an unsupported locale, and never analyses it as English', async () => {
    const listingId = await createListing(
      `Kettle ${RUN}`,
      'a stainless kettle, boils quickly, barely used',
    );

    // `is` is Icelandic — a real BCP 47 tag Mercaria does not support. It must
    // neither refuse the browse nor change what the base half finds.
    expect(await idsFor('stainless', 'is')).toContain(listingId);
    expect(await idsFor('bouilloire', 'is')).not.toContain(listingId);

    // And the map answers `simple` for it rather than the base configuration,
    // which is what stops an unsupported locale being analysed by a stemmer that
    // knows nothing about it.
    expect(textSearchConfigurationForLocale('is')).toBe(UNANALYZED_TEXT_SEARCH_CONFIGURATION);
    expect(textSearchConfigurationForLocale('is')).not.toBe(LISTING_BASE_TEXT_SEARCH_CONFIGURATION);
  });

  it('carries the base locale itself to the base half alone', async () => {
    const listingId = await createListing(
      `Lamp ${RUN}`,
      'a brass lamp, polished and rewired, barely used',
    );
    // `en` is `MERCARIA_BASE_LOCALE`, and `_locale_not_base_check` makes a
    // base-locale localization row unrepresentable — so the subquery could only
    // ever match nothing and the predicate short-circuits to the base half.
    expect(await idsFor('polished', 'en')).toContain(listingId);
    expect(await idsFor('polished', 'en-gb')).toContain(listingId);
  });
});

/* -------------------------------------------------------------------------- */

describe('side-by-side review reads the exact locale and never falls back', () => {
  it('shows the seller’s own base text as the SOURCE and the absence as absent', async () => {
    const listingId = await createListing(`Review ${RUN}`, 'the seller’s own description');
    await db.insert(listingLocalizations).values({
      listingId,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      title: 'Título aprobado',
      reviewedByOxyUserId: 'reviewer',
      reviewedAt: new Date(),
    });

    const spanish = await reviewListingLocalization(listingId, 'es', db);
    expect(spanish).toBeDefined();
    expect(spanish.domain).toBe('listing');
    const title = spanish.fields.find((field) => field.field === 'listing.title');
    const description = spanish.fields.find((field) => field.field === 'listing.description');
    // Both base columns are NOT NULL, so unlike `category.description` this
    // screen never shows an unexplained empty source box.
    expect(title.source).toBe(`Review ${RUN}`);
    expect(description.source).toBe('the seller’s own description');
    expect(title.target.kind).toBe('present');
    // The row exists and its `description` is NULL, which is a different fact
    // from the row not existing — and only one of them means nobody has looked.
    expect(description.target.kind).toBe('absent');

    // A locale with NO row shows nothing rather than the English that would be
    // SERVED in its place: a reviewer asking "is the French approved" must never
    // be shown the fallback and told it is the French.
    const french = await reviewListingLocalization(listingId, 'fr', db);
    expect(french).toBeDefined();
    expect(french.fields.every((field) => field.target.kind === 'absent')).toBe(true);
    expect(french.fields.find((field) => field.field === 'listing.title').source).toBe(
      `Review ${RUN}`,
    );
  });

  it('carries the staleness detection this domain publishes', async () => {
    const listingId = await createListing(`Detection ${RUN}`, 'base description');
    const review = await reviewListingLocalization(listingId, 'es', db);
    expect(review.stalenessDetection.performedBy).toBe('mercaria_listings_localization_stale');
    // The claim the desk publishes beside any figure about this domain, asserted
    // against the descriptor a reviewer actually receives.
    expect([...review.stalenessDetection.watches].sort()).toEqual([
      'listings.description',
      'listings.title',
    ]);
    expect(review.stalenessDetection.unwatched).toEqual([]);
  });
});
