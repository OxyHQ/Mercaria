/**
 * Matching, end to end: evaluate, persist the decision, apply the outcome.
 *
 * ## Closing #57's seam
 *
 * `native_listing_links` shipped with #57 complete and UNWRITTEN — a table, a
 * repository, four CHECKs and zero production writers, because "who decides an
 * attachment" was deliberately left to this issue. `convergeNativeOffersForListing`
 * materializes a native offer for exactly the variants that have an ACTIVE link
 * and skips the rest, so before #58 a native listing could never become a native
 * offer no matter what anybody wrote.
 *
 * {@link applyMatchOutcome} is the writer. An `automatic_match` on a native
 * variant inserts the link through #57's own repository and then calls
 * `requestNativeOfferSync`, so the offer materializes through the outbox path
 * that already exists. **Nothing here writes an `offers` row**, and nothing here
 * imports the offer repository — the matcher decides an attachment and the offer
 * domain decides what an attachment means, which is the boundary
 * `offer-isolation.test.ts` asserts from the other side.
 *
 * ## The method a link records is the STAGE that produced it
 *
 * `native_listing_links.confidence` is CHECK-restricted to `method = 'matcher'`
 * rows, and that constraint is not an obstacle to route around — it is #57
 * saying the same thing this domain says about `match_decisions.confidence`: a
 * deterministic attachment is certain by construction, and a number on it could
 * only be read as doubt about a fact nobody doubted. So a barcode match records
 * `barcode_gtin` with NULL confidence and a heuristic one records `matcher` with
 * a number, and {@link linkMethodForStage} is the single place that mapping
 * lives.
 *
 * ## What this service will NOT do
 *
 * - It never mints a canonical product. `create_new` is recorded and stops.
 * - It never writes an `offers` row.
 * - It never resolves an identifier dispute; a disputed GTIN is #59's.
 * - It never fails a catalogue write. `requestMatch` swallows and logs, the
 *   `requestNativeOfferSync` trade, so a listing save cannot fail because a
 *   matcher could not be QUEUED (#58 operations 4).
 */

import type { MatchQueueTrigger, NativeListingLinkMethod } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  enqueueMatch,
  type EnqueueMatchInput,
} from '../../db/matching/matchQueueRepository.js';
import {
  findActiveMatchPolicyVersion,
  type MatchPolicyVersionRow,
} from '../../db/matching/matchPolicyRepository.js';
import {
  upsertMatchDecision,
  type MatchDecisionRow,
} from '../../db/matching/matchDecisionRepository.js';
import {
  findActiveLinkForVariant,
  insertNativeListingLink,
  supersedeNativeListingLink,
} from '../../db/offers/nativeListingLinkRepository.js';
import { requestNativeOfferSync } from '../offers/native-offer.service.js';
import { PostgresCandidateSource } from './postgres-candidate-source.js';
import { evaluateMatch, type MatchEvaluation } from './pipeline.js';
import type { MatchCandidateSource } from './candidate-source.js';
import type { MatchPolicy } from './policy.js';
import { loadNativeVariantSubject, loadSourceRecordSubject } from './subject-loader.js';
import { matchSubjectKey, type MatchSubject } from './subject.js';

/** Read a stored policy row as the pure scorer's view of it. */
export function toMatchPolicy(row: MatchPolicyVersionRow): MatchPolicy {
  return {
    id: row.id,
    versionKey: row.versionKey,
    autoMinConfidence: row.autoMinConfidence,
    reviewMinConfidence: row.reviewMinConfidence,
    minCandidateSeparation: row.minCandidateSeparation,
    maxCandidates: row.maxCandidates,
    minTitleSimilarity: row.minTitleSimilarity,
    weights: {
      identifierAgreement: row.weightIdentifier,
      brandAgreement: row.weightBrand,
      modelAgreement: row.weightModel,
      attributeAgreement: row.weightAttribute,
      titleSimilarity: row.weightTitle,
      categoryAgreement: row.weightCategory,
      semanticSimilarity: row.weightSemantic,
    },
    semanticEnabled: row.semanticEnabled,
    minBenchmarkPrecision: row.minBenchmarkPrecision,
    minBenchmarkSamples: row.minBenchmarkSamples,
  };
}

/**
 * Ask for a subject to be matched. Durable, coalescing, and never fatal.
 *
 * Pass the caller's transaction when there is one, so a rolled-back catalogue
 * write leaves no request for a change that never happened.
 */
export async function requestMatch(
  input: EnqueueMatchInput,
  db?: DatabaseOrTransaction,
): Promise<void> {
  try {
    await enqueueMatch(input, db ?? getDb());
  } catch (err) {
    // A catalogue write must not fail because a matcher could not be QUEUED
    // (#58 operations 4). The listing is the authority; the attachment is
    // derived, and the next write to that listing enqueues again. One decision,
    // made here rather than at each call site.
    log.general.warn({ err, subjectKey: input.subjectKey }, '[Matching] failed to enqueue');
  }
}

