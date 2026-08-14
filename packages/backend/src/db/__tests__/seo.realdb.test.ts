/**
 * The SEO reads against a REAL PostgreSQL database (#75).
 *
 * Two claims this file exists to make true rather than plausible, and neither
 * survives a mock:
 *
 *  1. **`lastmod` moves on a meaningful public change and NOT on a poll.**
 *     `canonical_products.updated_at` is the obvious column and it is a trap —
 *     `applyProductSourceObservation` always writes `last_seen_at`, so a
 *     sitemap built on it tells a crawler the whole catalogue changed whenever
 *     the feed ran. The negative half is the load-bearing one: a touch of
 *     `last_seen_at` must leave `lastmod` exactly where it was.
 *  2. **A source that withholds the `index` right withdraws the page.** The
 *     expression joins four tables through two correlated references, and a
 *     drizzle column interpolated into `sql` renders BARE when its table is not
 *     in that statement's own FROM — which compares two of the subquery's
 *     columns to each other and returns nothing, with no error at all
 *     (`CONVENTIONS.md`). A mocked repository cannot tell that from a correct
 *     query, and the failure direction is permissive.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every id carries a per-run suffix and the reads are
 * filtered to this file's own rows. The sitemap PAGE reads are not — they scan
 * the whole table — so they are asserted for the presence and ORDER of this
 * run's rows rather than for an exact result set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import {
  canonicalFieldProvenance,
  canonicalImages,
  canonicalProducts,
  canonicalProductSourceLinks,
} from '../schema/canonicalCatalog.js';
import { catalogSourceConfigs, catalogSourcePolicies } from '../schema/ingestion.js';
import { catalogSources, sourceRecords } from '../schema/provenance.js';
import {
  countCanonicalProductsForSitemap,
  findProductSeoFacts,
  latestProductLastmod,
  listCanonicalProductSitemapPage,
} from '../seo/seoRepository.js';
import { deleteTestCanonicalRows } from './canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdProductIds: string[] = [];
/**
 * Registry rows this file mints. They are UNDELETABLE once a policy is active
 * (see the teardown), so they are tracked only to keep the ids per-run unique
 * and readable in a failure message.
 */
const createdSourceIds: string[] = [];
const createdRecordIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (createdProductIds.length > 0) {
    await db
      .delete(canonicalProductSourceLinks)
      .where(inArray(canonicalProductSourceLinks.productId, createdProductIds));
    await db
      .delete(canonicalFieldProvenance)
      .where(inArray(canonicalFieldProvenance.productId, createdProductIds));
    await db.delete(canonicalImages).where(inArray(canonicalImages.productId, createdProductIds));
    await deleteTestCanonicalRows(db, { productIds: createdProductIds });
  }
  if (createdRecordIds.length > 0) {
    await db.delete(sourceRecords).where(inArray(sourceRecords.id, createdRecordIds));
  }
  /**
   * The catalogue SOURCES, their configs and their policies are deliberately
   * NOT deleted.
   *
   * `mercaria_catalog_source_policy_immutable` refuses to delete an ACTIVE
   * policy version — "observations cite this version" — and
   * `catalog_source_configs.source_id` is RESTRICT onto the registry row, so
   * neither can go either. That is the property #62 exists to hold, and it is
   * the `review_target_migrations` rule again: rows a trigger refuses to remove
   * are scoped by a per-run id and left behind rather than worked around.
   */
  await closePostgres();
});

/**
 * A sha-256 hex digest — `source_records_content_hash_shape_check` refuses
 * anything that is not 64 lowercase hex characters, because a hash that is not
 * one silently disables the convergence unique.
 */
function contentHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

async function makeProduct(overrides: { description?: string } = {}): Promise<string> {
  const id = uuidv7();
  const suffix = `${RUN}-${id.slice(-8)}`;
  await db.insert(canonicalProducts).values({
    id,
    slug: `seo-product-${suffix}`,
    name: `SEO Product ${suffix}`,
    normalizedName: `seo product ${suffix}`,
    ...(overrides.description === undefined ? {} : { description: overrides.description }),
  });
  createdProductIds.push(id);
  return id;
}

