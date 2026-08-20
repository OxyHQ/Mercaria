/**
 * What a publication leaves behind about WHERE each typed value came from
 * (#367 step 5, ADR 0007 D7), against a REAL PostgreSQL database.
 *
 * `native_variant_axis_assignments.source_claim_id` is the audit edge the ADR
 * calls "the retained claim this typed value was derived from", and migration
 * `0104` made it enforceable at the row: a citation of a claim that did not
 * RESOLVE is refused by
 * `mercaria_native_variant_axis_assignment_scope`, because such an assignment is
 * not merely unsupported by its citation, it is CONTRADICTED by it.
 *
 * The authoring publication used to write NULL there. Legal — the column is
 * nullable for a value authored typed from the start — and a fact thrown away,
 * because this path writes the claim and the assignment in ONE transaction and
 * therefore knows the answer. That is what this file pins.
 *
 * ## Why it is a real-server file
 *
 * Every property here is one a mocked repository cannot have: the trigger that
 * validates a citation, the `ON CONFLICT DO NOTHING` convergence the read-back
 * exists for, and the deferred `mercaria_native_variant_signature_agrees`
 * constraint that fires only at COMMIT. A mocked `insert` accepts all three.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every row carries a per-run namespace token and teardown removes exactly what
 * the run created. Nothing here counts a whole table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { createDraft, patchDraft, validateStoreDraft } from '../draft.service.js';
import { publishDraft } from '../publish.service.js';
import { nsCategoryKey, nsKey, type VerticalNamespace } from '../../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import {
  createTestStore,
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';
import { E2E_PERMISSIONS, enumValueId } from '../../../__tests__/vertical-e2e/journey.js';
import { reportPopulation } from '../../../__tests__/report-population.js';

const TOKEN = verticalRunToken('cite');

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let categoryId: string;
let storeId: string;

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = phones.ns;
  const category = await findCategoryByKey(nsCategoryKey(ns, 'phones.smartphones'), db);
  if (!category) throw new Error('the seeded smartphone department did not resolve');
  categoryId = category.id;
  storeId = await createTestStore(db, TOKEN);
  await db.execute(sql`
    insert into locations (id, store_id, name, type, is_default)
    values (${`${TOKEN}-loc`}, ${storeId}, 'Citation warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);
}, 300_000);

afterAll(async () => {
  await teardownVertical(db, TOKEN);
}, 300_000);

interface PublishedListing {
  readonly listingId: string;
  readonly skus: readonly string[];
}

/**
 * Author and publish one listing with two variants on the type's two axes.
 *
 * `storage_capacity` is a MEASUREMENT and `phone_color` is CONTROLLED, which is
 * deliberate: the two kinds render their claim differently — the measurement's
 * normalized form is a base-unit magnitude and the enum's is its own canonical
 * string — so a citation that only worked for one of them would show here.
 */