/** The convenience the catalogue write path calls. */
export async function requestNativeVariantMatch(
  input: { productVariantId: string; trigger: MatchQueueTrigger },
  db?: DatabaseOrTransaction,
): Promise<void> {
  await requestMatch(
    {
      subjectKind: 'native_variant',
      subjectKey: matchSubjectKey({
        kind: 'native_variant',
        productVariantId: input.productVariantId,
      }),
      sourceRecordId: null,
      productVariantId: input.productVariantId,
      trigger: input.trigger,
    },
    db,
  );
}

/**
 * The `native_listing_links.method` a decision's stage justifies.
 *
 * A table rather than a condition, so adding a stage forces a decision about
 * what an attachment produced by it actually claims. Two members are absent on
 * purpose, because no stage here is either of them: `connector_declared` is a
 * platform declaring its own mapping (the connector sync), and `backfill` is
 * #60's migration attaching a native variant to a canonical variant it minted
 * from that same variant. A matcher recording either would be asserting evidence
 * it does not have.
 */
export function linkMethodForStage(stage: MatchEvaluation['decidedStage']): NativeListingLinkMethod {
  switch (stage) {
    case 'existing_source_link':
    case 'global_identifier':
      return 'barcode_gtin';
    case 'brand_scoped_identifier':
    case 'normalized_attributes':
    case 'candidate_retrieval':
    case 'semantic_assist':
    case 'no_candidate':
      return 'matcher';
  }
}

/** What one evaluation did. */
export interface MatchRunResult {
  readonly subjectKey: string;
  readonly decision: MatchDecisionRow | null;
  readonly evaluation: MatchEvaluation | null;
  /** True when this run created or replaced a `native_listing_links` row. */
  readonly attached: boolean;
  /** Why nothing happened, when nothing did. */
  readonly skipped: 'subject_gone' | 'no_active_policy' | null;
}

/**
 * Persist a decision and apply its outcome, in ONE transaction.
 *
 * The decision row, its candidate rows and the attachment commit together. The
 * offer convergence request is enqueued in the SAME transaction, so a rolled-back
 * attachment leaves no request to materialize an offer for a link that does not
 * exist — and a committed attachment always leaves the request, so a crash
 * immediately afterwards still converges.
 *
 * Superseding is two statements rather than an upsert, per #57's own note: the
 * old link must survive as history with its method, rule and confidence intact.
 * The `native_listing_links_active_variant_key` partial unique makes the pair
 * safe — the CAS on `status = 'active'` means a concurrent second supersede
 * writes nothing, so the insert that follows cannot race the unique against
 * itself.
 */
export async function applyMatchOutcome(
  subject: MatchSubject,
  evaluation: MatchEvaluation,
  policy: MatchPolicy,
  now: Date = new Date(),
): Promise<{ decision: MatchDecisionRow; attached: boolean }> {
  return getDb().transaction(async (tx) => {
    const ranked = [...evaluation.candidates].sort((left, right) => right.score - left.score);
    const selectedKey =
      evaluation.matchedCanonicalVariantId === null
        ? null
        : evaluation.matchedCanonicalVariantId;

    const decision = await upsertMatchDecision(tx, {
      subjectKind: subject.kind,
      subjectKey: subject.key,
      sourceRecordId: subject.sourceRecordId ?? null,
      productVariantId: subject.productVariantId ?? null,
      policyVersionId: policy.id,
      outcome: evaluation.outcome,
      decidedStage: evaluation.decidedStage,
      confidence: evaluation.confidence,
      matchedCanonicalProductId: evaluation.matchedCanonicalProductId,
      matchedCanonicalVariantId: evaluation.matchedCanonicalVariantId,
      reasonCodes: evaluation.reasonCodes,
      blockers: evaluation.blockers,
      positiveIdentifiers: evaluation.positiveIdentifiers,
      conflictingIdentifiers: evaluation.conflictingIdentifiers,
      normalizedBrand: evaluation.normalizedBrand,
      normalizedModel: evaluation.normalizedModel,
      normalizedTitle: evaluation.normalizedTitle,
      categoryKey: evaluation.categoryKey,
      candidates: ranked.map((candidate, index) => ({
        canonicalProductId: candidate.canonicalProductId,
        canonicalVariantId: candidate.canonicalVariantId,
        rank: index + 1,
        score: candidate.score,
        selected:
          selectedKey !== null &&
          candidate.canonicalVariantId === selectedKey &&
          evaluation.outcome === 'automatic_match',
        rejection: candidate.rejection,
        ...candidate.features,
      })),
      now,
    });

    const attached = await attachIfAutomatic(tx, subject, evaluation, policy);
    return { decision, attached };
  });
}

/**
 * Write the `native_listing_links` row an automatic match earns.
 *
 * Only for a NATIVE subject: a source observation's attachment is a
 * `canonical_*_source_links` row, and that write belongs to the ingestion path
 * that owns the observation (#37/#60), not to a matcher reaching sideways into
 * another domain's write service.
 */
