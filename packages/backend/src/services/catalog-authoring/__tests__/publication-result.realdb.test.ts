/**
 * What a publication REPORTS (#367 step 5, #577), against a REAL PostgreSQL
 * database.
 *
 * The box asks for "a complete publication result with created IDs and any
 * pending review/matching state", and the failure it guards against is a result
 * that reports a SUBSET of what happened — because a subset and a complete
 * answer are indistinguishable to a caller. A result naming two of three
 * variants reads exactly like a listing with two variants.
 *
 * ## Three controls, and none of them is the composer restated
 *
 * 1. **An independent instrument.** Every expectation is built by raw SQL
 *    against the tables, never by calling the repositories
 *    `composePublicationResult` calls. Two spellings of one derivation can
 *    agree while both are wrong; two genuinely different readings of the same
 *    ROWS cannot.
 * 2. **Two variants that must answer DIFFERENTLY.** One carries an author's
 *    canonical selection and one does not, so a composer that defaulted every
 *    variant to one resolution — the cheapest way to be silently wrong — fails
 *    here. A fixture whose variants all resolved the same way could not see it.
 * 3. **A convergence must be DEEP EQUAL to the publication.** This is the one
 *    that pins #577's own design rule: the result is derived from the LISTING,
 *    not accumulated as the transaction goes. An accumulating implementation
 *    passes every other assertion in this file and fails this one, because a
 *    convergence created nothing to accumulate.
 *
 * ## Why it is a real-server file
 *
 * The pairing under test is `product_variants.position` against the draft's, and
 * it is produced by an INSERT whose row order a mocked repository does not have.
 * The queued-claim figure comes from a scoped aggregate, and the canonical link
 * is subject to a partial unique. None of the three exists without a server.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every row carries a per-run namespace token, every aggregate is scoped to the
 * listing this run created, and teardown removes exactly what the run created.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import { findCategoryByKey } from '../../../db/taxonomy/taxonomyRepository.js';
import { createDraft, patchDraft, validateStoreDraft } from '../draft.service.js';
import { publishDraft, type DraftPublication } from '../publish.service.js';
import {
  countQueuedClaims,
  recordVariantAttributeClaim,
} from '../../../db/variantAxes/attributeClaimRepository.js';
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

const TOKEN = verticalRunToken('pubres');

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
    values (${`${TOKEN}-loc`}, ${storeId}, 'Result warehouse', 'warehouse', true)
    on conflict (id) do nothing
  `);
}, 300_000);

afterAll(async () => {
  await teardownVertical(db, TOKEN);
}, 300_000);

/** A seeded canonical configuration, chosen from the handles rather than named. */
function someAxonVariantId(): string {
  for (const [key, id] of phones.handles.variantIds) {
    if (key.startsWith('axon-')) return id;
  }
  throw new Error('the smartphone package seeded no axon configuration');
}

interface Published {
  readonly draftId: string;
  readonly result: DraftPublication;
}

/**
 * Author and publish one listing whose TWO variants must answer differently.
 *
 * Position 0 carries the author's canonical selection and position 1 carries
 * none, which is what makes `resolution` a measurement here rather than a
 * constant the fixture happens to agree with.
 */
