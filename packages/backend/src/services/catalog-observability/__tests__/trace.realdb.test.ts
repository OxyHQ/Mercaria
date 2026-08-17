/**
 * The publish → outbox → match → index trace against a REAL PostgreSQL server
 * (#367 W17).
 *
 * ## Why a real server, and not a mocked repository
 *
 * Every hop here is a JOIN over a table another domain owns, through a predicate
 * that has to hold against real constraints: the draft's three published-state
 * biconditionals, `listings_owner_exclusivity_check`, the selectable-category
 * trigger, `native_listing_links_confidence_check`,
 * `match_queue_subject_shape_check`, `offer_outboxes_claimed_revision_check`, and
 * `canonical_variants_signature_shape_check`. A mocked `select` evaluates none of
 * them and would report six green hops over statements the server never parsed —
 * and, worse, would happily accept a FIXTURE the server refuses, which is how a
 * trace gets tested against a state that cannot exist.
 *
 * ## EVERY `absent` AND `empty` BRANCH HAS A POSITIVE CONTROL BESIDE IT
 *
 * This is the whole point of the file. A trace asserted only against a complete
 * chain cannot fail — and one asserted only against an incomplete chain cannot
 * either. So each hop is driven twice: once with its row present, asserting
 * `present`; once with the row deliberately missing, asserting the exact `absent`
 * or `empty` reason. The two directions are what distinguish a working read from
 * a function that returns the same shape regardless.
 *
 * The distinction the hop states matters more than the shape: `absent` means the
 * hop did not happen (no listing to look at), `empty` means it happened and
 * legitimately found nothing (a publication with no canonical selection). A test
 * that accepted either would let the two collapse, which is the failure that makes
 * a stalled chain and a finished one look the same.
 *
 * ## Nothing is committed, so there is no teardown and no cross-file hazard
 *
 * Every fixture is created inside a transaction that is ROLLED BACK, and the trace
 * is driven on that same handle — which is why `traceCatalogPublication` takes a
 * `DatabaseOrTransaction`. The sibling `integrity.realdb.test.ts` decision, for
 * the same three reasons: no row is ever visible to a parallel file, the
 * deliberately-incomplete chains cannot outlive the assertion that wanted them,
 * and the `restrict` teardown ordering on `categories`,
 * `product_type_definitions` and a published draft's `published_listing_id` does
 * not arise because nothing has to be deleted.
 *
 * `repeatable read`, also following the sibling: the one figure in this file that
 * is not scoped to ids this file minted is the reindex hop's queue-wide count, and
 * at `read committed` a parallel file's insert would land between two readings of
 * it.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import {
  closePostgres,
  connectPostgres,
  type Database,
  type Transaction,
} from '../../../db/postgres.js';
import { deriveConvergence, traceCatalogPublication } from '../trace.service.js';

const db: Database = await connectPostgres();

/**
 * Every id this file mints.
 *
 * `zz-` first, following the sibling: a text id beginning `zz-` sorts above every
 * uuid v7 hex id and above every other fixture prefix in this repository, so any
 * bounded, ordered sample a sibling check takes includes this file's rows rather
 * than silently excluding them. `obs-trace` distinguishes it from
 * `zz-obs-integ`.
 */
const P = 'zz-obs-trace';

/** A distinct suffix per case, so two cases cannot collide on a unique index. */
function id(scope: string, name: string): string {
  return `${P}-${scope}-${name}`;
}

/**
 * A 64-hex canonical-variant signature, derived from the scope so two cases
 * cannot collide. `canonical_variants_signature_shape_check` enforces the shape.
 */
function signature(scope: string): string {
  const seed = Buffer.from(`${P}-${scope}`).toString('hex');
  return (seed + '0'.repeat(64)).slice(0, 64);
}

afterAll(async () => {
  await closePostgres();
});

/** Thrown to roll a fixture transaction back. Never escapes the helper. */
class RolledBack extends Error {}

async function rolledBack<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  let captured: T;
  try {
    await db.transaction(
      async (tx) => {
        captured = await work(tx);
        throw new RolledBack('fixture transaction rolled back deliberately');
      },
      { isolationLevel: 'repeatable read' },
    );
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  return captured;
}

/**
 * A timestamp for a raw `sql` template.
 *
 * A bare `Date` interpolated into a drizzle `sql` template FAILS at
 * serialisation in postgres.js — `ERR_INVALID_ARG_TYPE`, "Received an instance of
 * Date", from inside `Bind` — because the value is bound as a `text` parameter
 * (`~/Oxy/AGENTS.md`, in the list of four `sql`-template traps). Measured here on
 * the first run of this file, on every fixture at once. The ISO string plus an
 * explicit `::timestamptz` is what the server actually wants, and the cast is
 * written out so the parameter's type is stated rather than inferred.
 */
