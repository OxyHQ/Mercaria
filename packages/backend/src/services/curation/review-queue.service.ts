/**
 * The review QUEUE — the eight detectors that fill it and the three acts that
 * empty it (#59 review queue 1–8).
 *
 * ## The detectors READ; they never decide
 *
 * Every scan below turns a state that already exists somewhere in the graph — a
 * `manual_review` decision, a `disputed` identifier, a `conflicting` attribute
 * value, a `candidate` relationship — into a row an operator can claim. None of
 * them writes to the domain it reads, and none of them invents a judgement:
 * `catalog_review_items` is an INBOX, and the moment a detector could change
 * what it observes it would be a second matcher with none of #58's gates.
 *
 * ## Convergence, and what it costs
 *
 * `upsertReviewItem` converges on the open item for the same problem, so running
 * every scan on a schedule does not fill the inbox with duplicates. It is scoped
 * to the OPEN states deliberately: a problem that comes back after somebody
 * fixed it opens a NEW item, because burying a recurrence under an old
 * resolution hides that the fix did not hold.
 *
 * ## The scans are BOUNDED and take no lease
 *
 * Each returns at most `limit` rows and writes at most that many items. They are
 * safe to run concurrently on every ECS task because the convergence unique
 * absorbs the duplicates — which is why they need no cursor table and no lease,
 * unlike the merge jobs they feed.
 */

