/**
 * The publish → outbox → match → index trace (#367 W17).
 *
 * "What happened to this publication", answered from the durable rows the chain
 * left behind: the authoring draft, the listing it produced, the canonical
 * attachments the author declared, the offer convergence job, the match-queue
 * rows for its variants, and the reindex hop — which does not work, and says so.
 *
 * ## Why this is a ROW TRACE assembled on read, and not a distributed trace
 *
 * W17 asks for "distributed traces". This repository has no tracing backend: no
 * OpenTelemetry, no `traceparent`, no span exporter, zero hits repo-wide — and
 * the epic's own posture on measurement is explicit that observability here is
 * "a JSON endpoint plus structured logs", with scraping and alerting belonging to
 * `oxy-infra` (`docs/payments.md` §Reconciliation, and the `ledgerImbalance`
 * decision). A span tree would need a collector nobody has provisioned, and the
 * spans would be gone by the time anybody asked the question, because the hops
 * are MINUTES apart: publish commits, the offer outbox converges on a later
 * dispatcher tick, the match queue on a later one still.
 *
 * So the trace is `tracePayment`'s shape (`services/payments/payment.service.ts`)
 * and `changeTraceHandler`'s (`routes/internal-catalog-governance.ts`): every hop
 * is a durable row, and the trace is a read over them. It therefore survives a
 * restart, a deploy and a week, which a span does not — and the correlation id in
 * `correlation.ts` is what joins the LOG LINES to it, which is the half a row
 * trace genuinely cannot supply.
 *
 * ## A closed handle set, and it is the whole authorization argument
 *
 * A trace opens from a DRAFT ID or a LISTING ID and nothing else — `tracePayment`
 * acceptance 10's rule, and it is a property of this signature rather than of a
 * validation schema: there is no way to ask by email, by seller name, by store
 * handle or by free text, because no such parameter exists. An HTTP surface
 * layered on top cannot widen it.
 *
 * ## What it returns about people: nothing
 *
 * No Oxy user id in any hop — not `catalog_authoring_drafts.created_by_oxy_user_id`,
 * not `native_listing_links.decided_by_oxy_user_id`, not `revoked_by_oxy_user_id`
 * — and no display label: no listing title, description or handle. Every select
 * below NAMES its columns (the `provider_accounts` #46 precedent) rather than
 * using `db.select().from(...)`, which enumerates every column and is how a
 * protected one reaches a response.
 *
 * `storeId` IS returned. A store is a TENANT, not a person: it is the id an
 * operator needs to know whose catalogue this is, every merchant surface in the
 * repository already prints it, and the alternative is a trace that cannot answer
 * the first question anybody asks of it.
 *
 * ## Every hop distinguishes "did not happen" from "happened and found nothing"
 *
 * Three-way, not two: `present` | `empty` | `absent`, with a reason on the last
 * two. A draft that was never published has NO listing (`absent`) and a published
 * listing whose author declared no canonical selection has an EMPTY set of links
 * (`empty`) — and those two must not be one value, because the first is a
 * publication that has not happened yet and the second is a completed one whose
 * next hop will legitimately never fire. A zeroed `present` branch would report
 * both as a healthy nothing, which is the `readRouteObservation` decision
 * (absent, never a zeroed bucket) applied to a trace.
 *
 * Discriminants are STRINGS throughout. This package compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on a boolean-literal discriminant, so `if (!hop.present)` would leave the
 * caller holding the whole union (`~/Oxy/Mercaria/AGENTS.md`).
 */