async function publishOne(suffix: string, skus: readonly [string, string]): Promise<PublishedListing> {
  const draft = await createDraft(db, {
    storeId,
    actorOxyUserId: phones.actorOxyUserId,
    categoryId,
    productTypeKey: nsKey(ns, 'smartphone'),
    flow: 'merchant',
    locale: 'en',
    market: 'ES',
    permissions: E2E_PERMISSIONS,
    ttlSeconds: 3600,
    title: `Citation phone ${suffix}`,
  });

  await patchDraft(db, {
    storeId,
    draftId: draft.id,
    expectedVersion: draft.version,
    permissions: E2E_PERMISSIONS,
    description: 'A phone published to prove its typed values cite their claims.',
    fields: [
      {
        attributeKey: nsKey(ns, 'chipset'),
        values: [{ enumValueId: await enumValueId(db, ns, 'chipset', 'snapdragon_8_gen_4') }],
      },
      // A MEASUREMENT with a unit of the right family. It is here as the
      // positive control for the unit rule this branch added: if `in` were
      // refused, the draft below would not be publishable and every assertion
      // in this file would fail for the wrong reason.
      { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.9, unit: 'in' }] },
    ],
    variants: [
      {
        sku: skus[0],
        inventoryAvailable: 2,
        price: { amount: 99900, currency: 'EUR' },
        axes: [
          { attributeKey: nsKey(ns, 'storage_capacity'), values: [{ number: 256, unit: 'GB' }] },
          {
            attributeKey: nsKey(ns, 'phone_color'),
            values: [{ enumValueId: await enumValueId(db, ns, 'phone_color', 'black') }],
          },
        ],
      },
      {
        sku: skus[1],
        inventoryAvailable: 1,
        price: { amount: 99900, currency: 'EUR' },
        axes: [
          { attributeKey: nsKey(ns, 'storage_capacity'), values: [{ number: 512, unit: 'GB' }] },
          {
            attributeKey: nsKey(ns, 'phone_color'),
            values: [{ enumValueId: await enumValueId(db, ns, 'phone_color', 'black') }],
          },
        ],
      },
    ],
  });

  const validation = await validateStoreDraft(db, {
    storeId,
    draftId: draft.id,
    permissions: E2E_PERMISSIONS,
  });
  expect(
    validation.publishable,
    `the draft is not publishable: ${JSON.stringify(validation.findings)}`,
  ).toBe(true);

  const publication = await publishDraft(db, {
    storeId,
    draftId: draft.id,
    actorOxyUserId: phones.actorOxyUserId,
    permissions: E2E_PERMISSIONS,
    idempotencyKey: null,
  });
  if (publication.outcome !== 'published') {
    throw new Error(`expected a publication, got ${publication.outcome}`);
  }
  return { listingId: publication.listingId, skus };
}