function ts(value: Date): SQL {
  return sql`${value.toISOString()}::timestamptz`;
}

/** The same, for a column that may legitimately be NULL. */
function tsOrNull(value: Date | null): SQL {
  return value === null ? sql`null::timestamptz` : ts(value);
}

/* -------------------------------------------------------------------------- */
/* Fixtures — raw SQL, mirroring exactly what `publishDraft` writes            */
/* -------------------------------------------------------------------------- */

/**
 * The fixtures are raw inserts rather than a call to `publishDraft`, and the
 * trade-off is worth stating.
 *
 * `publishDraft(db, …)` opens its OWN `db.transaction`, and its post-commit half
 * (`finishStoreProductCreation` → `syncListingFacets`) runs outside it — so it
 * cannot be driven inside a rolled-back transaction at all, and running it for
 * real would commit fixtures into a database shared with parallel files. What the
 * raw inserts buy in exchange is the ability to build the INCOMPLETE chains, which
 * is where every `absent` and `empty` control lives: the real writer cannot
 * produce a published listing with no offer-outbox row, and that is precisely the
 * state the trace has to be able to report.
 *
 * The columns each helper writes are the columns `publish.service.ts` writes at
 * the line cited above it, so a drift in the real writer shows up here as a
 * constraint failure rather than as a silently different fixture.
 */

async function insertStore(tx: Transaction, scope: string): Promise<string> {
  const storeId = id(scope, 'store');
  await tx.execute(sql`
    insert into stores (id, handle, name, description, brand_color)
    values (${storeId}, ${storeId}, ${'Trace probe store'}, ${'A #367 W17 fixture.'}, ${'#123456'})
  `);
  return storeId;
}

/** Selectable and published: `mercaria_category_assignment_selectable` demands it. */
async function insertCategory(tx: Transaction, scope: string): Promise<string> {
  const categoryId = id(scope, 'cat');
  await tx.execute(sql`
    insert into categories (id, key, name, slug, ancestor_ids, lifecycle, selectable)
    values (${categoryId}, ${categoryId}, ${'Trace probe'}, ${`${categoryId}-slug`},
            '{}'::text[], 'published', true)
  `);
  return categoryId;
}

/**
 * A product-type version. The key satisfies
 * `product_type_definitions_key_shape_check`, which admits `[a-z0-9_]` segments
 * only — hence underscores where every other fixture here uses hyphens.
 */
async function insertProductTypeDefinition(tx: Transaction, scope: string): Promise<string> {
  const definitionId = id(scope, 'ptd');
  const key = `zz_obs_trace_${scope.replace(/[^a-z0-9]/g, '_')}`;
  await tx.execute(sql`
    insert into product_type_definitions (id, key, name, version)
    values (${definitionId}, ${key}, ${'Trace probe type'}, 1)
  `);
  return definitionId;
}

/** A store-owned listing. `owner_type = 'store'` ⇒ `oxy_user_id` must be NULL. */
async function insertListing(
  tx: Transaction,
  scope: string,
  storeId: string,
  categoryId: string,
  options: { readonly status?: string; readonly variantCount?: number; readonly suffix?: string } = {},
): Promise<string> {
  const listingId = id(scope, options.suffix ?? 'listing');
  const status = options.status ?? 'active';
  await tx.execute(sql`
    insert into listings (
      id, owner_type, store_id, title, description, condition, condition_assertion,
      status, category_id, variant_count, published_at
    )
    values (
      ${listingId}, 'store', ${storeId}, ${'Trace probe listing'}, ${'A #367 W17 fixture.'},
      'new', 'seller_declared', ${status}, ${categoryId}, ${options.variantCount ?? 0},
      ${tsOrNull(status === 'active' ? new Date() : null)}
    )
  `);
  return listingId;
}

async function insertVariant(
  tx: Transaction,
  scope: string,
  listingId: string,
  position: number,
): Promise<string> {
  const variantId = id(scope, `variant-${position}`);
  await tx.execute(sql`
    insert into product_variants (id, listing_id, position)
    values (${variantId}, ${listingId}, ${position})
  `);
  return variantId;
}