async function publishTwoVariantListing(idempotencyKey: string | null): Promise<Published> {
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
    title: 'A phone published to prove its result is whole',
  });

  await patchDraft(db, {
    storeId,
    draftId: draft.id,
    expectedVersion: draft.version,
    permissions: E2E_PERMISSIONS,
    description: 'Two variants, one declared and one left to the matcher.',
    fields: [
      {
        attributeKey: nsKey(ns, 'chipset'),
        values: [{ enumValueId: await enumValueId(db, ns, 'chipset', 'snapdragon_8_gen_4') }],
      },
      { attributeKey: nsKey(ns, 'screen_size'), values: [{ number: 6.9, unit: 'in' }] },
    ],
    variants: [
      {
        sku: `${TOKEN}-DECLARED`,
        inventoryAvailable: 2,
        price: { amount: 99900, currency: 'EUR' },
        selectedCanonicalVariantId: someAxonVariantId(),
        axes: [
          { attributeKey: nsKey(ns, 'storage_capacity'), values: [{ number: 256, unit: 'GB' }] },
          {
            attributeKey: nsKey(ns, 'phone_color'),
            values: [{ enumValueId: await enumValueId(db, ns, 'phone_color', 'black') }],
          },
        ],
      },
      {
        sku: `${TOKEN}-QUEUED`,
        inventoryAvailable: 1,
        price: { amount: 89900, currency: 'EUR' },
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

  const result = await publishDraft(db, {
    storeId,
    draftId: draft.id,
    actorOxyUserId: phones.actorOxyUserId,
    permissions: E2E_PERMISSIONS,
    idempotencyKey,
  });
  return { draftId: draft.id, result };
}

/** The publication branch, or a failure that says which branch arrived instead. */
function publicationOf(result: DraftPublication): Extract<DraftPublication, { listingId: string }> {
  if (result.outcome === 'refused') {
    throw new Error(`expected a publication, got a refusal: ${JSON.stringify(result.validation)}`);
  }
  return result;
}

describe('a publication result reports the whole publication', () => {
  let published: Published;

  beforeAll(async () => {
    published = await publishTwoVariantListing(`${TOKEN}-key`);
  }, 300_000);

  it('names every variant the listing actually has, paired by position', async () => {
    const { publication } = publicationOf(published.result);

    // The independent instrument: raw SQL, joined draft-side to listing-side by
    // position, which is the pairing the composer claims. Nothing here calls a
    // repository the composer calls.
    const rows = await db.execute<{
      product_variant_id: string;
      position: number;
      draft_variant_id: string;
    }>(sql`
      select pv.id as product_variant_id,
             pv.position as position,
             dv.id as draft_variant_id
        from product_variants pv
        join catalog_authoring_draft_variants dv
          on dv.draft_id = ${published.draftId} and dv.position = pv.position
       where pv.listing_id = ${publication.listingId}
       order by pv.position
    `);

    // The fixture's own shape, so none of the comparisons below is over an
    // empty set — the vacuity floor this file's claims rest on.
    expect(rows.length, 'the fixture published no variants').toBe(2);

    expect(publication.variants.map((variant) => variant.position)).toEqual(
      rows.map((row) => row.position),
    );
    expect(publication.variants.map((variant) => variant.productVariantId)).toEqual(
      rows.map((row) => row.product_variant_id),
    );
    expect(publication.variants.map((variant) => variant.draftVariantId)).toEqual(
      rows.map((row) => row.draft_variant_id),
    );
    // Not one of them is the empty-string fallback the composer falls back to
    // when a position pairs with nothing — which would otherwise satisfy the
    // equality above only if BOTH sides were wrong the same way.
    expect(publication.variants.every((variant) => variant.draftVariantId !== '')).toBe(true);
  });

  it('separates the DECLARED variant from the one left to the matcher', async () => {
    const { publication } = publicationOf(published.result);

    const links = await db.execute<{ product_variant_id: string; canonical_variant_id: string }>(sql`
      select product_variant_id, canonical_variant_id
        from native_listing_links
       where listing_id = ${publication.listingId}
         and status = 'active'
         and method = 'merchant_declared'
    `);
    // Two variants, exactly one of them declared: the control that makes
    // `resolution` a measurement. A composer answering one value for everything
    // fails one of the two assertions below whichever value it picked.
    expect(links.length, 'the fixture declared no canonical link').toBe(1);

    const declared = publication.variants.filter(
      (variant) => variant.resolution === 'merchant_declared',
    );
    const queued = publication.variants.filter(
      (variant) => variant.resolution === 'queued_for_matching',
    );
    expect(declared).toHaveLength(1);
    expect(queued).toHaveLength(1);
    expect(declared[0]?.productVariantId).toBe(links[0]?.product_variant_id);
    expect(declared[0]?.canonicalVariantId).toBe(links[0]?.canonical_variant_id);
    // The queued one carries NO canonical id, because the only link this path
    // writes is the author's and the matcher has not run.
    expect(queued[0]?.canonicalVariantId).toBeNull();

    expect(publication.review.merchantDeclaredCount).toBe(1);
    expect(publication.review.queuedForMatchingCount).toBe(1);
  });

  it('counts the typed rows each variant actually carries', async () => {
    const { publication } = publicationOf(published.result);

    const rows = await db.execute<{
      variant_id: string;
      assignments: string;
      claims: string;
      signature: string | null;
    }>(sql`
      select pv.id as variant_id,
             (select count(*) from native_variant_axis_assignments a where a.variant_id = pv.id)
               as assignments,
             (select count(*) from native_variant_attribute_claims c
               where c.variant_id = pv.id and c.provenance = 'merchant_declared') as claims,
             (select s.signature from native_variant_signatures s where s.variant_id = pv.id)
               as signature
        from product_variants pv
       where pv.listing_id = ${publication.listingId}
       order by pv.position
    `);
    // Both variants answered two axes, so a composer reporting zero — or
    // reporting the LISTING's total against every variant — is visible.
    expect(rows.map((row) => Number(row.assignments))).toEqual([2, 2]);

    for (const [index, row] of rows.entries()) {
      const variant = publication.variants[index];
      expect(variant?.axisAssignmentCount).toBe(Number(row.assignments));
      expect(variant?.merchantDeclaredClaimCount).toBe(Number(row.claims));
      expect(variant?.axisSignature).toBe(row.signature);
      expect(variant?.axisSignature, 'the variant has no typed identity').not.toBeNull();
    }

    const [listingTotals] = await db.execute<{ axes: string; claims: string }>(sql`
      select (select count(*) from native_listing_variant_axes a where a.listing_id = ${publication.listingId})
               as axes,
             (select count(*) from native_listing_attribute_claims c
               where c.listing_id = ${publication.listingId} and c.provenance = 'merchant_declared')
               as claims
    `);
    expect(publication.declaredAxisCount).toBe(Number(listingTotals?.axes));
    expect(publication.declaredAxisCount, 'the listing declared no axes').toBeGreaterThan(0);
    expect(publication.listingClaimCount).toBe(Number(listingTotals?.claims));
    expect(publication.listingClaimCount, 'the listing recorded no claims').toBeGreaterThan(0);
  });

  /**
   * The scope is load-bearing, and it needed a POSITIVE CONTROL to be provable.
   *
   * Measured first without one: dropping `{ listingIds: [listingId] }` from
   * `countQueuedClaims` left this file GREEN, because the authoring path writes
   * its claims already resolved and nothing else in the database had a queued
   * one — so the scoped and the unscoped count were both zero and the assertion
   * could not tell them apart. A check whose subject does not exist measures
   * nothing however carefully it is written.
   *
   * So this seeds a queued claim on ANOTHER listing this run owns, proves it
   * landed by reading the UNSCOPED count, and then re-derives the first
   * listing's result. Scoped it is zero; unscoped it could not be.
   */
  it('reports the queued-claim backlog for THIS listing, not the deployment', async () => {
    const { publication } = publicationOf(published.result);
    const [before] = await db.execute<{ queued: string }>(sql`
      select count(*) as queued
        from native_variant_attribute_claims c
        join product_variants pv on pv.id = c.variant_id
       where pv.listing_id = ${publication.listingId}
         and (c.attribute_resolution <> 'resolved' or c.value_resolution <> 'resolved')
    `);
    expect(publication.review.queuedAttributeClaimCount).toBe(Number(before?.queued));

    const neighbour = await publishTwoVariantListing(null);
    const neighbourListingId = publicationOf(neighbour.result).listingId;
    const [neighbourVariant] = await db.execute<{ id: string }>(sql`
      select id from product_variants where listing_id = ${neighbourListingId} order by position limit 1
    `);
    if (neighbourVariant === undefined) throw new Error('the neighbour listing has no variant');

    // `legacy_option_migration` and the DEFAULT resolutions, which are
    // `unresolved` on both halves — the shape the #367 backfill writes and the
    // one that actually populates the review queue. Not `connector_import`:
    // `native_variant_attribute_claims_connector_provenance_check` requires a
    // `source_connection_id` beside it, and this run has no connection. (Found
    // by the server refusing the first attempt, which is the reason this file
    // runs against one.)
    await recordVariantAttributeClaim(db, {
      variantId: neighbourVariant.id,
      rawName: `${TOKEN}-unresolved-axis`,
      rawValue: 'a value nobody has resolved',
      provenance: 'legacy_option_migration',
      assertedAt: new Date(),
    });

    const global = await countQueuedClaims(db);
    expect(global.queued, 'the seeded queued claim did not land').toBeGreaterThan(0);

    // Re-derived AFTER the seed, through a convergence — so it is composed
    // against a database whose global backlog is now non-zero.
    const converged = publicationOf(
      await publishDraft(db, {
        storeId,
        draftId: published.draftId,
        actorOxyUserId: phones.actorOxyUserId,
        permissions: E2E_PERMISSIONS,
        idempotencyKey: null,
      }),
    );
    expect(converged.publication.review.queuedAttributeClaimCount).toBe(0);
  });

  it('reports the proposals still open against the draft', async () => {
    const { publication } = publicationOf(published.result);
    const rows = await db.execute<{ proposal_id: string }>(sql`
      select p.id as proposal_id
        from catalog_proposal_references r
        join catalog_proposals p on p.id = r.proposal_id
       where r.draft_id = ${published.draftId}
         and p.state in ('submitted', 'in_review', 'needs_more_info')
    `);
    expect([...publication.review.openProposalIds].sort()).toEqual(
      rows.map((row) => row.proposal_id).sort(),
    );
  });
});

describe('a convergence answers identically to the publication it converges on', () => {
  /**
   * #577's design rule, as the one assertion that can refute it.
   *
   * An implementation that accumulated ids while the transaction wrote them
   * passes every assertion in the block above and fails here: the converging
   * call created nothing, so it would have nothing to report. Deep equality is
   * what makes "derived from the listing" a property rather than an intention.
   */
  it('is DEEP EQUAL apart from the outcome, on BOTH converge paths', async () => {
    const first = await publishTwoVariantListing(`${TOKEN}-converge`);
    const original = publicationOf(first.result).publication;
    expect(original.outcome).toBe('published');

    // Path 1: the draft is already published, whatever key arrives.
    const again = await publishDraft(db, {
      storeId,
      draftId: first.draftId,
      actorOxyUserId: phones.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: null,
    });
    const converged = publicationOf(again).publication;
    expect(converged.outcome).toBe('converged');
    expect({ ...converged, outcome: 'published' }).toEqual(original);

    // Path 2: the same idempotency key, which resolves through the prior-draft
    // read rather than through the draft's own status.
    const byKey = await publishDraft(db, {
      storeId,
      draftId: first.draftId,
      actorOxyUserId: phones.actorOxyUserId,
      permissions: E2E_PERMISSIONS,
      idempotencyKey: `${TOKEN}-converge`,
    });
    const convergedByKey = publicationOf(byKey).publication;
    expect(convergedByKey.outcome).toBe('converged');
    expect({ ...convergedByKey, outcome: 'published' }).toEqual(original);

    // The vacuity floor on the equality: an answer of two empty results would
    // satisfy `toEqual` and prove nothing.
    expect(original.variants).toHaveLength(2);
    expect(original.review.merchantDeclaredCount).toBe(1);
  });
});