import { and, desc, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  CurationDetector,
  CurationReasonCode,
  CurationResolution,
  CurationReviewKind,
  CurationSubjectType,
} from '@mercaria/shared-types';
import { CURATION_DISMISSAL_RESOLUTIONS } from '@mercaria/shared-types';
import {
  findMergedSubjects,
  subjectRedirectKey,
  type CurationSubjectRedirect,
} from './subject-redirect.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  claimReviewItem,
  closeReviewItem,
  findReviewItemById,
  listReviewItems,
  releaseReviewItem,
  summarizeReviewQueue,
  upsertReviewItem,
  type ReviewQueueFilter,
} from '../../db/curation/curationRepository.js';
import { catalogReviewItems, type CatalogReviewItemRow } from '../../db/schema/curation.js';
import {
  canonicalAttributeValues,
  canonicalProducts,
  productIdentifiers,
} from '../../db/schema/canonicalCatalog.js';
import { brands } from '../../db/schema/organizations.js';
import { merchantDomains } from '../../db/schema/merchants.js';
import { commerceRelationships } from '../../db/schema/relationships.js';
import { matchDecisions } from '../../db/schema/matching.js';
import { canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { offers } from '../../db/schema/offers.js';
import { recordRevision } from './revision.js';

/** The bound every scan below honours. A queue nobody can read is not a queue. */
const DEFAULT_SCAN_LIMIT = 200;

interface ScanResult {
  readonly kind: CurationReviewKind;
  readonly raised: number;
}

/**
 * `ambiguous_match` — #58's own review inbox, surfaced (#59 review queue 1).
 *
 * The item POINTS at the decision through a real foreign key and copies neither
 * its verdict nor its blockers. `match_decisions.review_state` stays #58's
 * field; two representations of one review state disagree the first time one
 * path forgets the other, and the path that forgets is always the unwatched one.
 */
export async function scanAmbiguousMatches(
  limit: number = DEFAULT_SCAN_LIMIT,
  db: DatabaseOrTransaction = getDb(),
): Promise<ScanResult> {
  const rows = await db
    .select({
      id: matchDecisions.id,
      confidence: matchDecisions.confidence,
      blockers: matchDecisions.blockers,
      policyVersionId: matchDecisions.policyVersionId,
      sourceRecordId: matchDecisions.sourceRecordId,
    })
    .from(matchDecisions)
    .where(eq(matchDecisions.reviewState, 'pending'))
    .orderBy(matchDecisions.createdAt)
    .limit(limit);

  for (const row of rows) {
    await upsertReviewItem(
      {
        kind: 'ambiguous_match',
        detector: 'match_pipeline',
        subjectType: 'match_decision',
        subjectId: row.id,
        reasonCodes: mapBlockersToReasonCodes(row.blockers),
        confidence: row.confidence,
        matchDecisionId: row.id,
        policyVersionId: row.policyVersionId,
        sourceRecordId: row.sourceRecordId,
      },
      db,
    );
  }
  return { kind: 'ambiguous_match', raised: rows.length };
}

/**
 * #58's blockers, narrowed to the reason codes this queue names.
 *
 * A deliberate NARROWING rather than a copy: `MATCH_BLOCKERS` is #58's
 * vocabulary for why a merge is forbidden, and re-exporting it here would make
 * this domain's reason set change whenever that one did. An unmapped blocker
 * becomes `ambiguous_candidates`, which is the honest reading of "the pipeline
 * refused and this queue does not have a word for why" — the decision itself is
 * one click away through `matchDecisionId`.
 */
function mapBlockersToReasonCodes(blockers: readonly string[]): readonly CurationReasonCode[] {
  const mapped = new Set<CurationReasonCode>();
  for (const blocker of blockers) {
    switch (blocker) {
      case 'conflicting_identifier':
        mapped.add('conflicting_identifier');
        break;
      case 'brand_mismatch':
        mapped.add('brand_disagreement');
        break;
      case 'no_deterministic_support':
        mapped.add('no_deterministic_support');
        break;
      default:
        mapped.add('ambiguous_candidates');
    }
  }
  if (mapped.size === 0) mapped.add('ambiguous_candidates');
  return [...mapped];
}

/**
 * `identifier_conflict` — ADR 0002 D14's collision gate, surfaced.
 *
 * A `disputed` row NAMES the active owner it collides with
 * (`conflicts_with_identifier_id`, present exactly when disputed, by CHECK), so
 * the pair is complete without a second query. The DIRECTION is meaningful and
 * is why `identifier_conflict` is excluded from the id-ordering rule: the
 * subject is the disputed newcomer and the counterpart is the incumbent.
 */
export async function scanIdentifierConflicts(
  limit: number = DEFAULT_SCAN_LIMIT,
  db: DatabaseOrTransaction = getDb(),
): Promise<ScanResult> {
  const rows = await db
    .select({ id: productIdentifiers.id, conflictsWith: productIdentifiers.conflictsWithIdentifierId })
    .from(productIdentifiers)
    .where(eq(productIdentifiers.status, 'disputed'))
    .orderBy(productIdentifiers.createdAt)
    .limit(limit);

  let raised = 0;
  for (const row of rows) {
    if (!row.conflictsWith) continue;
    await upsertReviewItem(
      {
        kind: 'identifier_conflict',
        detector: 'identifier_collision_gate',
        subjectType: 'product_identifier',
        subjectId: row.id,
        counterpartType: 'product_identifier',
        counterpartId: row.conflictsWith,
        reasonCodes: ['conflicting_identifier'],
      },
      db,
    );
    raised += 1;
  }
  return { kind: 'identifier_conflict', raised };
}

/**
 * `source_fact_disagreement` — #94's `conflicting` selection state, surfaced.
 *
 * `conflicting` means two sources disagree and NEITHER was selected, which is
 * precisely the state an operator has to break. It is a selection state and not
 * a parse state (both parsed fine), so the item's job is to show what the
 * reviewer is choosing between.
 */
export async function scanAttributeDisagreements(
  limit: number = DEFAULT_SCAN_LIMIT,
  db: DatabaseOrTransaction = getDb(),
): Promise<ScanResult> {
  const rows = await db
    .select({ id: canonicalAttributeValues.id, sourceRecordId: canonicalAttributeValues.sourceRecordId })
    .from(canonicalAttributeValues)
    .where(eq(canonicalAttributeValues.selectionState, 'conflicting'))
    .orderBy(canonicalAttributeValues.createdAt)
    .limit(limit);

  for (const row of rows) {
    await upsertReviewItem(
      {
        kind: 'source_fact_disagreement',
        detector: 'attribute_conflict_scan',
        subjectType: 'canonical_attribute_value',
        subjectId: row.id,
        reasonCodes: ['sources_disagree', 'no_selected_value'],
        sourceRecordId: row.sourceRecordId,
      },
      db,
    );
  }
  return { kind: 'source_fact_disagreement', raised: rows.length };
}

/** `relationship_candidate` — #55's own candidate queue, surfaced here too. */
export async function scanRelationshipCandidates(
  limit: number = DEFAULT_SCAN_LIMIT,
  db: DatabaseOrTransaction = getDb(),
): Promise<ScanResult> {
  const rows = await db
    .select({ id: commerceRelationships.id, confidence: commerceRelationships.confidence })
    .from(commerceRelationships)
    .where(and(eq(commerceRelationships.status, 'candidate'), isNull(commerceRelationships.validTo)))
    .orderBy(commerceRelationships.createdAt)
    .limit(limit);

  for (const row of rows) {
    await upsertReviewItem(
      {
        kind: 'relationship_candidate',
        detector: 'relationship_intake',
        subjectType: 'commerce_relationship',
        subjectId: row.id,
        reasonCodes: ['awaiting_evidence'],
        confidence: row.confidence,
      },
      db,
    );
  }
  return { kind: 'relationship_candidate', raised: rows.length };
}

/**
 * `orphaned_record` — an ACTIVE offer whose canonical variant is a tombstone.
 *
 * The one orphan shape that is genuinely unreachable rather than merely
 * unattached: the offer is live and priced, and the variant it points at has
 * been merged away, so a comparison surface resolves it to a row nothing shows.
 * A source record with no link is NOT an orphan — it is an observation waiting
 * to be matched, which is #58's queue and not this one.
 */
export async function scanOrphanedOffers(
  limit: number = DEFAULT_SCAN_LIMIT,
  db: DatabaseOrTransaction = getDb(),
): Promise<ScanResult> {
  const rows = await db
    .select({ id: offers.id, sourceRecordId: offers.sourceRecordId })
    .from(offers)
    .innerJoin(canonicalVariants, eq(canonicalVariants.id, offers.canonicalVariantId))
    .where(and(eq(offers.status, 'active'), eq(canonicalVariants.status, 'merged')))
    .orderBy(offers.createdAt)
    .limit(limit);

  for (const row of rows) {
    await upsertReviewItem(
      {
        kind: 'orphaned_record',
        detector: 'orphan_scan',
        subjectType: 'offer',
        subjectId: row.id,
        reasonCodes: ['unattached_offer'],
        sourceRecordId: row.sourceRecordId,
      },
      db,
    );
  }
  return { kind: 'orphaned_record', raised: rows.length };
}

/**
 * `entity_collision` and `suspected_duplicate` — two live rows sharing a
 * normalized name.
 *
 * A normalized-name match is EVIDENCE FOR REVIEW and never a merge (#53's own
 * rule, pinned by its tests). This scan is the shape that makes that rule
 * useful: it raises the pair for a person instead of acting on it, and the
 * `subject_id < counterpart_id` CHECK means (A,B) and (B,A) are one item however
 * the scan happened to read them.
 */
export async function scanDuplicateNames(
  limit: number = DEFAULT_SCAN_LIMIT,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ScanResult[]> {
  const results: ScanResult[] = [];

  const brandRight = alias(brands, 'brand_right');
  const brandPairs = await db
    .select({ left: brands.id, right: brandRight.id })
    .from(brands)
    .innerJoin(
      brandRight,
      and(
        eq(brandRight.normalizedName, brands.normalizedName),
        gt(brandRight.id, brands.id),
        ne(brandRight.status, 'merged'),
      ),
    )
    .where(and(ne(brands.status, 'merged'), ne(brands.normalizedName, '')))
    .limit(limit);
  results.push(await raisePairs('entity_collision', 'brand', brandPairs, db, 'normalized_name_collision'));

  /**
   * A merchant collision is detected on a SHARED DOMAIN, not on a name.
   *
   * `merchants` carries no `normalized_name` column, and the absence is a
   * decision rather than a gap: ADR 0002 D3 makes a merchant a seller of record
   * and #53 keeps name matching out of identity entirely. What two merchant rows
   * genuinely sharing a hostname means is that one of them is probably the
   * other, and `merchant_domains` is where that fact already lives — so the
   * detector uses the evidence the graph actually holds instead of a similarity
   * this layer would have to invent.
   */
  const domainRight = alias(merchantDomains, 'merchant_domain_right');
  const merchantPairs = await db
    .select({ left: merchantDomains.merchantId, right: domainRight.merchantId })
    .from(merchantDomains)
    .innerJoin(
      domainRight,
      and(
        eq(domainRight.domain, merchantDomains.domain),
        gt(domainRight.merchantId, merchantDomains.merchantId),
      ),
    )
    .limit(limit);
  results.push(await raisePairs('entity_collision', 'merchant', merchantPairs, db, 'shared_domain'));

  const productRight = alias(canonicalProducts, 'product_right');
  const productPairs = await db
    .select({ left: canonicalProducts.id, right: productRight.id })
    .from(canonicalProducts)
    .innerJoin(
      productRight,
      and(
        eq(productRight.normalizedName, canonicalProducts.normalizedName),
        gt(productRight.id, canonicalProducts.id),
        ne(productRight.status, 'merged'),
      ),
    )
    .where(and(ne(canonicalProducts.status, 'merged'), ne(canonicalProducts.normalizedName, '')))
    .limit(limit);
  results.push(
    await raisePairs('suspected_duplicate', 'canonical_product', productPairs, db, 'normalized_name_collision'),
  );

  return results;
}

/** Raise one pair-shaped item per row. The id order the CHECK requires is the join's. */
async function raisePairs(
  kind: CurationReviewKind,
  subjectType: CurationSubjectType,
  pairs: readonly { readonly left: string; readonly right: string }[],
  db: DatabaseOrTransaction,
  reasonCode: CurationReasonCode,
): Promise<ScanResult> {
  for (const pair of pairs) {
    await upsertReviewItem(
      {
        kind,
        detector: 'duplicate_scan',
        subjectType,
        subjectId: pair.left,
        counterpartType: subjectType,
        counterpartId: pair.right,
        reasonCodes: [reasonCode],
      },
      db,
    );
  }
  return { kind, raised: pairs.length };
}

/**
 * `policy_regression` — a subject that used to match automatically and no
 * longer does (#59 review queue 8).
 *
 * `match_decisions` is `UNIQUE(evaluation_key, policy_version_id)`, so a new
 * policy produces a NEW row beside the old one — which is exactly what makes
 * outcomes comparable (#58 operations 2). The regression is that comparison:
 * the same subject, an older policy that said `automatic_match`, a newer one
 * that did not.
 */
export async function scanPolicyRegressions(
  limit: number = DEFAULT_SCAN_LIMIT,
  db: DatabaseOrTransaction = getDb(),
): Promise<ScanResult> {
  const older = alias(matchDecisions, 'older_decision');
  const rows = await db
    .select({ id: matchDecisions.id, policyVersionId: matchDecisions.policyVersionId })
    .from(matchDecisions)
    .innerJoin(
      older,
      and(
        eq(older.subjectKey, matchDecisions.subjectKey),
        ne(older.policyVersionId, matchDecisions.policyVersionId),
        lt(older.createdAt, matchDecisions.createdAt),
        eq(older.outcome, 'automatic_match'),
      ),
    )
    .where(ne(matchDecisions.outcome, 'automatic_match'))
    .limit(limit);

  for (const row of rows) {
    await upsertReviewItem(
      {
        kind: 'policy_regression',
        detector: 'policy_regression_scan',
        subjectType: 'match_decision',
        subjectId: row.id,
        reasonCodes: ['lost_automatic_match'],
        policyVersionId: row.policyVersionId,
      },
      db,
    );
  }
  return { kind: 'policy_regression', raised: rows.length };
}

/** Run every detector once, bounded. The operator surface's "refresh" button. */
export async function runAllDetectors(limit: number = DEFAULT_SCAN_LIMIT): Promise<readonly ScanResult[]> {
  const db = getDb();
  return [
    await scanAmbiguousMatches(limit, db),
    await scanIdentifierConflicts(limit, db),
    await scanAttributeDisagreements(limit, db),
    await scanRelationshipCandidates(limit, db),
    await scanOrphanedOffers(limit, db),
    ...(await scanDuplicateNames(limit, db)),
    await scanPolicyRegressions(limit, db),
  ];
}

/** An operator raising an item by hand — the eighth detector, a person. */
export async function raiseReviewItem(input: {
  readonly kind: CurationReviewKind;
  readonly subjectType: CurationSubjectType;
  readonly subjectId: string;
  readonly counterpartType?: CurationSubjectType;
  readonly counterpartId?: string;
  readonly note: string;
  readonly actorOxyUserId: string;
}): Promise<CatalogReviewItemRow> {
  const db = getDb();
  const item = await upsertReviewItem(
    {
      kind: input.kind,
      detector: 'operator' satisfies CurationDetector,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      counterpartType: input.counterpartType ?? null,
      counterpartId: input.counterpartId ?? null,
      reasonCodes: ['operator_referred'],
      note: input.note,
    },
    db,
  );
  return item;
}

/**
 * One queue item, with what its two subjects have BECOME (#893).
 *
 * The row is spread verbatim and the two annotations are added beside it, rather
 * than the row being replaced by a wrapper: every existing reader keeps working,
 * and a reader that has not learned about tombstones is unchanged rather than
 * broken. `null` is the ordinary case — a live subject — and is DISTINCT from
 * the field being absent, which would mean nobody looked.
 */
export type CatalogReviewItemWithRedirects = CatalogReviewItemRow & {
  readonly subjectRedirect: CurationSubjectRedirect | null;
  readonly counterpartRedirect: CurationSubjectRedirect | null;
};

/**
 * Annotate a page of items with the tombstone state of both their subjects.
 *
 * ONE pass over the page collecting every `(type, id)`, then one statement per
 * distinct mergeable type — never a lookup per item. See `subject-redirect.ts`
 * for why an item is annotated rather than repointed.
 */
export async function annotateSubjectRedirects(
  items: readonly CatalogReviewItemRow[],
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly CatalogReviewItemWithRedirects[]> {
  const subjects: { type: CurationSubjectType; id: string }[] = [];
  for (const item of items) {
    subjects.push({ type: item.subjectType, id: item.subjectId });
    if (item.counterpartType && item.counterpartId) {
      subjects.push({ type: item.counterpartType, id: item.counterpartId });
    }
  }
  const merged = await findMergedSubjects(subjects, db);
  return items.map((item) => ({
    ...item,
    subjectRedirect: merged.get(subjectRedirectKey(item.subjectType, item.subjectId)) ?? null,
    counterpartRedirect:
      item.counterpartType && item.counterpartId
        ? (merged.get(subjectRedirectKey(item.counterpartType, item.counterpartId)) ?? null)
        : null,
  }));
}

export async function listQueue(
  filter: ReviewQueueFilter,
): Promise<readonly CatalogReviewItemWithRedirects[]> {
  const db = getDb();
  return annotateSubjectRedirects(await listReviewItems(filter, db), db);
}

export async function queueSummary(): ReturnType<typeof summarizeReviewQueue> {
  return summarizeReviewQueue(getDb());
}

/** Claim an item so two operators do not both start the same merge. */
export async function claimItem(id: string, actorOxyUserId: string): Promise<CatalogReviewItemRow> {
  const claimed = await claimReviewItem(id, actorOxyUserId, getDb());
  if (!claimed) {
    const existing = await findReviewItemById(id, getDb());
    if (!existing) throw notFound(`No review item ${id}.`);
    throw conflict(`Review item ${id} is ${existing.state} and cannot be claimed.`);
  }
  return claimed;
}

/** Hand an item back. Only its own claimant may. */
export async function releaseItem(id: string, actorOxyUserId: string): Promise<CatalogReviewItemRow> {
  const released = await releaseReviewItem(id, actorOxyUserId, getDb());
  if (!released) throw conflict(`Review item ${id} is not claimed by you.`);
  return released;
}

export interface ResolveReviewItemInput {
  readonly id: string;
  readonly resolution: CurationResolution;
  readonly reason: string;
  readonly actorOxyUserId: string;
}

/**
 * Close an item, and write the revision that says so.
 *
 * The STATE is derived from the resolution rather than taken from the caller:
 * `catalog_review_items_dismissal_check` and its twin already refuse the wrong
 * pairing, and deriving it here means an HTTP caller cannot record a merge as a
 * dismissal — which would make the queue's own metrics understate how much work
 * it produced.
 */
export async function resolveItem(input: ResolveReviewItemInput): Promise<CatalogReviewItemRow> {
  if (input.reason.trim() === '') {
    throw validationError('Closing a review item needs a reason.');
  }
  const db = getDb();
  const item = await findReviewItemById(input.id, db);
  if (!item) throw notFound(`No review item ${input.id}.`);
  const dismissing = CURATION_DISMISSAL_RESOLUTIONS.includes(input.resolution);
  const closed = await closeReviewItem(
    {
      id: input.id,
      state: dismissing ? 'dismissed' : 'resolved',
      resolution: input.resolution,
      resolutionReason: input.reason,
      resolvedByOxyUserId: input.actorOxyUserId,
    },
    db,
  );
  if (!closed) throw conflict(`Review item ${input.id} is already closed.`);
  await recordRevision(
    {
      entityType: item.subjectType,
      entityId: item.subjectId,
      action: dismissing ? 'update' : 'correct',
      actorKind: 'operator',
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      note: `review item ${item.kind} closed as ${input.resolution}`,
      reviewItemId: item.id,
      before: { state: item.state },
      after: { state: dismissing ? 'dismissed' : 'resolved', resolution: input.resolution },
    },
    db,
  );
  return closed;
}

/**
 * One item plus everything a reviewer needs to decide it.
 *
 * `item` and `priorItems` are BOTH annotated, and the second matters as much as
 * the first: "every other item ever raised about this row" is exactly the list
 * that goes stale after a merge, and an operator reading it without the
 * annotation cannot tell which of those subjects still exists (#893).
 */
export async function getItemWithContext(id: string): Promise<{
  readonly item: CatalogReviewItemWithRedirects;
  readonly priorItems: readonly CatalogReviewItemWithRedirects[];
}> {
  const db = getDb();
  const item = await findReviewItemById(id, db);
  if (!item) throw notFound(`No review item ${id}.`);
  const priorItems = await db
    .select()
    .from(catalogReviewItems)
    .where(
      and(
        eq(catalogReviewItems.subjectType, item.subjectType),
        eq(catalogReviewItems.subjectId, item.subjectId),
        ne(catalogReviewItems.id, item.id),
      ),
    )
    .orderBy(desc(catalogReviewItems.createdAt))
    .limit(20);
  // ONE annotation pass over the item and its context together, so the two
  // cannot disagree about whether a subject they share is a tombstone.
  const annotated = await annotateSubjectRedirects([item, ...priorItems], db);
  const [annotatedItem, ...annotatedPrior] = annotated;
  if (!annotatedItem) throw notFound(`No review item ${id}.`);
  return { item: annotatedItem, priorItems: annotatedPrior };
}

/** Every open item about one subject — the "is this already being worked on" read. */
export async function findOpenItemsForSubject(
  subjectType: CurationSubjectType,
  subjectId: string,
): Promise<readonly CatalogReviewItemRow[]> {
  return getDb()
    .select()
    .from(catalogReviewItems)
    .where(
      and(
        eq(catalogReviewItems.subjectType, subjectType),
        eq(catalogReviewItems.subjectId, subjectId),
        inArray(catalogReviewItems.state, ['open', 'in_review']),
      ),
    )
    .limit(50);
}