async function insertCanonicalVariant(tx: Transaction, scope: string): Promise<string> {
  const productId = id(scope, 'cprod');
  const variantId = id(scope, 'cvar');
  await tx.execute(sql`
    insert into canonical_products (id, slug, name, normalized_name)
    values (${productId}, ${`${productId}-slug`}, ${'Trace probe canonical'}, ${'trace probe canonical'})
  `);
  await tx.execute(sql`
    insert into canonical_variants (id, product_id, signature)
    values (${variantId}, ${productId}, ${signature(scope)})
  `);
  return variantId;
}

/**
 * An authoring draft, `open` or `published`.
 *
 * The three biconditionals on this table
 * (`catalog_authoring_drafts_published_listing_check`, `…_published_at_check`,
 * `…_expiry_check`) make the two shapes genuinely different rows rather than one
 * row with a different status, which is why this takes the listing id rather than
 * a boolean.
 */
async function insertDraft(
  tx: Transaction,
  scope: string,
  parts: {
    readonly storeId: string;
    readonly categoryId: string;
    readonly definitionId: string;
    readonly publishedListingId: string | null;
    readonly suffix?: string;
  },
): Promise<string> {
  const draftId = id(scope, parts.suffix ?? 'draft');
  const published = parts.publishedListingId !== null;
  await tx.execute(sql`
    insert into catalog_authoring_drafts (
      id, store_id, created_by_oxy_user_id, status, category_id,
      product_type_definition_id, flow, locale, market, schema_hash, version,
      published_listing_id, published_at, expires_at
    )
    values (
      ${draftId}, ${parts.storeId}, ${'oxy-user-not-returned-by-the-trace'},
      ${published ? 'published' : 'open'}, ${parts.categoryId}, ${parts.definitionId},
      'merchant', 'es', 'ES', ${signature(scope)}, 3,
      ${parts.publishedListingId}, ${tsOrNull(published ? new Date() : null)},
      ${tsOrNull(published ? null : new Date(Date.now() + 86_400_000))}
    )
  `);
  return draftId;
}

/** What `publishDraft` writes for an author's declared canonical selection. */
async function insertNativeLink(
  tx: Transaction,
  scope: string,
  parts: {
    readonly productVariantId: string;
    readonly listingId: string;
    readonly canonicalVariantId: string;
  },
): Promise<string> {
  const linkId = id(scope, 'link');
  await tx.execute(sql`
    insert into native_listing_links (
      id, product_variant_id, listing_id, canonical_variant_id, method, match_rule,
      confidence, status, decided_by_oxy_user_id
    )
    values (
      ${linkId}, ${parts.productVariantId}, ${parts.listingId}, ${parts.canonicalVariantId},
      'merchant_declared', ${'authoring.merchant_declared'}, null, 'active',
      ${'oxy-user-not-returned-by-the-trace'}
    )
  `);
  return linkId;
}

/** What `enqueueOfferConvergence` writes, plus the states a worker leaves. */
async function insertOfferOutbox(
  tx: Transaction,
  scope: string,
  listingId: string,
  options: {
    readonly status?: string;
    readonly requestedRevision?: number;
    readonly claimedRevision?: number | null;
    readonly lastError?: string | null;
    readonly processedAt?: Date | null;
  } = {},
): Promise<string> {
  const outboxId = id(scope, 'outbox');
  await tx.execute(sql`
    insert into offer_outboxes (
      id, listing_id, requested_revision, claimed_revision, status, attempts,
      available_at, last_error, processed_at
    )
    values (
      ${outboxId}, ${listingId}, ${options.requestedRevision ?? 1},
      ${options.claimedRevision ?? null}, ${options.status ?? 'pending'}, 0,
      ${ts(new Date())}, ${options.lastError ?? null}, ${tsOrNull(options.processedAt ?? null)}
    )
  `);
  return outboxId;
}

/** What `requestNativeVariantMatch` writes for one variant. */
async function insertMatchQueueRow(
  tx: Transaction,
  scope: string,
  productVariantId: string,
  suffix: string,
): Promise<string> {
  const queueId = id(scope, `queue-${suffix}`);
  await tx.execute(sql`
    insert into match_queue (
      id, subject_kind, subject_key, source_record_id, product_variant_id, trigger,
      requested_revision, claimed_revision, status, attempts, available_at
    )
    values (
      ${queueId}, 'native_variant', ${`native_variant:${productVariantId}`}, null,
      ${productVariantId}, 'catalog_write', 1, null, 'pending', 0, ${ts(new Date())}
    )
  `);
  return queueId;
}

/** A store, a category and a product-type version — the base every case needs. */
async function insertBase(
  tx: Transaction,
  scope: string,
): Promise<{ storeId: string; categoryId: string; definitionId: string }> {
  const storeId = await insertStore(tx, scope);
  const categoryId = await insertCategory(tx, scope);
  const definitionId = await insertProductTypeDefinition(tx, scope);
  return { storeId, categoryId, definitionId };
}