import { count, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { catalogAuthoringDrafts } from '../../db/schema/catalogAuthoring.js';
import { listings, productVariants } from '../../db/schema/catalog.js';
import { nativeListingLinks, offerOutboxes } from '../../db/schema/offers.js';
import { matchQueue } from '../../db/schema/matching.js';
import { attributeReindexRequests } from '../../db/schema/attributeRegistry.js';
import { catalogLogInfo } from './catalog-log.js';

/* -------------------------------------------------------------------------- */
/* The handle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How a trace is opened. Exactly two ways, and no third may be added without
 * re-reading the header.
 */
export type CatalogPublicationTraceHandle =
  | { readonly by: 'draft_id'; readonly draftId: string }
  | { readonly by: 'listing_id'; readonly listingId: string };

/* -------------------------------------------------------------------------- */
/* Hop 1 — the authoring draft                                                 */
/* -------------------------------------------------------------------------- */

/** Why there is no draft to report. */
export type CatalogTraceDraftAbsence =
  /** The handle named a draft id that does not exist. */
  | 'draft_not_found'
  /**
   * The listing exists and no draft points at it. NOT an error: a listing
   * created by the connector import path, the P2P path or a pre-#367 write has
   * no authoring draft behind it, and reporting that as a broken chain would make
   * most of the catalogue look broken.
   */
  | 'listing_has_no_draft';

export type CatalogTraceDraftHop =
  | {
      readonly state: 'present';
      readonly draftId: string;
      readonly storeId: string;
      readonly status: string;
      /** The compare-and-swap token, not a schema version. */
      readonly version: number;
      /** The deterministic hash of the schema the answers were given under. */
      readonly schemaHash: string;
      readonly productTypeDefinitionId: string;
      readonly categoryId: string;
      readonly locale: string;
      readonly market: string;
      readonly publishedListingId: string | null;
      readonly publishedAt: Date | null;
      /**
       * Whether ADR 0007 D14's audit snapshot was captured — a boolean, never the
       * snapshot, which is up to 256 KB of composed schema and is not what a trace
       * is for.
       */
      readonly hasSchemaSnapshot: CatalogTraceFlag;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    }
  | { readonly state: 'absent'; readonly reason: CatalogTraceDraftAbsence };

/* -------------------------------------------------------------------------- */
/* Hop 2 — the listing the publish produced                                    */
/* -------------------------------------------------------------------------- */

export type CatalogTraceListingAbsence =
  /** The draft is `open` or `discarded`; nothing was published. */
  | 'draft_not_published'
  /** The handle named a listing id that does not exist. */
  | 'listing_not_found'
  /**
   * The draft says it published a listing and the row is gone. A published draft
   * pins its listing `on delete restrict`, so this is unreachable through
   * ordinary code — reported rather than merged into `listing_not_found` because
   * the two would need opposite responses.
   */
  | 'published_listing_missing';

export type CatalogTraceListingHop =
  | {
      readonly state: 'present';
      readonly listingId: string;
      readonly storeId: string | null;
      readonly ownerType: string;
      readonly status: string;
      readonly variantCount: number;
      readonly categoryId: string | null;
      /** FIRST activation, never the row's birthday (#261). */
      readonly publishedAt: Date | null;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    }
  | { readonly state: 'absent'; readonly reason: CatalogTraceListingAbsence };

/* -------------------------------------------------------------------------- */
/* Hop 3 — the canonical attachments the author declared                       */
/* -------------------------------------------------------------------------- */

/** One `native_listing_links` row, without the two operator id columns. */
export interface CatalogTraceCanonicalLink {
  readonly linkId: string;
  readonly productVariantId: string;
  readonly canonicalVariantId: string;
  /** `merchant_declared` for a publish; `matcher` once #58 has attached one. */
  readonly method: string;
  readonly matchRule: string;
  readonly status: string;
  readonly confidence: number | null;
  readonly createdAt: Date;
}

export type CatalogTraceCanonicalLinkHop =
  | { readonly state: 'present'; readonly links: readonly CatalogTraceCanonicalLink[] }
  | {
      readonly state: 'empty';
      /**
       * The listing exists and carries no attachment. The ordinary state for a
       * draft that selected no canonical product: `publishDraft` writes a link
       * only for a variant whose `selected_canonical_variant_id` is set, so an
       * unmatched listing is a SUCCESSFUL publication with nothing here.
       */
      readonly reason: 'no_canonical_attachment';
    }
  | { readonly state: 'absent'; readonly reason: 'no_listing_to_read' };

/* -------------------------------------------------------------------------- */
/* Hop 4 — the offer convergence job                                           */
/* -------------------------------------------------------------------------- */

/**
 * What the revision pair and the status say together.
 *
 * Derived, never stored — the row holds the two revisions and the status, and
 * this is the reading of them. `superseded` is the one worth knowing: a request
 * that arrived DURING a run leaves `claimed_revision < requested_revision`, which
 * is the mechanism `offerOutboxRepository.ts` documents at length, and a trace
 * that collapsed it into `pending` would hide exactly the race the pair exists
 * to survive.
 */
export type CatalogTraceConvergence =
  /** Queued and never claimed by any worker. */
  | 'never_claimed'
  /** A worker holds a lease right now. */
  | 'in_flight'
  /** Claimed, completed, and no newer request has arrived. */
  | 'converged'
  /** A newer request arrived after the last claim; this row owes another run. */
  | 'superseded'
  /** Claimed and released without completing — it will be retried. */
  | 'retrying'
  /** Given up on, visibly. */
  | 'dead_letter';

export type CatalogTraceOfferConvergenceHop
  = | {
      readonly state: 'present';
      readonly outboxId: string;
      readonly status: string;
      readonly convergence: CatalogTraceConvergence;
      readonly requestedRevision: number;
      readonly claimedRevision: number | null;
      readonly attempts: number;
      readonly availableAt: Date;
      readonly processedAt: Date | null;
      readonly leaseUntil: Date | null;
      /** Whether a dispatch error is recorded, never the error text itself. */
      readonly hasLastError: CatalogTraceFlag;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    }
  | {
      readonly state: 'absent';
      /**
       * `no_outbox_row` is a real finding rather than a shrug: `publishDraft`
       * calls `enqueueOfferConvergence` inside its own transaction, and the row
       * CASCADEs only with the listing, so a present listing with no row means
       * the enqueue did not happen — a listing whose offers may claim it is on
       * sale when it is not.
       */
      readonly reason: 'no_outbox_row' | 'no_listing_to_read';
    };

/* -------------------------------------------------------------------------- */
/* Hop 5 — the match queue rows for this listing's variants                    */
/* -------------------------------------------------------------------------- */

export interface CatalogTraceMatchQueueRow {
  readonly queueId: string;
  readonly productVariantId: string | null;
  readonly subjectKind: string;
  readonly trigger: string;
  readonly status: string;
  readonly requestedRevision: number;
  readonly claimedRevision: number | null;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly processedAt: Date | null;
  readonly hasLastError: CatalogTraceFlag;
  readonly createdAt: Date;
}

export type CatalogTraceMatchingHop =
  | {
      readonly state: 'present';
      readonly rows: readonly CatalogTraceMatchQueueRow[];
      /**
       * Variants this listing has that no queue row names.
       *
       * The number that makes the hop honest: a listing with six variants and one
       * queue row is a partial enqueue, and a trace reporting only the row it
       * found would read as a working hop. `syncListingFacets` enqueues one per
       * variant, so anything above zero is a finding.
       */
      readonly variantsWithoutQueueRow: number;
      readonly variantCount: number;
    }
  | {
      readonly state: 'empty';
      readonly reason: 'listing_has_no_variants' | 'no_queue_row_for_any_variant';
      readonly variantCount: number;
    }
  | { readonly state: 'absent'; readonly reason: 'no_listing_to_read' };

/* -------------------------------------------------------------------------- */
/* Hop 6 — indexing, which does not work                                       */
/* -------------------------------------------------------------------------- */

/**
 * The reindex hop, and it is ALWAYS `unreachable`.
 *
 * This is the finding, not a placeholder. `attribute_reindex_requests` has
 * enqueuers, a deterministic id, a lease-shaped schema, a pending index and an
 * `attempts` counter — everything a working queue has — and:
 *
 *  1. **No consumer exists.** `listPendingReindexRequests`
 *     (`db/attributes/attributeOpsRepository.ts`) has exactly ONE caller, and it
 *     is a read-only operator listing in
 *     `controllers/internal-catalog-attributes.controller.ts`. There is no claim
 *     function, and NOTHING in the repository writes `processed_at` — grep it: the
 *     column appears in one place, an `is null` predicate in that listing's own
 *     `where`. So every row ever enqueued is still pending and always will be.
 *
 *  2. **No publication reaches it.** `publishDraft` writes no row in this queue.
 *     The producer set is not enumerated here on purpose — this docblock said
 *     "three enqueuers" and named three modules, and by the time anybody read it
 *     there were five, two of which arrived in #821 and one of which
 *     (`services/backfill/stages/projections.ts`) does not call the repository
 *     function at all. `CATALOG_EVENT_CONTRACTS.reindex_request` in
 *     `services/catalog-event-contracts.ts` carries the list, and its gate
 *     DERIVES it from the source tree, so it fails the build rather than ageing.
 *     And no publication path could land a row naming this listing anyway:
 *     `ATTRIBUTE_ENTITY_KINDS` is `['product', 'variant']` meaning CANONICAL
 *     product and variant, so there is no `entity_id` a native listing could
 *     occupy. The join does not exist.
 *
 * Reporting this as `pending` — which is what a naive count of unprocessed rows
 * would say — is the failure this branch exists to prevent: "queued, waiting" and
 * "queued, and nothing will ever read it" look identical in a depth metric and
 * lead an operator to opposite conclusions. `#94`'s own docblock says the table
 * is "DRAINED by whoever owns the index — #61 decides what that index is", and
 * #61 explicitly did NOT build it. The hop is honest about being a gap.
 */
export interface CatalogTraceReindexHop {
  readonly state: 'unreachable';
  readonly reason: 'no_consumer_and_no_producer_on_this_path';
  /** Nothing claims or completes a row. */
  readonly consumer: 'absent';
  /** No publication path enqueues one, and no entity kind could name a listing. */
  readonly producerOnPublicationPath: 'absent';
  /**
   * Rows in `attribute_reindex_requests` with no `processed_at`, across the WHOLE
   * table — deliberately not scoped to this publication, because no such scoping
   * is possible (see the docblock). Labelled `queueWide` so it cannot be misread
   * as this listing's backlog.
   */
  readonly queueWideUndrainedRequests: number;
  /** The modules a reader should check before believing this is still true. */
  readonly evidence: readonly string[];
}

/** Where the claim above was measured. Cited so it can be re-checked. */
const REINDEX_EVIDENCE: readonly string[] = [
  'db/attributes/attributeOpsRepository.ts: listPendingReindexRequests is the only reader; no claim function and no processed_at writer',
  'controllers/internal-catalog-attributes.controller.ts: its one caller, a read-only operator listing',
  'services/catalog-event-contracts.ts CATALOG_EVENT_CONTRACTS.reindex_request: the producer set, none on the publication path — derived and gated there rather than listed here, because the list this line used to carry named three of the five',
  '@mercaria/shared-types ATTRIBUTE_ENTITY_KINDS = [product, variant]: canonical entities only, so no native listing id can appear in entity_id',
];

/* -------------------------------------------------------------------------- */
/* The trace                                                                   */
/* -------------------------------------------------------------------------- */

export interface CatalogPublicationTrace {
  /**
   * The handle, echoed. Ids only — it is the same closed set that was asked.
   *
   * Named `openedFrom` rather than `handle`, deliberately: in this repository
   * `handle` means a store's or listing's SLUG — a display label, and one this
   * domain's own log allow-list forbids (`CATALOG_LOG_FORBIDDEN_FIELDS`). A field
   * called `handle` on a trace whose whole point is that it carries no display
   * label is a name that will be misread, and the privacy walk in
   * `trace.realdb.test.ts` scans for exactly that word.
   */
  readonly openedFrom: CatalogPublicationTraceHandle;
  /** When this trace was assembled. It is a read, so it has no other clock. */
  readonly takenAt: Date;
  readonly draft: CatalogTraceDraftHop;
  readonly listing: CatalogTraceListingHop;
  readonly canonicalLinks: CatalogTraceCanonicalLinkHop;
  readonly offerConvergence: CatalogTraceOfferConvergenceHop;
  readonly variantMatching: CatalogTraceMatchingHop;
  readonly attributeReindex: CatalogTraceReindexHop;
}

/**
 * A `'yes' | 'no'` rather than a boolean, for the same `strict: false` reason the
 * discriminants are strings: a consumer that branches on one of these narrows
 * correctly, and a JSON reader cannot mistake it for a count.
 */
export type CatalogTraceFlag = 'yes' | 'no';

function flag(value: boolean): CatalogTraceFlag {
  return value ? 'yes' : 'no';
}

/**
 * Trace one publication through every hop the chain leaves a row for.
 *
 * `db` is a parameter defaulting to `getDb()`, the repository convention here,
 * and the realdb suite uses it to drive the whole trace on a rolled-back
 * transaction — which is what lets the fixtures for the `absent` controls exist
 * without ever being visible to a parallel test file.
 *
 * Returns `undefined` when the handle names nothing at all. A trace of a
 * non-existent subject is not an empty trace; a caller has to be able to answer
 * 404 rather than render six absent hops for an id somebody mistyped.
 */
export async function traceCatalogPublication(
  handle: CatalogPublicationTraceHandle,
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogPublicationTrace | undefined> {
  const takenAt = new Date();

  const draftRow = await readDraftRow(db, handle);
  const listingId = resolveListingId(handle, draftRow);

  if (draftRow === undefined && listingId === undefined) {
    catalogLogInfo({
      event: 'publication_trace_not_found',
      ...(handle.by === 'draft_id' ? { draftId: handle.draftId } : { listingId: handle.listingId }),
    });
    return undefined;
  }

  const listingRow = listingId === undefined ? undefined : await readListingRow(db, listingId);
  if (draftRow === undefined && listingRow === undefined) {
    // The handle was a listing id and no such listing exists.
    catalogLogInfo({ event: 'publication_trace_not_found', listingId });
    return undefined;
  }

  const draft = toDraftHop(handle, draftRow);
  const listing = toListingHop(handle, draftRow, listingRow);
  const traceableListingId = listingRow === undefined ? undefined : listingRow.id;

  const [canonicalLinks, offerConvergence, variantMatching, attributeReindex] = await Promise.all([
    readCanonicalLinkHop(db, traceableListingId),
    readOfferConvergenceHop(db, traceableListingId),
    readMatchingHop(db, traceableListingId, listingRow?.variantCount ?? 0),
    readReindexHop(db),
  ]);

  const trace: CatalogPublicationTrace = {
    openedFrom: handle,
    takenAt,
    draft,
    listing,
    canonicalLinks,
    offerConvergence,
    variantMatching,
    attributeReindex,
  };

  catalogLogInfo({
    event: 'publication_trace_read',
    ...(draftRow === undefined ? {} : { draftId: draftRow.id, schemaHash: draftRow.schemaHash }),
    ...(listingRow === undefined ? {} : { listingId: listingRow.id }),
    ...(listingRow?.storeId ? { storeId: listingRow.storeId } : {}),
    // Which hops resolved, as one greppable outcome string. Never the row
    // contents — a log line is not a second copy of the response.
    outcome: [
      `draft:${draft.state}`,
      `listing:${listing.state}`,
      `links:${canonicalLinks.state}`,
      `offers:${offerConvergence.state}`,
      `matching:${variantMatching.state}`,
      `reindex:${attributeReindex.state}`,
    ].join(','),
  });

  return trace;
}

/* -------------------------------------------------------------------------- */
/* The reads. Every one names its columns.                                     */
/* -------------------------------------------------------------------------- */

/** The draft columns a trace may see. No `created_by_oxy_user_id`, no title. */
const DRAFT_COLUMNS = {
  id: catalogAuthoringDrafts.id,
  storeId: catalogAuthoringDrafts.storeId,
  status: catalogAuthoringDrafts.status,
  version: catalogAuthoringDrafts.version,
  schemaHash: catalogAuthoringDrafts.schemaHash,
  productTypeDefinitionId: catalogAuthoringDrafts.productTypeDefinitionId,
  categoryId: catalogAuthoringDrafts.categoryId,
  locale: catalogAuthoringDrafts.locale,
  market: catalogAuthoringDrafts.market,
  publishedListingId: catalogAuthoringDrafts.publishedListingId,
  publishedAt: catalogAuthoringDrafts.publishedAt,
  schemaSnapshot: catalogAuthoringDrafts.schemaSnapshot,
  createdAt: catalogAuthoringDrafts.createdAt,
  updatedAt: catalogAuthoringDrafts.updatedAt,
};

type DraftRow = {
  id: string;
  storeId: string;
  status: string;
  version: number;
  schemaHash: string;
  productTypeDefinitionId: string;
  categoryId: string;
  locale: string;
  market: string;
  publishedListingId: string | null;
  publishedAt: Date | null;
  schemaSnapshot: unknown;
  createdAt: Date;
  updatedAt: Date;
};

async function readDraftRow(
  db: DatabaseOrTransaction,
  handle: CatalogPublicationTraceHandle,
): Promise<DraftRow | undefined> {
  const where =
    handle.by === 'draft_id'
      ? eq(catalogAuthoringDrafts.id, handle.draftId)
      : eq(catalogAuthoringDrafts.publishedListingId, handle.listingId);
  const rows = await db.select(DRAFT_COLUMNS).from(catalogAuthoringDrafts).where(where).limit(1);
  return rows[0] as DraftRow | undefined;
}

/**
 * Which listing this trace is about.
 *
 * From the handle when it named one; otherwise from the draft, and only when the
 * draft actually published. A draft's `published_listing_id` is NOT NULL exactly
 * while its status is `published` (`catalog_authoring_drafts_published_listing_check`),
 * so reading the column is the same test as reading the status.
 */
function resolveListingId(
  handle: CatalogPublicationTraceHandle,
  draftRow: DraftRow | undefined,
): string | undefined {
  if (handle.by === 'listing_id') return handle.listingId;
  return draftRow?.publishedListingId ?? undefined;
}

const LISTING_COLUMNS = {
  id: listings.id,
  storeId: listings.storeId,
  ownerType: listings.ownerType,
  status: listings.status,
  variantCount: listings.variantCount,
  categoryId: listings.categoryId,
  publishedAt: listings.publishedAt,
  createdAt: listings.createdAt,
  updatedAt: listings.updatedAt,
};

type ListingRow = {
  id: string;
  storeId: string | null;
  ownerType: string;
  status: string;
  variantCount: number;
  categoryId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

async function readListingRow(
  db: DatabaseOrTransaction,
  listingId: string,
): Promise<ListingRow | undefined> {
  const rows = await db
    .select(LISTING_COLUMNS)
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);
  return rows[0] as ListingRow | undefined;
}

function toDraftHop(
  handle: CatalogPublicationTraceHandle,
  draftRow: DraftRow | undefined,
): CatalogTraceDraftHop {
  if (draftRow === undefined) {
    return {
      state: 'absent',
      reason: handle.by === 'draft_id' ? 'draft_not_found' : 'listing_has_no_draft',
    };
  }
  return {
    state: 'present',
    draftId: draftRow.id,
    storeId: draftRow.storeId,
    status: draftRow.status,
    version: draftRow.version,
    schemaHash: draftRow.schemaHash,
    productTypeDefinitionId: draftRow.productTypeDefinitionId,
    categoryId: draftRow.categoryId,
    locale: draftRow.locale,
    market: draftRow.market,
    publishedListingId: draftRow.publishedListingId,
    publishedAt: draftRow.publishedAt,
    hasSchemaSnapshot: flag(draftRow.schemaSnapshot !== null && draftRow.schemaSnapshot !== undefined),
    createdAt: draftRow.createdAt,
    updatedAt: draftRow.updatedAt,
  };
}

function toListingHop(
  handle: CatalogPublicationTraceHandle,
  draftRow: DraftRow | undefined,
  listingRow: ListingRow | undefined,
): CatalogTraceListingHop {
  if (listingRow !== undefined) {
    return {
      state: 'present',
      listingId: listingRow.id,
      storeId: listingRow.storeId,
      ownerType: listingRow.ownerType,
      status: listingRow.status,
      variantCount: listingRow.variantCount,
      categoryId: listingRow.categoryId,
      publishedAt: listingRow.publishedAt,
      createdAt: listingRow.createdAt,
      updatedAt: listingRow.updatedAt,
    };
  }
  if (handle.by === 'listing_id') return { state: 'absent', reason: 'listing_not_found' };
  if (draftRow !== undefined && draftRow.publishedListingId !== null) {
    return { state: 'absent', reason: 'published_listing_missing' };
  }
  return { state: 'absent', reason: 'draft_not_published' };
}

async function readCanonicalLinkHop(
  db: DatabaseOrTransaction,
  listingId: string | undefined,
): Promise<CatalogTraceCanonicalLinkHop> {
  if (listingId === undefined) return { state: 'absent', reason: 'no_listing_to_read' };
  const rows = await db
    .select({
      linkId: nativeListingLinks.id,
      productVariantId: nativeListingLinks.productVariantId,
      canonicalVariantId: nativeListingLinks.canonicalVariantId,
      method: nativeListingLinks.method,
      matchRule: nativeListingLinks.matchRule,
      status: nativeListingLinks.status,
      confidence: nativeListingLinks.confidence,
      createdAt: nativeListingLinks.createdAt,
    })
    .from(nativeListingLinks)
    .where(eq(nativeListingLinks.listingId, listingId));
  if (rows.length === 0) return { state: 'empty', reason: 'no_canonical_attachment' };
  return { state: 'present', links: rows as readonly CatalogTraceCanonicalLink[] };
}

async function readOfferConvergenceHop(
  db: DatabaseOrTransaction,
  listingId: string | undefined,
): Promise<CatalogTraceOfferConvergenceHop> {
  if (listingId === undefined) return { state: 'absent', reason: 'no_listing_to_read' };
  const rows = await db
    .select({
      outboxId: offerOutboxes.id,
      status: offerOutboxes.status,
      requestedRevision: offerOutboxes.requestedRevision,
      claimedRevision: offerOutboxes.claimedRevision,
      attempts: offerOutboxes.attempts,
      availableAt: offerOutboxes.availableAt,
      processedAt: offerOutboxes.processedAt,
      leaseUntil: offerOutboxes.leaseUntil,
      lastError: offerOutboxes.lastError,
      createdAt: offerOutboxes.createdAt,
      updatedAt: offerOutboxes.updatedAt,
    })
    .from(offerOutboxes)
    .where(eq(offerOutboxes.listingId, listingId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { state: 'absent', reason: 'no_outbox_row' };
  return {
    state: 'present',
    outboxId: row.outboxId,
    status: row.status,
    convergence: deriveConvergence(row.status, row.requestedRevision, row.claimedRevision),
    requestedRevision: row.requestedRevision,
    claimedRevision: row.claimedRevision,
    attempts: row.attempts,
    availableAt: row.availableAt,
    processedAt: row.processedAt,
    leaseUntil: row.leaseUntil,
    hasLastError: flag(row.lastError !== null && row.lastError !== undefined),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Read the status and the revision pair together.
 *
 * Exported for the test: this is the one piece of derivation in the file, and the
 * `superseded` case is unreachable from a fixture that only ever enqueues once,
 * so it is driven directly.
 */
export function deriveConvergence(
  status: string,
  requestedRevision: number,
  claimedRevision: number | null,
): CatalogTraceConvergence {
  if (status === 'dead_letter') return 'dead_letter';
  if (status === 'processing') return 'in_flight';
  if (claimedRevision === null || claimedRevision === undefined) return 'never_claimed';
  if (claimedRevision < requestedRevision) return 'superseded';
  return status === 'done' ? 'converged' : 'retrying';
}

async function readMatchingHop(
  db: DatabaseOrTransaction,
  listingId: string | undefined,
  variantCount: number,
): Promise<CatalogTraceMatchingHop> {
  if (listingId === undefined) return { state: 'absent', reason: 'no_listing_to_read' };

  const variantRows = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.listingId, listingId));
  const variantIds = variantRows.map((row) => row.id);

  // The listing's OWN variants, counted here rather than trusted from
  // `listings.variant_count`: that column is a maintained projection, and a
  // trace that reported "every variant is queued" off it would be comparing a
  // count against itself if it ever drifted.
  if (variantIds.length === 0) {
    return { state: 'empty', reason: 'listing_has_no_variants', variantCount };
  }

  const rows = await db
    .select({
      queueId: matchQueue.id,
      productVariantId: matchQueue.productVariantId,
      subjectKind: matchQueue.subjectKind,
      trigger: matchQueue.trigger,
      status: matchQueue.status,
      requestedRevision: matchQueue.requestedRevision,
      claimedRevision: matchQueue.claimedRevision,
      attempts: matchQueue.attempts,
      availableAt: matchQueue.availableAt,
      processedAt: matchQueue.processedAt,
      lastError: matchQueue.lastError,
      createdAt: matchQueue.createdAt,
    })
    .from(matchQueue)
    .where(inArray(matchQueue.productVariantId, variantIds));

  if (rows.length === 0) {
    return { state: 'empty', reason: 'no_queue_row_for_any_variant', variantCount: variantIds.length };
  }

  const queuedVariantIds = new Set(rows.map((row) => row.productVariantId));
  return {
    state: 'present',
    rows: rows.map((row) => ({
      queueId: row.queueId,
      productVariantId: row.productVariantId,
      subjectKind: row.subjectKind,
      trigger: row.trigger,
      status: row.status,
      requestedRevision: row.requestedRevision,
      claimedRevision: row.claimedRevision,
      attempts: row.attempts,
      availableAt: row.availableAt,
      processedAt: row.processedAt,
      hasLastError: flag(row.lastError !== null && row.lastError !== undefined),
      createdAt: row.createdAt,
    })),
    variantsWithoutQueueRow: variantIds.filter((id) => !queuedVariantIds.has(id)).length,
    variantCount: variantIds.length,
  };
}

async function readReindexHop(db: DatabaseOrTransaction): Promise<CatalogTraceReindexHop> {
  const rows = await db
    .select({ undrained: count() })
    .from(attributeReindexRequests)
    .where(isNull(attributeReindexRequests.processedAt));
  return {
    state: 'unreachable',
    reason: 'no_consumer_and_no_producer_on_this_path',
    consumer: 'absent',
    producerOnPublicationPath: 'absent',
    queueWideUndrainedRequests: Number(rows[0]?.undrained ?? 0),
    evidence: REINDEX_EVIDENCE,
  };
}