describe('every typed axis value a publication writes CITES the claim it came from', () => {
  let published: PublishedListing;

  beforeAll(async () => {
    published = await publishOne('A', [`${TOKEN}-A-BLK`, `${TOKEN}-A-WHT`]);
  }, 300_000);

  /**
   * #367 box 11 (ADR 0007 D5/D10/D13): the PUBLISHED write pins the exact
   * product-type version its answers were given under.
   *
   * Asserted end to end and against the DRAFT's own pin rather than against a
   * literal, because the failure this guards is not "the column is empty" — it
   * is the column carrying a DIFFERENT version from the one the author actually
   * answered, which a composition re-derived at publish time would produce and
   * which no assertion on a hardcoded id could ever see.
   *
   * The draft-side value is asserted non-null in the same statement: it is the
   * positive control, and without it a publication that wrote NULL into both
   * would satisfy an equality check.
   */
  it('carries the DRAFT\'s product-type version onto the listing', async () => {
    const [row] = await db.execute<{
      listing_pin: string | null;
      draft_pin: string | null;
    }>(sql`
      select l.product_type_definition_id as listing_pin,
             d.product_type_definition_id as draft_pin
        from listings l
        join catalog_authoring_drafts d on d.published_listing_id = l.id
       where l.id = ${published.listingId}
    `);

    expect(row, 'the published listing and its draft should both be readable').toBeDefined();
    expect(row?.draft_pin, 'the draft pinned no version — the fixture is vacuous').not.toBeNull();
    expect(row?.listing_pin).toBe(row?.draft_pin);
  });

  it('writes one assignment per axis per variant, and every one names a claim', async () => {
    const rows = [
      ...(await db.execute<{
        assignment_id: string;
        source_claim_id: string | null;
        attribute_key: string;
        normalized_value: string;
      }>(sql`
        select a.id as assignment_id, a.source_claim_id, a.attribute_key, a.normalized_value
          from native_variant_axis_assignments a
          join product_variants v on v.id = a.variant_id
         where v.listing_id = ${published.listingId}
         order by a.attribute_key, a.normalized_value
      `)),
    ];

    // The population, printed on SUCCESS. Two variants × two axes — a run that
    // published nothing would otherwise satisfy every loop below.
    reportPopulation(`[census] axis assignments for this listing: ${rows.length}`);
    expect(rows).toHaveLength(4);

    const uncited = rows.filter((row) => row.source_claim_id === null);
    expect(
      uncited.map((row) => `${row.attribute_key}=${row.normalized_value}`),
      'these typed values cite no claim, so nothing records which assertion produced them',
    ).toEqual([]);
  });

  it('the cited claim is about the SAME variant and RESOLVED — the trigger’s own rule', async () => {
    const rows = [
      ...(await db.execute<{
        same_variant: boolean;
        value_resolution: string;
        attribute_resolution: string;
        raw_value: string;
        claim_normalized: string;
        assignment_normalized: string;
        provenance: string;
      }>(sql`
        select (c.variant_id = a.variant_id) as same_variant,
               c.value_resolution,
               c.attribute_resolution,
               c.raw_value,
               c.normalized_value as claim_normalized,
               a.normalized_value as assignment_normalized,
               c.provenance
          from native_variant_axis_assignments a
          join product_variants v on v.id = a.variant_id
          join native_variant_attribute_claims c on c.id = a.source_claim_id
         where v.listing_id = ${published.listingId}
      `)),
    ];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.same_variant).toBe(true);
      expect(row.value_resolution).toBe('resolved');
      expect(row.attribute_resolution).toBe('resolved');
      // A merchant's answer is a merchant's assertion. `legacy_option_migration`
      // here would mean the publication had attributed the value to the
      // migration that preserves pre-typed text.
      expect(row.provenance).toBe('merchant_declared');
      // The claim's typed form and the assignment's are the SAME string —
      // `normalizeAxisValue` applied once, by the same call. A citation whose
      // two sides disagreed would point at an assertion about a different value.
      expect(row.claim_normalized).toBe(row.assignment_normalized);
    }
  });

  it('every claim this listing produced is settled, so none of it lands in the review queue', async () => {
    // ADR 0007 D7's reason for writing these claims RESOLVED: the authoring path
    // is the one writer that knows the registry answer, and recording it
    // unresolved would make the queue depth a measure of how many products were
    // authored correctly.
    const [row] = [
      ...(await db.execute<{ total: number; queued: number }>(sql`
        select count(*)::int as total,
               count(*) filter (
                 where c.attribute_resolution <> 'resolved' or c.value_resolution <> 'resolved'
               )::int as queued
          from native_variant_attribute_claims c
          join product_variants v on v.id = c.variant_id
         where v.listing_id = ${published.listingId}
      `)),
    ];
    reportPopulation(`[census] variant claims for this listing: ${row?.total ?? 0}`);
    expect(row?.total).toBe(4);
    expect(row?.queued).toBe(0);
  });

  it('the product-scope answers are listing-grain claims, also settled', async () => {
    const [row] = [
      ...(await db.execute<{ total: number; kinds: string }>(sql`
        select count(*)::int as total, string_agg(distinct kind, ',') as kinds
          from native_listing_attribute_claims
         where listing_id = ${published.listingId}
           and provenance = 'merchant_declared'
      `)),
    ];
    // `chipset` and `screen_size` — the two product-scope fields the draft
    // answered. Named, not merely non-zero.
    expect(row?.total).toBe(2);
    expect(row?.kinds).toBe('attribute_value');
  });
});

describe('a second publication of the same values converges rather than duplicating', () => {
  it('writes its own claims and its own citations, scoped to its own listing', async () => {
    // Two listings in one store carrying the same colour. The claim identity key
    // is per VARIANT, so these are genuinely different rows — and the citation
    // must follow each listing's own claim rather than the first one written.
    const second = await publishOne('B', [`${TOKEN}-B-BLK`, `${TOKEN}-B-WHT`]);

    const [row] = [
      ...(await db.execute<{ total: number; cited: number; foreign_claims: number }>(sql`
        select count(*)::int as total,
               count(a.source_claim_id)::int as cited,
               count(*) filter (where c.variant_id <> a.variant_id)::int as foreign_claims
          from native_variant_axis_assignments a
          join product_variants v on v.id = a.variant_id
          left join native_variant_attribute_claims c on c.id = a.source_claim_id
         where v.listing_id = ${second.listingId}
      `)),
    ];
    expect(row?.total).toBe(4);
    expect(row?.cited).toBe(4);
    expect(row?.foreign_claims).toBe(0);
  });
});