async function attachIfAutomatic(
  tx: DatabaseOrTransaction,
  subject: MatchSubject,
  evaluation: MatchEvaluation,
  policy: MatchPolicy,
): Promise<boolean> {
  if (evaluation.outcome !== 'automatic_match') return false;
  if (subject.kind !== 'native_variant') return false;
  if (subject.productVariantId === undefined || subject.listingId === undefined) return false;
  if (evaluation.matchedCanonicalVariantId === null) return false;

  const existing = await findActiveLinkForVariant(tx, subject.productVariantId);
  /**
   * A SELLER's own declaration is never overwritten by a score (#91).
   *
   * `seller_declared` is written by `services/sell-yours/` only after the same
   * deterministic blockers this pipeline reads have been checked against the
   * exact pair the seller chose — so a matcher preferring a different candidate
   * here is a heuristic disagreeing with a person who owns the item, about the
   * item. #80's `save_intent` pin, one layer down: the strongest signal anybody
   * can give must not lose to an automatic one.
   *
   * The disagreement is not lost. The decision row is still written above with
   * its own `matched_canonical_variant_id`, so "the matcher would have chosen
   * something else" is readable by comparing it against the active link — which
   * is what `readSellerDraftConsistency` reports and what a `wrong_product_match`
   * report is investigated against.
   */
  if (existing && existing.method === 'seller_declared') {
    log.general.info(
      {
        productVariantId: subject.productVariantId,
        declaredCanonicalVariantId: existing.canonicalVariantId,
        matcherCanonicalVariantId: evaluation.matchedCanonicalVariantId,
      },
      '[Matching] leaving a seller-declared attachment in place',
    );
    return false;
  }
  if (existing && existing.canonicalVariantId === evaluation.matchedCanonicalVariantId) {
    // Already attached to exactly this variant. Re-running the pipeline must be
    // a genuine no-op — no tuple churn, no superseded history row recording a
    // change that did not happen (ADR 0002 D22).
    return false;
  }
  if (existing) {
    const superseded = await supersedeNativeListingLink(tx, existing.id);
    if (!superseded) {
      // Somebody else moved this attachment between the read and the write. The
      // active-variant partial unique would refuse the insert anyway; refusing
      // here keeps the failure legible instead of surfacing as a 23505.
      log.general.warn(
        { productVariantId: subject.productVariantId },
        '[Matching] attachment changed mid-run; leaving it to the next evaluation',
      );
      return false;
    }
  }

  const method = linkMethodForStage(evaluation.decidedStage);
  await insertNativeListingLink(tx, {
    productVariantId: subject.productVariantId,
    listingId: subject.listingId,
    canonicalVariantId: evaluation.matchedCanonicalVariantId,
    method,
    // The rule id an operator reads and #59 reviews. Stage plus policy, because
    // "which rule attached this" is not answerable without both.
    matchRule: `${evaluation.decidedStage}:${policy.versionKey}`,
    // CHECK-restricted to `matcher` rows, and NULL on a deterministic one for
    // the same reason `match_decisions.confidence` is.
    confidence: method === 'matcher' ? evaluation.confidence : null,
    sourceRecordId: subject.sourceRecordId ?? null,
  });

  // The seam, closed: the offer domain's own convergence request, in this
  // transaction, so a rolled-back attachment leaves no request behind it.
  await requestNativeOfferSync(subject.listingId, tx);
  return true;
}

/**
 * Evaluate ONE subject and apply the result.
 *
 * @param source Injectable so the benchmark measures this exact orchestration
 *   against an in-memory catalogue. Production passes nothing.
 */
export async function runMatch(
  input:
    | { readonly kind: 'native_variant'; readonly productVariantId: string }
    | { readonly kind: 'source_record'; readonly sourceRecordId: string },
  options: { readonly source?: MatchCandidateSource; readonly now?: Date } = {},
): Promise<MatchRunResult> {
  const now = options.now ?? new Date();
  const policyRow = await findActiveMatchPolicyVersion();
  if (!policyRow) {
    // No active policy is a CONFIGURATION state, not a failure: a deployment
    // that has published none matches nothing, records nothing, and breaks
    // nothing. Dead-lettering the queue over it would make publishing the first
    // policy require draining a dead-letter queue.
    return {
      subjectKey: '',
      decision: null,
      evaluation: null,
      attached: false,
      skipped: 'no_active_policy',
    };
  }
  const policy = toMatchPolicy(policyRow);

  const subject =
    input.kind === 'native_variant'
      ? await loadNativeVariantSubject(input.productVariantId)
      : await loadSourceRecordSubject(input.sourceRecordId);
  if (subject === null) {
    return {
      subjectKey: '',
      decision: null,
      evaluation: null,
      attached: false,
      skipped: 'subject_gone',
    };
  }

  const source = options.source ?? new PostgresCandidateSource();
  const evaluation = await evaluateMatch(subject, policy, source);
  const { decision, attached } = await applyMatchOutcome(subject, evaluation, policy, now);

  return { subjectKey: subject.key, decision, evaluation, attached, skipped: null };
}