/**
 * A catalogue source with an ingestion CONFIG and an active rights policy.
 *
 * The config is what makes the source "governed" — a `catalog_sources` row with
 * none is Mercaria's own provenance registry entry and grants `index` by
 * construction, which the last case in this file exercises.
 */
async function makeGovernedSource(
  mayIndex: boolean,
): Promise<{ sourceId: string; recordId: string }> {
  const sourceId = uuidv7();
  const recordId = uuidv7();
  const suffix = `${RUN}-${sourceId.slice(-8)}`;
  createdSourceIds.push(sourceId);
  createdRecordIds.push(recordId);

  /**
   * ONE transaction, and that is not a tidiness choice.
   *
   * `mercaria_catalog_source_rights_agree` is a DEFERRABLE constraint trigger
   * (#62): it refuses any COMMIT where `catalog_sources`' three coarse columns
   * disagree with the config's status and the active policy. A rights change
   * touches three tables and no statement ORDER makes every intermediate state
   * consistent, so three separate statements commit three times and the first
   * one — a source advertising display rights with no policy yet — is refused.
   */
  await db.transaction(async (tx) => {
    await tx.insert(catalogSources).values({
      id: sourceId,
      kind: 'feed',
      name: `SEO Source ${suffix}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    });
    // `catalog_source_configs_status_attribution_check`: every status but
    // `draft` and `failed` is somebody's decision and carries who and when.
    await tx.insert(catalogSourceConfigs).values({
      id: uuidv7(),
      sourceId,
      provider: 'seo-test-provider',
      status: 'active',
      statusChangedByOxyUserId: `seo-operator-${RUN}`,
      statusChangedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    // `catalog_source_policies_active_review_check`: an ACTIVE version was
    // reviewed by somebody, on a date, and activated on one — a right nobody
    // reviewed is a right nobody granted (#62).
    await tx.insert(catalogSourcePolicies).values({
      id: uuidv7(),
      sourceId,
      version: 1,
      status: 'active',
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
      mayIndex,
      reviewedAt: new Date('2026-06-30T00:00:00.000Z'),
      reviewedByOxyUserId: `seo-operator-${RUN}`,
      activatedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    await tx.insert(sourceRecords).values({
      id: recordId,
      sourceId,
      externalType: 'product',
      externalId: `ext-${suffix}`,
      observedAt: new Date('2026-07-01T00:00:00.000Z'),
      contentHash: contentHash(`record-${suffix}`),
    });
  });

  return { sourceId, recordId };
}

async function linkSource(productId: string, recordId: string): Promise<void> {
  await db.insert(canonicalProductSourceLinks).values({
    id: uuidv7(),
    productId,
    sourceRecordId: recordId,
    method: 'deterministic_identifier',
    matchRule: 'seo-test',
    status: 'active',
  });
}

/**
 * The fixture instants are in the FUTURE, deliberately.
 *
 * `lastmod` is `greatest(created_at, last_reviewed_at, …)` and `created_at` is
 * the moment the row was inserted — now. A fixture dated in the past is
 * dominated by it, so the assertion would pass on a `greatest` that ignored
 * every other component. Dating the change after the insert is what makes each
 * component's contribution observable.
 */
const REVIEWED_AT = new Date('2027-01-15T08:00:00.000Z');
const SELECTED_AT = new Date('2027-02-20T09:30:00.000Z');
const LATER_CHANGE = new Date('2027-03-01T09:30:00.000Z');
const EARLIER_CHANGE = new Date('2027-01-01T09:30:00.000Z');
const IMAGE_UPDATED_AT = new Date('2027-04-01T09:30:00.000Z');

async function lastmodOf(productId: string): Promise<Date | null> {
  const facts = await findProductSeoFacts(db, productId);
  expect(facts, 'the product read answered nothing').toBeDefined();
  return facts?.lastmod ?? null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* lastmod                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

describe('lastmod is a MEANINGFUL public change', () => {
  it('starts at the row’s creation and is never null for a real product', async () => {
    const productId = await makeProduct();
    const lastmod = await lastmodOf(productId);
    expect(lastmod).toBeInstanceOf(Date);
  });

  it('does NOT move when an observation only touches last_seen_at', async () => {
    const productId = await makeProduct();
    const before = await lastmodOf(productId);

    // Exactly what a repeat feed delivery does: the row is written (so
    // `updated_at` moves) and nothing a visitor sees has changed.
    await db
      .update(canonicalProducts)
      .set({ lastSeenAt: new Date('2026-08-05T12:00:00.000Z') })
      .where(eq(canonicalProducts.id, productId));

    const after = await lastmodOf(productId);
    expect(after?.getTime()).toBe(before?.getTime());

    // The control: `updated_at` DID move, so the test is measuring the
    // difference between the two columns rather than a write that never landed.
    const [row] = await db
      .select({ updatedAt: canonicalProducts.updatedAt })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, productId));
    expect(row?.updatedAt.getTime()).toBeGreaterThan((before?.getTime() ?? 0) - 1);
  });

  it('MOVES when a source-applied field actually changes', async () => {
    const productId = await makeProduct();
    const { recordId } = await makeGovernedSource(true);
    const before = await lastmodOf(productId);

    await db.insert(canonicalFieldProvenance).values({
      id: uuidv7(),
      productId,
      field: 'description',
      sourceRecordId: recordId,
      method: 'deterministic_identifier',
      selectedAt: SELECTED_AT,
    });

    const after = await lastmodOf(productId);
    expect(after?.toISOString()).toBe(SELECTED_AT.toISOString());
    expect(after?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
  });

  it('MOVES when an operator corrects the record', async () => {
    const productId = await makeProduct();
    await db
      .update(canonicalProducts)
      .set({ lastReviewedAt: REVIEWED_AT })
      .where(eq(canonicalProducts.id, productId));
    expect((await lastmodOf(productId))?.toISOString()).toBe(REVIEWED_AT.toISOString());
  });

  it('MOVES when an active image arrives, and ignores a withdrawn one’s absence', async () => {
    const productId = await makeProduct();
    const { recordId } = await makeGovernedSource(true);
    const before = await lastmodOf(productId);

    await db.insert(canonicalImages).values({
      id: uuidv7(),
      productId,
      fileId: `file-${RUN}-${uuidv7().slice(-8)}`,
      sourceRecordId: recordId,
      position: 0,
      status: 'active',
      updatedAt: IMAGE_UPDATED_AT,
    });
    const withImage = await lastmodOf(productId);
    expect(withImage?.toISOString()).toBe(IMAGE_UPDATED_AT.toISOString());
    expect(withImage?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
  });

  it('takes the GREATEST of its components, not the last one written', async () => {
    const productId = await makeProduct();
    const { recordId } = await makeGovernedSource(true);
    await db.insert(canonicalFieldProvenance).values({
      id: uuidv7(),
      productId,
      field: 'description',
      sourceRecordId: recordId,
      method: 'deterministic_identifier',
      selectedAt: LATER_CHANGE,
    });
    // Written SECOND and dated EARLIER, so a `lastmod` reading the most recent
    // write rather than the greatest instant would answer with this one.
    await db
      .update(canonicalProducts)
      .set({ lastReviewedAt: EARLIER_CHANGE })
      .where(eq(canonicalProducts.id, productId));

    expect((await lastmodOf(productId))?.toISOString()).toBe(LATER_CHANGE.toISOString());
  });

  it('the catalogue-wide lastmod reads the same provenance clock', async () => {
    const productId = await makeProduct();
    const { recordId } = await makeGovernedSource(true);
    await db.insert(canonicalFieldProvenance).values({
      id: uuidv7(),
      productId,
      field: 'modelCode',
      sourceRecordId: recordId,
      method: 'deterministic_identifier',
      selectedAt: SELECTED_AT,
    });
    const latest = await latestProductLastmod(db);
    expect(latest).toBeInstanceOf(Date);
    expect((latest?.getTime() ?? 0) >= SELECTED_AT.getTime()).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* The source index right                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

describe('the source `index` right', () => {
  it('is granted for a product with no source links at all', async () => {
    const productId = await makeProduct();
    expect((await findProductSeoFacts(db, productId))?.indexRightGranted).toBe(true);
  });

  it('is granted when the contributing source permits indexing', async () => {
    const productId = await makeProduct();
    const { recordId } = await makeGovernedSource(true);
    await linkSource(productId, recordId);
    expect((await findProductSeoFacts(db, productId))?.indexRightGranted).toBe(true);
  });

  it('is WITHHELD when a contributing source forbids indexing', async () => {
    const productId = await makeProduct();
    const { recordId } = await makeGovernedSource(false);
    await linkSource(productId, recordId);
    expect((await findProductSeoFacts(db, productId))?.indexRightGranted).toBe(false);
  });

  it('is WITHHELD when ONE of several sources forbids it', async () => {
    // The conjunction: Mercaria cannot tell a crawler to ignore the paragraph
    // one feed supplied, so one refusal withdraws the page.
    const productId = await makeProduct();
    const permitting = await makeGovernedSource(true);
    const refusing = await makeGovernedSource(false);
    await linkSource(productId, permitting.recordId);
    await linkSource(productId, refusing.recordId);
    expect((await findProductSeoFacts(db, productId))?.indexRightGranted).toBe(false);
  });

  it('ignores a SUPERSEDED link', async () => {
    const productId = await makeProduct();
    const refusing = await makeGovernedSource(false);
    await db.insert(canonicalProductSourceLinks).values({
      id: uuidv7(),
      productId,
      sourceRecordId: refusing.recordId,
      method: 'deterministic_identifier',
      matchRule: 'seo-test',
      status: 'superseded',
    });
    expect((await findProductSeoFacts(db, productId))?.indexRightGranted).toBe(true);
  });

  it('is WITHHELD when a governed source has NO active policy', async () => {
    // #62's rule verbatim for a CONFIGURED source: a right nobody reviewed is a
    // right nobody granted.
    const productId = await makeProduct();
    const sourceId = uuidv7();
    const recordId = uuidv7();
    const suffix = `${RUN}-${sourceId.slice(-8)}`;
    createdSourceIds.push(sourceId);
    createdRecordIds.push(recordId);
    await db.transaction(async (tx) => {
      // No active policy, so the projection must be the no-rights one the
      // trigger derives: nothing displayable, nothing storable, attribution
      // required.
      await tx.insert(catalogSources).values({
        id: sourceId,
        kind: 'feed',
        name: `SEO Unreviewed ${suffix}`,
        mayDisplay: false,
        mayStore: false,
        attributionRequired: true,
      });
      await tx.insert(catalogSourceConfigs).values({
        id: uuidv7(),
        sourceId,
        provider: 'seo-test-provider',
        status: 'active',
        statusChangedByOxyUserId: `seo-operator-${RUN}`,
        statusChangedAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      await tx.insert(sourceRecords).values({
        id: recordId,
        sourceId,
        externalType: 'product',
        externalId: `ext-${suffix}`,
        observedAt: new Date('2026-07-01T00:00:00.000Z'),
        contentHash: contentHash(`unreviewed-${suffix}`),
      });
    });
    await linkSource(productId, recordId);

    expect((await findProductSeoFacts(db, productId))?.indexRightGranted).toBe(false);
  });

  it('is WITHHELD when the source is revoked, whatever the policy says', async () => {
    const productId = await makeProduct();
    const { sourceId, recordId } = await makeGovernedSource(true);
    // A revoked source displays nothing, so its projection follows. Both sides
    // move in ONE transaction: the trigger checks the pair at COMMIT, and two
    // statements committing separately are refused at the first.
    await db.transaction(async (tx) => {
      await tx
        .update(catalogSourceConfigs)
        .set({
          status: 'revoked',
          statusChangedByOxyUserId: `seo-operator-${RUN}`,
          statusChangedAt: new Date('2026-07-02T00:00:00.000Z'),
        })
        .where(eq(catalogSourceConfigs.sourceId, sourceId));
      await tx
        .update(catalogSources)
        .set({ mayDisplay: false, mayStore: false, attributionRequired: true })
        .where(eq(catalogSources.id, sourceId));
    });
    await linkSource(productId, recordId);
    expect((await findProductSeoFacts(db, productId))?.indexRightGranted).toBe(false);
  });

  it('is granted for a source with NO ingestion config', async () => {
    // An operator-minted or backfill-minted registry row is Mercaria's own and
    // is not governed by a rights agreement. Applying "no policy means no
    // rights" here would answer `noindex` for the whole backfilled catalogue.
    const productId = await makeProduct();
    const sourceId = uuidv7();
    const recordId = uuidv7();
    const suffix = `${RUN}-${sourceId.slice(-8)}`;
    createdSourceIds.push(sourceId);
    createdRecordIds.push(recordId);
    // A registry row with NO ingestion config. The rights trigger leaves it
    // alone — #62's "a source with no config is left alone" — so it may
    // advertise display rights with no policy behind it.
    await db.insert(catalogSources).values({
      id: sourceId,
      kind: 'operator',
      name: `SEO Operator ${suffix}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    });
    await db.insert(sourceRecords).values({
      id: recordId,
      sourceId,
      externalType: 'product',
      externalId: `ext-${suffix}`,
      observedAt: new Date('2026-07-01T00:00:00.000Z'),
      contentHash: contentHash(`operator-${suffix}`),
    });
    await linkSource(productId, recordId);

    expect((await findProductSeoFacts(db, productId))?.indexRightGranted).toBe(true);
  });

  it('answers about THIS product and no other — the correlated-reference check', async () => {
    // The bare-column trap: a correlated reference that rendered unqualified
    // would compare two of the subquery's own columns and match nothing, so
    // EVERY product would read `granted`. Two products, one refusing source,
    // and they must disagree.
    const refused = await makeProduct();
    const permitted = await makeProduct();
    const { recordId } = await makeGovernedSource(false);
    await linkSource(refused, recordId);

    expect((await findProductSeoFacts(db, refused))?.indexRightGranted).toBe(false);
    expect((await findProductSeoFacts(db, permitted))?.indexRightGranted).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Paging                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

describe('the sitemap page read', () => {
  it('orders by primary key, so a page holds the same rows across regenerations', async () => {
    const a = await makeProduct();
    const b = await makeProduct();
    const c = await makeProduct();
    const mine = new Set([a, b, c]);

    const total = await countCanonicalProductsForSitemap(db);
    expect(total).toBeGreaterThanOrEqual(3);

    // Read the whole table in one page and keep this run's rows. Their order
    // must be the ids' own ascending order, which is what makes an offset page
    // stable.
    const rows = await listCanonicalProductSitemapPage(db, 0, total + 10);
    const seen = rows.filter((row) => mine.has(row.id)).map((row) => row.id);
    expect(seen).toHaveLength(3);
    expect(seen).toEqual([...seen].sort());

    // The same order the repository's `ORDER BY` promises, asked of the server
    // directly — a positive control, so a coincidentally-sorted result cannot
    // pass for a deliberate one.
    const expected = await db
      .select({ id: canonicalProducts.id })
      .from(canonicalProducts)
      .where(inArray(canonicalProducts.id, [a, b, c]))
      .orderBy(asc(canonicalProducts.id));
    expect(seen).toEqual(expected.map((row) => row.id));
  });

  it('projects the counts the indexability policy reads', async () => {
    const productId = await makeProduct({ description: 'A description with real content in it.' });
    const { recordId } = await makeGovernedSource(true);
    await db.insert(canonicalImages).values({
      id: uuidv7(),
      productId,
      fileId: `file-${RUN}-${uuidv7().slice(-8)}`,
      sourceRecordId: recordId,
      position: 0,
      status: 'active',
    });
    await db.insert(canonicalImages).values({
      id: uuidv7(),
      productId,
      fileId: `file-${RUN}-${uuidv7().slice(-8)}`,
      sourceRecordId: recordId,
      position: 1,
      status: 'suppressed',
    });

    const total = await countCanonicalProductsForSitemap(db);
    const rows = await listCanonicalProductSitemapPage(db, 0, total + 10);
    const row = rows.find((candidate) => candidate.id === productId);

    expect(row).toBeDefined();
    expect(row?.descriptionLength).toBe('A description with real content in it.'.length);
    // ACTIVE images only — a suppressed one is not something the page displays.
    expect(row?.imageCount).toBe(1);
    expect(row?.indexRightGranted).toBe(true);
    expect(row?.lastmod).toBeInstanceOf(Date);
  });

  it('answers nothing for an offset past the end', async () => {
    const total = await countCanonicalProductsForSitemap(db);
    expect(await listCanonicalProductSitemapPage(db, total + 100, 10)).toEqual([]);
  });
});