/* -------------------------------------------------------------------------- */
/* The handle is closed, and an unknown one is `undefined`                     */
/* -------------------------------------------------------------------------- */

describe('the trace handle', () => {
  it('answers undefined for a draft id and a listing id that name nothing', async () => {
    await rolledBack(async (tx) => {
      expect(
        await traceCatalogPublication({ by: 'draft_id', draftId: id('missing', 'draft') }, tx),
      ).toBeUndefined();
      expect(
        await traceCatalogPublication({ by: 'listing_id', listingId: id('missing', 'listing') }, tx),
      ).toBeUndefined();
    });
  });

  it('echoes the handle it was given, as `openedFrom`, and nothing else', async () => {
    await rolledBack(async (tx) => {
      const scope = 'echo';
      const base = await insertBase(tx, scope);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: null });
      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      expect(trace).toBeDefined();
      expect(trace.openedFrom).toEqual({ by: 'draft_id', draftId });
      expect(trace.takenAt instanceof Date).toBe(true);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The negative direction: a draft that never published                        */
/* -------------------------------------------------------------------------- */

describe('an OPEN draft — the control for every downstream hop', () => {
  it('reports the draft present and every later hop ABSENT with its reason', async () => {
    await rolledBack(async (tx) => {
      const scope = 'open';
      const base = await insertBase(tx, scope);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: null });

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      expect(trace).toBeDefined();

      expect(trace.draft.state).toBe('present');
      if (trace.draft.state !== 'present') throw new Error('unreachable');
      expect(trace.draft.draftId).toBe(draftId);
      expect(trace.draft.storeId).toBe(base.storeId);
      expect(trace.draft.status).toBe('open');
      expect(trace.draft.version).toBe(3);
      expect(trace.draft.schemaHash).toBe(signature(scope));
      expect(trace.draft.productTypeDefinitionId).toBe(base.definitionId);
      expect(trace.draft.categoryId).toBe(base.categoryId);
      expect(trace.draft.locale).toBe('es');
      expect(trace.draft.market).toBe('ES');
      expect(trace.draft.publishedListingId).toBeNull();
      expect(trace.draft.publishedAt).toBeNull();
      expect(trace.draft.hasSchemaSnapshot).toBe('no');

      // "Nothing was published" is one reason, and the three hops behind it each
      // say they had no listing to read — not that they found nothing.
      expect(trace.listing).toEqual({ state: 'absent', reason: 'draft_not_published' });
      expect(trace.canonicalLinks).toEqual({ state: 'absent', reason: 'no_listing_to_read' });
      expect(trace.offerConvergence).toEqual({ state: 'absent', reason: 'no_listing_to_read' });
      expect(trace.variantMatching).toEqual({ state: 'absent', reason: 'no_listing_to_read' });
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The positive direction: a complete chain                                    */
/* -------------------------------------------------------------------------- */

describe('a PUBLISHED draft with a complete chain', () => {
  it('reports every hop present, from either handle, with identical hops', async () => {
    await rolledBack(async (tx) => {
      const scope = 'full';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId, {
        variantCount: 1,
      });
      const variantId = await insertVariant(tx, scope, listingId, 0);
      const canonicalVariantId = await insertCanonicalVariant(tx, scope);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      const linkId = await insertNativeLink(tx, scope, {
        productVariantId: variantId,
        listingId,
        canonicalVariantId,
      });
      const outboxId = await insertOfferOutbox(tx, scope, listingId);
      const queueId = await insertMatchQueueRow(tx, scope, variantId, 'a');

      const byDraft = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      const byListing = await traceCatalogPublication({ by: 'listing_id', listingId }, tx);
      expect(byDraft).toBeDefined();
      expect(byListing).toBeDefined();

      for (const [label, trace] of [
        ['by draft', byDraft],
        ['by listing', byListing],
      ] as const) {
        expect(trace.draft.state, `${label}: draft`).toBe('present');
        if (trace.draft.state !== 'present') throw new Error('unreachable');
        expect(trace.draft.draftId).toBe(draftId);
        expect(trace.draft.status).toBe('published');
        expect(trace.draft.publishedListingId).toBe(listingId);
        expect(trace.draft.publishedAt instanceof Date).toBe(true);

        expect(trace.listing.state, `${label}: listing`).toBe('present');
        if (trace.listing.state !== 'present') throw new Error('unreachable');
        expect(trace.listing.listingId).toBe(listingId);
        expect(trace.listing.storeId).toBe(base.storeId);
        expect(trace.listing.ownerType).toBe('store');
        expect(trace.listing.status).toBe('active');
        expect(trace.listing.categoryId).toBe(base.categoryId);

        expect(trace.canonicalLinks.state, `${label}: links`).toBe('present');
        if (trace.canonicalLinks.state !== 'present') throw new Error('unreachable');
        expect(trace.canonicalLinks.links).toHaveLength(1);
        expect(trace.canonicalLinks.links[0].linkId).toBe(linkId);
        expect(trace.canonicalLinks.links[0].productVariantId).toBe(variantId);
        expect(trace.canonicalLinks.links[0].canonicalVariantId).toBe(canonicalVariantId);
        // The method `publishDraft` writes (ADR 0007 D10), with NULL confidence:
        // `native_listing_links_confidence_check` restricts a number to `matcher`.
        expect(trace.canonicalLinks.links[0].method).toBe('merchant_declared');
        expect(trace.canonicalLinks.links[0].confidence).toBeNull();
        expect(trace.canonicalLinks.links[0].status).toBe('active');

        expect(trace.offerConvergence.state, `${label}: offers`).toBe('present');
        if (trace.offerConvergence.state !== 'present') throw new Error('unreachable');
        expect(trace.offerConvergence.outboxId).toBe(outboxId);
        expect(trace.offerConvergence.status).toBe('pending');
        expect(trace.offerConvergence.requestedRevision).toBe(1);
        expect(trace.offerConvergence.claimedRevision).toBeNull();
        expect(trace.offerConvergence.convergence).toBe('never_claimed');
        expect(trace.offerConvergence.hasLastError).toBe('no');

        expect(trace.variantMatching.state, `${label}: matching`).toBe('present');
        if (trace.variantMatching.state !== 'present') throw new Error('unreachable');
        expect(trace.variantMatching.rows).toHaveLength(1);
        expect(trace.variantMatching.rows[0].queueId).toBe(queueId);
        expect(trace.variantMatching.rows[0].productVariantId).toBe(variantId);
        expect(trace.variantMatching.rows[0].subjectKind).toBe('native_variant');
        expect(trace.variantMatching.rows[0].trigger).toBe('catalog_write');
        expect(trace.variantMatching.variantsWithoutQueueRow).toBe(0);
        expect(trace.variantMatching.variantCount).toBe(1);
      }

      // Two handles, one subject: the hops must not depend on which was used.
      expect(byListing.draft).toEqual(byDraft.draft);
      expect(byListing.listing).toEqual(byDraft.listing);
      expect(byListing.canonicalLinks).toEqual(byDraft.canonicalLinks);
      expect(byListing.offerConvergence).toEqual(byDraft.offerConvergence);
      expect(byListing.variantMatching).toEqual(byDraft.variantMatching);
    });
  });

  it('returns NO buyer or seller identity and NO display label', async () => {
    await rolledBack(async (tx) => {
      const scope = 'privacy';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId, {
        variantCount: 1,
      });
      const variantId = await insertVariant(tx, scope, listingId, 0);
      const canonicalVariantId = await insertCanonicalVariant(tx, scope);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      await insertNativeLink(tx, scope, {
        productVariantId: variantId,
        listingId,
        canonicalVariantId,
      });
      await insertOfferOutbox(tx, scope, listingId);

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      const serialized = JSON.stringify(trace);

      // A RUNTIME walk of a real emitted trace, not only a type-level claim —
      // the #92 two-gate rule. The fixtures deliberately write a recognisable
      // sentinel into `created_by_oxy_user_id` and `decided_by_oxy_user_id`, and
      // the listing's own title and description, so the absence is measured
      // against values that genuinely exist on the rows the trace read.
      expect(serialized).not.toContain('oxy-user-not-returned-by-the-trace');
      expect(serialized).not.toContain('Trace probe listing');
      expect(serialized).not.toContain('A #367 W17 fixture.');
      expect(serialized).not.toContain('Trace probe store');
      for (const forbidden of ['oxyUserId', 'createdBy', 'decidedBy', 'revokedBy', 'title', 'description', 'handle']) {
        expect(serialized, `the trace carries ${forbidden}`).not.toContain(forbidden);
      }

      // And the tenant IS present, deliberately: see the service's header.
      expect(serialized).toContain(base.storeId);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* `empty` is not `absent`: the canonical-attachment hop                       */
/* -------------------------------------------------------------------------- */

describe('the canonical attachment hop', () => {
  it('is EMPTY, not absent, for a published listing that declared no selection', async () => {
    await rolledBack(async (tx) => {
      const scope = 'nolink';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId, {
        variantCount: 1,
      });
      const variantId = await insertVariant(tx, scope, listingId, 0);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      await insertOfferOutbox(tx, scope, listingId);
      await insertMatchQueueRow(tx, scope, variantId, 'a');

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);

      // The successful publication of an unmatched listing. The hop happened and
      // found nothing, which is a different fact from having had nothing to read.
      expect(trace.canonicalLinks).toEqual({
        state: 'empty',
        reason: 'no_canonical_attachment',
      });
      // The control: the hops around it are still present, so `empty` here is a
      // statement about the attachment and not about the chain having stopped.
      expect(trace.listing.state).toBe('present');
      expect(trace.offerConvergence.state).toBe('present');
      expect(trace.variantMatching.state).toBe('present');
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The offer convergence hop, and the revision pair                            */
/* -------------------------------------------------------------------------- */

describe('the offer convergence hop', () => {
  it('reports a MISSING outbox row as a finding, beside a listing that is present', async () => {
    await rolledBack(async (tx) => {
      const scope = 'nooutbox';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId, {
        variantCount: 1,
      });
      const variantId = await insertVariant(tx, scope, listingId, 0);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      await insertMatchQueueRow(tx, scope, variantId, 'a');

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      expect(trace.offerConvergence).toEqual({ state: 'absent', reason: 'no_outbox_row' });
      // Distinguished from `no_listing_to_read`, which is the same shape with a
      // different meaning — the listing is right there.
      expect(trace.listing.state).toBe('present');
    });
  });

  it.each([
    ['a queued row nobody claimed', { status: 'pending', requestedRevision: 1, claimedRevision: null }, 'never_claimed'],
    ['a worker holding a lease', { status: 'processing', requestedRevision: 1, claimedRevision: 1 }, 'in_flight'],
    ['a completed convergence', { status: 'done', requestedRevision: 2, claimedRevision: 2 }, 'converged'],
    ['a request that arrived mid-run', { status: 'pending', requestedRevision: 3, claimedRevision: 1 }, 'superseded'],
    ['a claim released without completing', { status: 'pending', requestedRevision: 1, claimedRevision: 1 }, 'retrying'],
    ['a row given up on', { status: 'dead_letter', requestedRevision: 1, claimedRevision: 1 }, 'dead_letter'],
  ])('reads %s as %s — against a REAL row', async (_label, options, expected) => {
    await rolledBack(async (tx) => {
      const scope = `conv-${expected}`;
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      await insertOfferOutbox(tx, scope, listingId, {
        ...options,
        processedAt: options.status === 'done' ? new Date() : null,
      });

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      expect(trace.offerConvergence.state).toBe('present');
      if (trace.offerConvergence.state !== 'present') throw new Error('unreachable');
      expect(trace.offerConvergence.convergence).toBe(expected);
      expect(trace.offerConvergence.requestedRevision).toBe(options.requestedRevision);
      expect(trace.offerConvergence.claimedRevision).toBe(options.claimedRevision);
    });
  });

  it('reports that an error is recorded without reproducing it', async () => {
    await rolledBack(async (tx) => {
      const scope = 'lasterror';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      await insertOfferOutbox(tx, scope, listingId, {
        status: 'dead_letter',
        claimedRevision: 1,
        lastError: 'a provider said something about buyer@example.com',
      });

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      expect(trace.offerConvergence.state).toBe('present');
      if (trace.offerConvergence.state !== 'present') throw new Error('unreachable');
      expect(trace.offerConvergence.hasLastError).toBe('yes');
      // The control on the flag: it is `no` when there is no error (asserted in
      // the full-chain case), and the text itself never travels.
      expect(JSON.stringify(trace)).not.toContain('buyer@example.com');
    });
  });

  it('deriveConvergence has no branch that returns undefined', () => {
    // The derivation is the one piece of logic in the service. Driven directly as
    // well as through real rows, because a value it cannot produce is a value a
    // reader would render as blank.
    for (const status of ['pending', 'processing', 'done', 'dead_letter']) {
      for (const claimed of [null, 0, 1, 2]) {
        expect(deriveConvergence(status, 2, claimed)).toBeTypeOf('string');
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The variant matching hop                                                    */
/* -------------------------------------------------------------------------- */

describe('the variant matching hop', () => {
  it('is EMPTY with `listing_has_no_variants` when the listing has none', async () => {
    await rolledBack(async (tx) => {
      const scope = 'novariant';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      await insertOfferOutbox(tx, scope, listingId);

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      expect(trace.variantMatching).toEqual({
        state: 'empty',
        reason: 'listing_has_no_variants',
        variantCount: 0,
      });
    });
  });

  it('is EMPTY with `no_queue_row_for_any_variant` when it has variants and no rows', async () => {
    await rolledBack(async (tx) => {
      const scope = 'noqueue';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId, {
        variantCount: 2,
      });
      await insertVariant(tx, scope, listingId, 0);
      await insertVariant(tx, scope, listingId, 1);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      await insertOfferOutbox(tx, scope, listingId);

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      // Two variants and no request: `syncListingFacets` enqueues one per variant,
      // so this is a real finding rather than a quiet nothing — and it is a
      // DIFFERENT reason from having no variants at all.
      expect(trace.variantMatching).toEqual({
        state: 'empty',
        reason: 'no_queue_row_for_any_variant',
        variantCount: 2,
      });
    });
  });

  it('counts the variants a PARTIAL enqueue missed', async () => {
    await rolledBack(async (tx) => {
      const scope = 'partial';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId, {
        variantCount: 3,
      });
      const first = await insertVariant(tx, scope, listingId, 0);
      await insertVariant(tx, scope, listingId, 1);
      await insertVariant(tx, scope, listingId, 2);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      await insertOfferOutbox(tx, scope, listingId);
      await insertMatchQueueRow(tx, scope, first, 'a');

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      expect(trace.variantMatching.state).toBe('present');
      if (trace.variantMatching.state !== 'present') throw new Error('unreachable');
      // The number that keeps `present` honest: one row found, two variants owed
      // one. A hop reporting only what it found would read as a working enqueue.
      expect(trace.variantMatching.rows).toHaveLength(1);
      expect(trace.variantMatching.variantsWithoutQueueRow).toBe(2);
      expect(trace.variantMatching.variantCount).toBe(3);
    });
  });

  it('counts the listing’s OWN variants rather than trusting `variant_count`', async () => {
    await rolledBack(async (tx) => {
      const scope = 'drifted';
      const base = await insertBase(tx, scope);
      // The projection says 9; there are 2. A hop that read the column would
      // report seven variants missing a queue row and name none of them.
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId, {
        variantCount: 9,
      });
      const first = await insertVariant(tx, scope, listingId, 0);
      const second = await insertVariant(tx, scope, listingId, 1);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      await insertOfferOutbox(tx, scope, listingId);
      await insertMatchQueueRow(tx, scope, first, 'a');
      await insertMatchQueueRow(tx, scope, second, 'b');

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      expect(trace.variantMatching.state).toBe('present');
      if (trace.variantMatching.state !== 'present') throw new Error('unreachable');
      expect(trace.variantMatching.variantCount).toBe(2);
      expect(trace.variantMatching.variantsWithoutQueueRow).toBe(0);
      // The drifted projection is still reported on the LISTING hop, where it is
      // the column's own value and can be compared against the number above.
      expect(trace.listing.state).toBe('present');
      if (trace.listing.state !== 'present') throw new Error('unreachable');
      expect(trace.listing.variantCount).toBe(9);
    });
  });

  it('does not pick up a queue row for ANOTHER listing’s variant', async () => {
    await rolledBack(async (tx) => {
      const scope = 'scoped';
      const base = await insertBase(tx, scope);
      const mine = await insertListing(tx, scope, base.storeId, base.categoryId, {
        suffix: 'listing-mine',
        variantCount: 1,
      });
      const theirs = await insertListing(tx, scope, base.storeId, base.categoryId, {
        suffix: 'listing-theirs',
        variantCount: 1,
      });
      await insertVariant(tx, scope, mine, 0);
      const theirVariant = await insertVariant(tx, scope, theirs, 1);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: mine });
      await insertOfferOutbox(tx, scope, mine);
      await insertMatchQueueRow(tx, scope, theirVariant, 'theirs');

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);
      // A row exists in `match_queue`, and it is not this listing's. Scoping the
      // read by the listing's own variant ids is what makes that true.
      expect(trace.variantMatching).toEqual({
        state: 'empty',
        reason: 'no_queue_row_for_any_variant',
        variantCount: 1,
      });
    });
  });
});

/* -------------------------------------------------------------------------- */
/* A listing with no draft behind it                                           */
/* -------------------------------------------------------------------------- */

describe('a listing with no authoring draft', () => {
  it('reports the draft absent with `listing_has_no_draft`, not as an error', async () => {
    await rolledBack(async (tx) => {
      const scope = 'nodraft';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId, {
        variantCount: 1,
      });
      await insertVariant(tx, scope, listingId, 0);
      await insertOfferOutbox(tx, scope, listingId);

      const trace = await traceCatalogPublication({ by: 'listing_id', listingId }, tx);
      expect(trace).toBeDefined();
      // The ordinary state for a connector-imported or P2P listing. The trace is
      // still useful: every hop after the draft resolves.
      expect(trace.draft).toEqual({ state: 'absent', reason: 'listing_has_no_draft' });
      expect(trace.listing.state).toBe('present');
      expect(trace.offerConvergence.state).toBe('present');
    });
  });

  it('distinguishes `draft_not_found` from `listing_has_no_draft` by the HANDLE', async () => {
    await rolledBack(async (tx) => {
      // Same shape, opposite meaning: one is a mistyped id, the other is a
      // listing that legitimately never had a draft.
      const trace = await traceCatalogPublication(
        { by: 'draft_id', draftId: id('nodraft2', 'draft') },
        tx,
      );
      expect(trace).toBeUndefined();
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The reindex hop, which does not work                                        */
/* -------------------------------------------------------------------------- */

describe('the attribute reindex hop', () => {
  it('is UNREACHABLE, names why, and cites where the claim was measured', async () => {
    await rolledBack(async (tx) => {
      const scope = 'reindex';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId, {
        variantCount: 1,
      });
      const variantId = await insertVariant(tx, scope, listingId, 0);
      const canonicalVariantId = await insertCanonicalVariant(tx, scope);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });
      await insertNativeLink(tx, scope, {
        productVariantId: variantId,
        listingId,
        canonicalVariantId,
      });
      await insertOfferOutbox(tx, scope, listingId);
      await insertMatchQueueRow(tx, scope, variantId, 'a');

      const trace = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);

      // A COMPLETE chain in every other hop, and this one is still unreachable.
      // That is the finding: nothing about a healthy publication makes indexing
      // happen, because no publication path enqueues and no consumer drains.
      expect(trace.canonicalLinks.state).toBe('present');
      expect(trace.offerConvergence.state).toBe('present');
      expect(trace.variantMatching.state).toBe('present');

      expect(trace.attributeReindex.state).toBe('unreachable');
      expect(trace.attributeReindex.reason).toBe('no_consumer_and_no_producer_on_this_path');
      expect(trace.attributeReindex.consumer).toBe('absent');
      expect(trace.attributeReindex.producerOnPublicationPath).toBe('absent');
      expect(trace.attributeReindex.evidence.length).toBeGreaterThan(3);
      expect(trace.attributeReindex.queueWideUndrainedRequests).toBeTypeOf('number');
      expect(trace.attributeReindex.queueWideUndrainedRequests).toBeGreaterThanOrEqual(0);

      process.stdout.write(
        `[census] attribute_reindex_requests undrained (queue-wide, shared database): `
          + `${trace.attributeReindex.queueWideUndrainedRequests}\n`,
      );
    });
  });

  it('counts an undrained request when one is inserted — the positive control', async () => {
    await rolledBack(async (tx) => {
      const scope = 'reindexcount';
      const base = await insertBase(tx, scope);
      const listingId = await insertListing(tx, scope, base.storeId, base.categoryId);
      const draftId = await insertDraft(tx, scope, { ...base, publishedListingId: listingId });

      const before = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);

      // `entity_kind` is `product` | `variant` — CANONICAL entities — which is
      // half of why no listing can ever appear in this queue. The row below names
      // a canonical product id, because there is no shape that could name a
      // native listing.
      await tx.execute(sql`
        insert into attribute_reindex_requests (
          id, entity_kind, entity_id, attribute_key, definition_version, reason,
          enqueued_at, attempts
        )
        values (
          ${id(scope, 'reindex-row')}, 'product', ${id(scope, 'cprod-absent')},
          ${'zz_obs_trace_attr'}, 1, 'definition_published', ${ts(new Date())}, 0
        )
      `);

      const after = await traceCatalogPublication({ by: 'draft_id', draftId }, tx);

      // A DELTA, not an absolute: this figure is queue-wide and the database is
      // shared. `repeatable read` is what makes the delta exactly this file's own
      // insert — at `read committed` a parallel file's row would land between the
      // two readings.
      expect(
        after.attributeReindex.queueWideUndrainedRequests
          - before.attributeReindex.queueWideUndrainedRequests,
        'the undrained count did not move for a row that was inserted',
      ).toBe(1);

      // And it is STILL unreachable, which is the point: a row exists, is
      // unprocessed, and nothing will ever read it.
      expect(after.attributeReindex.state).toBe('unreachable');
      expect(after.attributeReindex.consumer).toBe('absent');
    });
  });
});
