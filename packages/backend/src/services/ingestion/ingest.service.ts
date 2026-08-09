/**
 * THE STAGED PIPELINE — #62's whole lifecycle, in one place.
 *
 * ```text
 * fetch → validate rights + schema → persist observation → normalize
 *       → deterministic match → optional review queue
 *       → canonical link → offer upsert → freshness/expiry
 * ```
 *
 * Every stage is here and none of them is in an adapter. That is the point of
 * the issue: provider-specific code stays behind `CatalogSourceAdapter`, and
 * everything that touches the commerce graph is this file plus the repositories
 * it calls.
 *
 * ## The four write boundaries, and where each one actually lives
 *
 * 1. **Adapters never create canonical products, brands or merchants.** There
 *    is no code path from here into a canonical WRITE service — the matcher is
 *    called, and it never mints either (#58's own rule). A `create_new`
 *    recommendation is RECORDED and the object is left `unmatched`; #60 owns
 *    minting, and `ingestion-isolation.test.ts` fails the build if this domain
 *    imports one.
 * 2. **An offer is upserted only after canonical variant AND merchant
 *    resolution.** {@link materializeOffer} takes both as required arguments,
 *    and the merchant comes from the source's own binding rather than from a
 *    payload hint — an adapter has no field through which to name one.
 * 3. **Ambiguous matches route to review rather than to a guessed link.**
 *    Anything that is not an `automatic_match` writes NO canonical link and NO
 *    offer; the object goes to `review_required` citing the decision #59 reads.
 * 4. **An external source cannot make an offer checkout-native.** The kind is
 *    chosen from `EXTERNAL_OFFER_KINDS` here, and `offers_kind_shape_check`
 *    forces `product_variant_id` NULL on every one of them — so there is no id
 *    a cart line could hold, whatever this file does.
 *
 * ## Per-record isolation, page-level failure
 *
 * `#60`'s split, for its reasons. One bad record is caught, recorded as a
 * rejection and skipped, because a page that aborted on its worst row would
 * leave the cursor stuck on it forever. A failure of the FETCH is different:
 * the cursor does not move and the run is released for retry, so the page
 * re-runs from where it started.
 *
 * ## Ordering that a constraint depends on
 *
 * `catalog_source_runs_retirement_check` reads the run's `outcome` and
 * `enumeration_complete` together, so the closing sequence is: classify →
 * `finishSourceRun` → retire → `recordSourceRunRetirement`. Retiring before the
 * outcome is stored would be refused by the row. Stated here and in
 * `finishSourceRun`'s own docblock, because a constraint whose satisfaction
 * depends on statement order deserves to be documented on both sides.
 */

import type {
  CatalogSourceHealthState,
  CatalogSourceRejectionReason,
  CatalogSourceRightsVerdict,
  ConditionMappingProviderId,
  NormalizedSourceRecord,
  OfferKind,
  SourceAnomalyFinding,
  SourceLinkMethod,
  SourceObservationDistribution,
} from '@mercaria/shared-types';
import {
  CONDITION_MAPPING_PROVIDER_IDS,
  effectiveOfferLifetimeSeconds,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import { recordSourceObservation } from '../../db/canonical/provenanceRepository.js';
import { insertCanonicalProductSourceLink } from '../../db/canonical/canonicalProductRepository.js';
import { insertCanonicalVariantSourceLink } from '../../db/canonical/canonicalVariantRepository.js';
import {
  recordSourceHealth,
  releaseSourceLease,
} from '../../db/ingestion/catalogSourceConfigRepository.js';
import {
  listUnseenSourceObjects,
  quarantineSourceObject,
  retireSourceObject,
  setSourceObjectState,
  upsertSourceObject,
  type CatalogSourceObjectRow,
} from '../../db/ingestion/catalogSourceObjectRepository.js';
import { recordSourceRejection } from '../../db/ingestion/catalogSourceRejectionRepository.js';
import {
  finishSourceRun,
  findSourceRun,
  recordSourceRunPage,
  recordSourceRunRetirement,
  releaseSourceRun,
  type CatalogSourceRunRow,
} from '../../db/ingestion/catalogSourceRunRepository.js';
import { declareOffersUnavailable, retireOffers } from '../../db/offers/offerRepository.js';
import {
  countActiveSourceObjects,
  findSourceObjectsByExternalIds,
} from '../../db/ingestion/catalogSourceObjectRepository.js';
import { runMatch } from '../matching/match.service.js';
import { recordExternalOffer } from '../offers/offer.service.js';
import {
  EMPTY_DISTRIBUTION,
  summariseObservations,
  type ObservedPrice,
} from '../offer-freshness/distribution.js';
import {
  judgePagePublication,
  settleRunQuarantines,
} from '../offer-freshness/quarantine.service.js';
import {
  resolveFreshnessFromRows,
  type ResolvedFreshnessPolicy,
} from '../offer-freshness/policy.js';
import {
  classifyFetchError,
  type AdapterFetchPage,
  type AdapterRecord,
  type AdapterRemoval,
} from './adapter.js';
import {
  classifyRunOutcome,
  isDegraded,
  mayRetireUnseen,
  nextRunDelayMs,
  statusAfterRun,
} from './health.js';
import { NORMALIZATION_VERSION, canonicalizeNormalizedRecord } from './normalization.js';
import { redactSourceObservation } from './redact.js';
import { resolveCatalogSourceAdapter } from './registry.js';
import { resolveOfferMerchantId } from './seller-identity.js';
import { resolveIngestionSource, type ResolvedIngestionSource } from './source.service.js';

/**
 * The offer kinds an external source may produce.
 *
 * `native` is absent and unreachable: it is the kind a Mercaria listing
 * projects, and it is the only one `offers_kind_shape_check` lets carry a
 * `product_variant_id`. Naming the permitted set as a TYPE is what makes issue
 * write boundary 7 — "an external source can never make an external offer
 * checkout-native merely by ingestion" — a `tsc` error rather than a review
 * comment.
 */
type ExternalOfferKind = Exclude<OfferKind, 'native'>;

/** What one page did, as the dispatcher reads it. */
export interface IngestPageResult {
  readonly runId: string;
  readonly sourceId: string;
  readonly fetched: number;
  readonly stored: number;
  readonly rejected: number;
  readonly offersUpserted: number;
  /** `null` while more pages remain. */
  readonly outcome: CatalogSourceHealthState | null;
  /** Why nothing happened, when nothing did. */
  readonly skipped: 'run_gone' | 'source_gone' | 'adapter_missing' | 'lease_lost' | null;
}

/** The four intake outcomes, tallied for one page. */
interface IntakeTally {
  fetched: number;
  stored: number;
  unchanged: number;
  rejected: number;
  quarantined: number;
}

/** The downstream tallies for one page. */
interface PipelineTally {
  matched: number;
  reviewRequired: number;
  unmatched: number;
  offersUpserted: number;
}

/**
 * The `canonical_*_source_links.method` a decision's stage justifies.
 *
 * `linkMethodForStage` (#58) does the same job for a NATIVE attachment and this
 * is its source-observation counterpart, kept separate because the two
 * vocabularies are genuinely different: `SOURCE_LINK_METHODS` has
 * `connector_declared`, which no matcher stage produces, and
 * `NATIVE_LISTING_LINK_METHODS` has `barcode_gtin`, which is not a member here.
 * A confidence rides only a `heuristic` link, matching #57's rule that a
 * deterministic attachment is certain by construction and a number on it could
 * only read as doubt about a fact nobody doubted.
 */
export function sourceLinkMethodForStage(stage: string): SourceLinkMethod {
  return stage === 'existing_source_link' || stage === 'global_identifier'
    ? 'deterministic_identifier'
    : 'heuristic';
}

/**
 * Which #90 ruleset vocabulary reads this source's condition wording, if any.
 *
 * `catalog_source_configs.provider` is an OPEN set (external key spaces are not
 * Mercaria's to enumerate) and `condition_mapping_rulesets.provider` is a closed
 * one, so the narrowing is a membership test rather than a cast. A provider with
 * no vocabulary answers `undefined`, which `recordExternalOffer` reads as "no
 * ruleset to consult" and turns into a preserved label with an `unknown`
 * condition — the same fail-closed answer as a provider whose ruleset has not
 * been published yet.
 */
function conditionMappingProviderFor(provider: string): ConditionMappingProviderId | undefined {
  return (CONDITION_MAPPING_PROVIDER_IDS as readonly string[]).includes(provider)
    ? (provider as ConditionMappingProviderId)
    : undefined;
}

/** Compose a rejection note from FIELD NAMES. Never from values — see `redact.ts`. */
function describeRejection(reason: CatalogSourceRejectionReason, field?: string): string {
  return field === undefined ? reason : `${reason}: ${field}`;
}

/**
 * Has the price moved further than a real price move?
 *
 * A feed that renames its currency field, publishes minor units where it used
 * to publish major ones, or serves a placeholder produces exactly this shape,
 * and every one of them would otherwise become a headline price on a comparison
 * page. The factor is configurable because "how much is too much" genuinely
 * differs between a supermarket feed and an auction one; the check itself is
 * not, and a CURRENCY change alone is always anomalous — a price that changed
 * denomination is not a price that changed.
 */
function isAnomalousPriceChange(
  previous: { amount: number; currency: string } | null,
  next: { amount: number; currency: string } | undefined,
  factor: number,
): boolean {
  if (previous === null || next === undefined) return false;
  if (previous.currency !== next.currency) return true;
  if (previous.amount === 0 || next.amount === 0) return previous.amount !== next.amount;
  const ratio = next.amount / previous.amount;
  return ratio >= factor || ratio <= 1 / factor;
}

/**
 * Which offer kind these rights and this record justify.
 *
 * The rights DECIDE it, which is issue rights 5 and 6 made structural: a source
 * Mercaria may not link out to produces an `informational` offer with no
 * destination at all, and `offers_kind_shape_check` refuses a destination on
 * that kind — so "no outbound link" is a shape rather than a `null` somebody
 * remembered to pass.
 */
function offerKindFor(
  rights: CatalogSourceRightsVerdict,
  sourceKind: string,
  destinationUrl: string | undefined,
): ExternalOfferKind {
  if (!rights.outbound_link || destinationUrl === undefined) return 'informational';
  return sourceKind === 'affiliate_network' && rights.affiliate_params ? 'affiliate' : 'external';
}

/** Run one bounded page of one open run. */
export async function runIngestionPage(input: {
  runId: string;
  leaseOwner: string;
  now?: Date;
}): Promise<IngestPageResult> {
  const now = input.now ?? new Date();
  const db = getDb();

  const run = await findSourceRun(db, input.runId);
  if (!run) {
    return emptyResult(input.runId, '', 'run_gone');
  }

  const resolved = await resolveIngestionSource(run.sourceId, db);
  if (!resolved) {
    return emptyResult(run.id, run.sourceId, 'source_gone');
  }

  const adapter = resolveCatalogSourceAdapter(resolved.source.config.provider);
  if (adapter === undefined) {
    return emptyResult(run.id, run.sourceId, 'adapter_missing');
  }

  /**
   * The source's own freshness contract (#68), resolved BEFORE the fetch so the
   * deadline every observation is stamped with comes from a policy rather than
   * from a constant.
   *
   * It is built from rows `resolveIngestionSource` has ALREADY read — the
   * config and the active rights policy — so a page costs one extra query
   * rather than four. There is no `undefined` branch to handle: a run only
   * exists for a configured source, which is the whole of what this needs.
   */
  const freshness = await resolveFreshnessFromRows(
    { config: resolved.source.config, rights: resolved.policy },
    db,
  );


  /**
   * The rights gate, BEFORE the fetch.
   *
   * A source whose refresh right was withdrawn between the claim and now must
   * not be contacted at all — that is what a rights suspension means, and
   * checking afterwards would already have made the request. The run closes
   * with `rights_suspended`, which `mayRetireUnseen` refuses, so a suspension
   * can never expire a catalogue either.
   */
  if (!resolved.rights.automated_refresh) {
    return closeRun({
      run,
      resolved,
      freshness,
      leaseOwner: input.leaseOwner,
      outcome: 'rights_suspended',
      failed: false,
      error: 'The active policy does not permit an automated refresh',
      retryAfterMs: undefined,
      now,
    });
  }

  /**
   * An EXTRACTION adapter needs the extraction right, not merely the refresh
   * one. Checked here rather than trusting the operator to have configured a
   * crawling provider against a crawling policy: two places establishing
   * whether Mercaria may scrape a site could disagree, and the one that must
   * win is the one holding the request.
   */
  if (adapter.extraction && !resolved.rights.extraction) {
    return closeRun({
      run,
      resolved,
      freshness,
      leaseOwner: input.leaseOwner,
      outcome: 'rights_suspended',
      failed: false,
      error: 'The active policy does not permit extraction from this source',
      retryAfterMs: undefined,
      now,
    });
  }

  const startedAt = Date.now();
  let page: AdapterFetchPage;
  try {
    page = await adapter.fetchPage({
      sourceId: run.sourceId,
      cursor: run.cursor,
      pageSize: resolved.source.config.pageSize,
      credentialRef: resolved.source.config.credentialRef,
      sourceAccountRef: resolved.source.config.sourceAccountRef,
      since: run.since,
      territories: resolved.source.config.territories,
      mode: run.refreshMode,
      externalIds: run.targetExternalIds,
    });
  } catch (error: unknown) {
    const failure = classifyFetchError(error);
    if (failure.retryable) {
      // The cursor is NOT moved, so the retry resumes from the page that
      // failed rather than from the top of the feed.
      const delayMs = nextRunDelayMs({
        cadenceSeconds: resolved.source.config.fetchCadenceSeconds,
        consecutiveFailures: resolved.source.config.consecutiveFailures + 1,
        retryAfterMs: failure.retryAfterMs,
        maxBackoffMs: config.catalogIngestion.maxBackoffMs,
      });
      await releaseSourceRun(db, {
        id: run.id,
        leaseOwner: input.leaseOwner,
        availableAt: new Date(now.getTime() + delayMs),
        error: failure.message,
        now,
      });
      await releaseSourceLease(db, {
        sourceId: run.sourceId,
        leaseOwner: input.leaseOwner,
        nextRunAt: new Date(now.getTime() + delayMs),
        now,
      });
      return emptyResult(run.id, run.sourceId, null);
    }
    return closeRun({
      run,
      resolved,
      freshness,
      leaseOwner: input.leaseOwner,
      outcome: classifyRunOutcome({
        enumerationComplete: false,
        failure: failure.kind,
        rejected: 0,
        quarantined: 0,
        reviewRequired: 0,
        fetched: 0,
        refreshPermitted: true,
      }),
      failed: true,
      error: failure.message,
      retryAfterMs: failure.retryAfterMs,
      now,
    });
  }

  const fetchDurationMs = page.fetchDurationMs ?? Date.now() - startedAt;
  const intake: IntakeTally = { fetched: 0, stored: 0, unchanged: 0, rejected: 0, quarantined: 0 };
  const pipeline: PipelineTally = {
    matched: 0,
    reviewRequired: 0,
    unmatched: 0,
    offersUpserted: 0,
  };

  /**
   * PHASE 1 — PERSIST. Every record becomes an observation, whatever the page
   * turns out to look like as a whole.
   *
   * Provenance is never withheld: an anomalous feed is a fact somebody needs to
   * be able to inspect afterwards, and a page that stored nothing would leave
   * the operator trace with nothing to show. What the gate below withholds is
   * PUBLICATION.
   */
  const seenInPage = new Set<string>();
  const pending: PendingObject[] = [];
  const prices: ObservedPrice[] = [];
  for (const record of page.records) {
    intake.fetched += 1;
    try {
      await persistOneRecord({
        record,
        run,
        resolved,
        freshness,
        seenInPage,
        intake,
        pending,
        prices,
        now,
      });
    } catch (error: unknown) {
      // Per-record isolation. Nothing rethrows: a page that aborted on its
      // worst record would leave the cursor stuck there forever.
      intake.rejected += 1;
      log.general.warn(
        { err: error, sourceId: run.sourceId, externalId: record.externalId },
        '[Ingestion] record failed and was recorded as a rejection',
      );
      await recordSourceRejection(db, {
        runId: run.id,
        sourceId: run.sourceId,
        externalType: record.externalType,
        externalId: record.externalId,
        reasonCode: 'parse_failure',
        detail: describeRejection('parse_failure'),
        rawPayloadDigest: null,
        now,
      });
    }
  }

  /**
   * PHASE 2 — EXPLICIT REMOVALS, before the gate and independent of it.
   *
   * A removal is a POSITIVE STATEMENT from the source and is evidence from any
   * run, complete or not (#68 acceptance 2). It is applied before the
   * distribution gate deliberately: the gate is about whether the PRICES this
   * page carried can be believed, and a finding about prices says nothing about
   * a deletion notice — holding one back would keep publishing a listing the
   * source has told us is gone, which is the obligation eBay's licence makes
   * non-negotiable.
   */
  const removed = await applyExplicitRemovals({
    run,
    freshness,
    removals: page.removals ?? [],
    now,
  });

  /**
   * PHASE 3 — the PRE-PUBLICATION gate (#68 anomaly 2 and 5).
   *
   * The page's distribution is compared against the source's stored baseline
   * BEFORE any of it becomes an offer. A quarantined page advances nothing, so
   * "never overwrite prior current offers with unvalidated anomalous records"
   * is a property of the call graph — `advanceObject` is simply unreachable —
   * rather than of a branch somebody remembers to write.
   *
   * `unseenPriorObjects` is `null` here and is measured only at CLOSE, where a
   * complete enumeration is the only thing that could establish an absence.
   */
  const distribution = summariseObservations({ sampleSize: intake.fetched, prices });
  const verdict = await judgePagePublication(db, {
    runId: run.id,
    sourceId: run.sourceId,
    distribution,
    thresholds: freshness.anomalyThresholds,
    unseenPriorObjects: null,
    heldObjects: pending.length,
    now,
  });

  if (verdict.mayPublish) {
    for (const item of pending) {
      /**
       * A failure AFTER intake is not an intake outcome.
       *
       * `catalog_source_runs_intake_total_check` is `fetched = stored +
       * unchanged + rejected + quarantined`, an EQUALITY — so a record already
       * counted as `stored` that then fails while matching or materializing its
       * offer must not ALSO be counted as `rejected`. The run row would be
       * refused outright, taking the whole page's bookkeeping with it, which is
       * how one bad downstream row turns into a page that recorded nothing.
       *
       * Nothing rethrows, for the reason the intake path one stage earlier does
       * not: a page that aborted on its worst record would leave the cursor
       * stuck there forever. The observation is already durable and the object
       * stays `observed`, so the next pass re-examines it.
       */
      try {
        await advanceObject({
          object: item.object,
          observationId: item.observationId,
          resolved,
          pipeline,
          normalized: item.normalized,
          now,
        });
      } catch (error: unknown) {
        log.general.warn(
          { err: error, sourceId: run.sourceId, externalId: item.object.externalId },
          '[Ingestion] the record was stored but could not be advanced; the next pass will retry it',
        );
      }
    }
  } else {
    for (const item of pending) {
      await quarantineSourceObject(db, {
        id: item.object.id,
        reason: 'anomalous_change',
        detail: verdict.findings.map((finding) => finding.kind).join(','),
        now,
      });
    }
    // The intake partition stays exact: these records were STORED as
    // observations and then HELD, and `quarantined` is the outcome that means
    // "held out of the pipeline". Moving them rather than double-counting is
    // what keeps `catalog_source_runs_intake_total_check` satisfiable.
    intake.stored -= pending.length;
    intake.quarantined += pending.length;
  }

  const owned = await recordSourceRunPage(db, {
    id: run.id,
    leaseOwner: input.leaseOwner,
    cursor: page.nextCursor,
    enumerationComplete: page.complete,
    intake,
    pipeline: { ...pipeline, offersRemoved: removed },
    fetch: {
      fetchCount: 1,
      fetchDurationMs,
      rateLimitHits: page.rateLimitHits ?? 0,
    },
    leaseUntil: new Date(now.getTime() + config.catalogIngestion.leaseMs),
    now,
  });
  if (!owned) {
    // The lease was reclaimed while this page ran. Another task is
    // authoritative for the run; discarding this page's bookkeeping is the only
    // safe reading, and the records themselves converge on the next pass.
    return emptyResult(run.id, run.sourceId, 'lease_lost');
  }

  if (page.nextCursor !== null) {
    return {
      runId: run.id,
      sourceId: run.sourceId,
      fetched: intake.fetched,
      stored: intake.stored,
      rejected: intake.rejected,
      offersUpserted: pipeline.offersUpserted,
      outcome: null,
      skipped: null,
    };
  }

  const refreshed = await findSourceRun(db, run.id);
  const totals = refreshed ?? run;
  const outcome = classifyRunOutcome({
    enumerationComplete: totals.enumerationComplete,
    failure: null,
    rejected: totals.rejected,
    quarantined: totals.quarantined,
    reviewRequired: totals.reviewRequired,
    fetched: totals.fetched,
    refreshPermitted: true,
  });

  return closeRun({
    run: totals,
    resolved,
    freshness,
    leaseOwner: input.leaseOwner,
    outcome,
    failed: false,
    error: null,
    retryAfterMs: undefined,
    now,
    pageStats: { intake, pipeline },
    closingDistribution: distribution,
    pageFindings: verdict.findings,
  });
}

/**
 * One record, PERSISTED — and no further (#68).
 *
 * #62's `ingestOneRecord` went all the way from a payload to an offer. #68
 * splits it after persistence, because "never overwrite prior current offers
 * with unvalidated anomalous records" is a promise no per-record step can make:
 * by the time the last row of a page shows the distribution to be wrong, the
 * first ninety-nine have already replaced ninety-nine live prices.
 *
 * What survives from a record that gets this far is a {@link PendingObject},
 * which the page-level gate either advances or quarantines.
 */
async function persistOneRecord(args: {
  record: AdapterRecord;
  run: CatalogSourceRunRow;
  resolved: ResolvedIngestionSource;
  freshness: ResolvedFreshnessPolicy;
  seenInPage: Set<string>;
  intake: IntakeTally;
  pending: PendingObject[];
  prices: ObservedPrice[];
  now: Date;
}): Promise<void> {
  const { record, run, resolved, freshness, seenInPage, intake, pending, prices } = args;
  const db = getDb();

  /**
   * The clock every "seen at" and "confirmed at" stamp is taken from.
   *
   * `args.now` is the DISPATCHER TICK's clock, taken before the adapter was
   * called; `record.observedAt` is when the adapter actually read the record. So
   * for any adapter that stamps its own read time — which is every real one —
   * `observedAt` is LATER than `now` by however long the fetch took, and
   * `catalog_source_objects_seen_order_check` (`last_seen_at >=
   * first_observed_at`) and `offers_confirmed_order_check` both fail on the
   * FIRST observation of every object.
   *
   * The fixture adapter never showed it because its records carry a fixed date
   * in the past. #63's importer, which stamps the instant it staged the feed, is
   * the first real adapter to reach it — and the failure is not cosmetic: the
   * record is caught, recorded as a `parse_failure` rejection and skipped, so a
   * feed would ingest NOTHING while reporting a clean run.
   *
   * Taking the max is truthful rather than defensive: Mercaria has certainly
   * seen the object at least as recently as it observed it. The retirement sweep
   * is unaffected — it compares `last_seen_at` against the RUN's `started_at`,
   * and a value never earlier than the tick still satisfies it.
   */
  const now = record.observedAt > args.now ? record.observedAt : args.now;
  const reject = async (
    reasonCode: CatalogSourceRejectionReason,
    field?: string,
    digest?: string,
  ): Promise<void> => {
    intake.rejected += 1;
    await recordSourceRejection(db, {
      runId: run.id,
      sourceId: run.sourceId,
      externalType: record.externalType,
      externalId: record.externalId.length > 0 ? record.externalId : null,
      reasonCode,
      detail: describeRejection(reasonCode, field),
      rawPayloadDigest: digest ?? null,
      now,
    });
  };

  if (record.externalId.trim().length === 0) {
    await reject('missing_external_id');
    return;
  }

  const pageKey = `${record.externalType}:${record.externalId}`;
  if (seenInPage.has(pageKey)) {
    // Two rows for one object in one page. Applying both would make the second
    // an "update" of the first within a single observation instant, which is
    // exactly the ordering the monotonicity guard cannot adjudicate.
    await reject('duplicate_in_page');
    return;
  }
  seenInPage.add(pageKey);

  const normalized = canonicalizeNormalizedRecord(record.normalized);
  if (normalized === null) {
    await reject('missing_title');
    return;
  }

  /**
   * The page's clock is the AUTHORITY, and an adapter's read cannot be in its
   * future.
   *
   * `now` is captured at the top of `runIngestionPage`; an adapter that stamps
   * the REAL read instant necessarily runs a few milliseconds later, inside the
   * fetch. Every downstream table then sees a record observed AFTER the page
   * processing it — which `catalog_source_objects_seen_order_check` and
   * `offers_confirmed_order_check` both refuse, for every record, not
   * occasionally. The fixture adapter never exposed it because it stamps a fixed
   * instant in the past; #65's eBay adapter, the first to stamp the truth,
   * failed on its first realdb run.
   *
   * Clamping HERE rather than in each repository is what keeps it one fact in
   * one place: an earlier observation is preserved exactly (which is what the
   * monotonicity guard reads), and only the physically impossible direction is
   * capped.
   */
  const observedAt = record.observedAt > now ? now : record.observedAt;

  const redacted = redactSourceObservation(normalized, record.raw);
  if (redacted === null) {
    await reject('payload_too_large');
    return;
  }

  /**
   * The deadline comes from the SOURCE's own freshness contract (#68), capped
   * by whatever its rights policy permits.
   *
   * `effectiveOfferLifetimeSeconds` is a `min` over the policy's expiry and the
   * contractual cache cap, so a provider that permits 24 hours of caching gets
   * 24 hours whatever a Mercaria operator typed. The fallback when a source has
   * somehow lost its config between the claim and now is that source's OWN
   * configured TTL — the same number #62 used, and still not a global one.
   */
  const lifetimeSeconds = effectiveOfferLifetimeSeconds(freshness.policy);
  const staleAt = new Date(now.getTime() + lifetimeSeconds * 1_000);

  /**
   * `may_store` decides whether the PAYLOAD is kept, not whether the
   * observation is.
   *
   * `source_records.payload` is nullable for exactly this (ADR 0002 D19): a
   * source Mercaria may read but not store keeps its hash and its observation
   * time with no payload. The consequence is stated rather than hidden — the
   * matcher's subject loader returns `null` for a payload-less record, so such
   * a source produces provenance and freshness and never an offer.
   */
  const observation = await recordSourceObservation(db, {
    sourceId: run.sourceId,
    externalType: record.externalType,
    externalId: record.externalId,
    observedAt,
    staleAt,
    contentHash: redacted.contentHash,
    rawPayloadDigest: redacted.rawDigest,
    normalizationVersion: NORMALIZATION_VERSION,
    ...(record.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: record.sourceUpdatedAt }),
    ...(resolved.policy === undefined ? {} : { policyVersion: resolved.policy.version }),
    ...(resolved.rights.store ? { payload: redacted.payload } : {}),
  });

  const upserted = await upsertSourceObject(db, {
    sourceId: run.sourceId,
    externalType: record.externalType,
    externalId: record.externalId,
    sourceRecordId: observation.record.id,
    contentHash: redacted.contentHash,
    observedAt,
    sourceUpdatedAt: record.sourceUpdatedAt ?? null,
    staleAt,
    price: normalized.price === undefined ? null : { ...normalized.price },
    now,
  });

  // Every price this page carried feeds the distribution gate, INCLUDING the
  // ones whose object turns out to be unchanged or quarantined: the question
  // the gate asks is "what shape is this feed publishing", and filtering the
  // sample by what Mercaria did with each row would answer a different one.
  if (normalized.price !== undefined) {
    prices.push({ amount: normalized.price.amount, currency: normalized.price.currency });
  }

  if (upserted.outcome === 'stale') {
    // Issue concurrency 3, and it is RECORDED rather than dropped: a source
    // publishing its feed out of order is a fact somebody needs to see.
    await reject('stale_observation', undefined, redacted.rawDigest);
    return;
  }

  const object = upserted.row;
  if (object === undefined) {
    await reject('parse_failure');
    return;
  }

  const previousPrice =
    object.lastPriceAmount === null || object.lastPriceCurrency === null
      ? null
      : { amount: object.lastPriceAmount, currency: object.lastPriceCurrency };
  if (
    upserted.outcome !== 'inserted' &&
    isAnomalousPriceChange(previousPrice, normalized.price, config.catalogIngestion.anomalyPriceFactor)
  ) {
    intake.quarantined += 1;
    await quarantineSourceObject(db, {
      id: object.id,
      reason: 'anomalous_change',
      detail: describeRejection('anomalous_change', 'price'),
      now,
    });
    return;
  }

  if (upserted.outcome === 'unchanged') {
    intake.unchanged += 1;
    return;
  }
  intake.stored += 1;

  // A quarantined object stays out of the pipeline until an operator releases
  // it — the same content arriving again does not answer a decision about
  // content.
  if (object.state === 'quarantined') return;

  pending.push({ object, observationId: observation.record.id, normalized });
}

/** A persisted record awaiting the page-level publication gate (#68). */
interface PendingObject {
  readonly object: CatalogSourceObjectRow;
  readonly observationId: string;
  readonly normalized: NormalizedSourceRecord;
}

/**
 * Apply what the source EXPLICITLY said is gone (#68 acceptance 2).
 *
 * The distinction this function exists to hold: a removal is a POSITIVE
 * STATEMENT and licenses retirement from ANY run, while an OMISSION licenses it
 * only from a complete enumeration (`retireUnseen`, below). Two code
 * paths rather than one with a flag, because the difference is not a parameter
 * — it is which run kinds may reach it at all.
 *
 * `retire_on_source_unavailable` decides whether the offer is RETIRED or merely
 * marked. Either way it leaves comparison immediately: `assessOfferFreshness`
 * reads `declared_unavailable_at` FIRST, so the derived level is `unavailable`
 * whatever the clock or the status says.
 */
async function applyExplicitRemovals(args: {
  run: CatalogSourceRunRow;
  freshness: ResolvedFreshnessPolicy;
  removals: readonly AdapterRemoval[];
  now: Date;
}): Promise<number> {
  const { run, freshness, removals, now } = args;
  if (removals.length === 0) return 0;
  const db = getDb();

  const objects = await findSourceObjectsByExternalIds(db, {
    sourceId: run.sourceId,
    externalIds: removals.map((removal) => removal.externalId),
  });
  const declaredAt = new Map(removals.map((removal) => [removal.externalId, removal.observedAt]));
  // The source's own policy decides; it defaults TRUE, because retaining
  // something a source says is gone breaks a contract rather than a page.
  const retire = freshness.policy.retireOnSourceUnavailable;

  let removed = 0;
  for (const object of objects) {
    if (object.state === 'retired') continue;
    if (object.offerId !== null) {
      removed += await declareOffersUnavailable(db, {
        offerIds: [object.offerId],
        declaredAt: declaredAt.get(object.externalId) ?? now,
        retire,
        now,
      });
    }
    if (retire) await retireSourceObject(db, { id: object.id, kind: 'explicit_removal', now });
  }
  return removed;
}

/**
 * Match, link and materialize — the stages after persistence.
 *
 * Split out because it is also what an operator's "re-run this object" does,
 * and a second implementation of the same four steps is how the manual path and
 * the automatic one drift.
 */
async function advanceObject(args: {
  object: CatalogSourceObjectRow;
  observationId: string;
  resolved: ResolvedIngestionSource;
  pipeline: PipelineTally;
  normalized: NormalizedSourceRecord;
  now: Date;
}): Promise<void> {
  const { object, observationId, resolved, pipeline, normalized, now } = args;
  const db = getDb();

  const result = await runMatch({ kind: 'source_record', sourceRecordId: observationId }, { now });
  const decision = result.decision;
  if (decision === null) {
    // No active matching policy, or the observation carries no stored payload.
    // Both are configuration states rather than failures, and the object stays
    // `observed` so the next pass re-examines it.
    pipeline.unmatched += 1;
    return;
  }

  if (decision.outcome !== 'automatic_match' || decision.matchedCanonicalVariantId === null) {
    /**
     * ISSUE WRITE BOUNDARY 3 and ACCEPTANCE 5.
     *
     * Nothing is linked and no offer is written. `manual_review` goes to #59's
     * queue by way of the decision this object now cites; a `create_new`
     * recommendation is left `unmatched`, because minting a canonical product
     * is #60's and a matcher recommending one is not the same as anybody having
     * decided to.
     */
    const state = decision.outcome === 'manual_review' ? 'review_required' : 'unmatched';
    if (state === 'review_required') pipeline.reviewRequired += 1;
    else pipeline.unmatched += 1;
    await setSourceObjectState(db, {
      id: object.id,
      state,
      matchDecisionId: decision.id,
    });
    return;
  }

  pipeline.matched += 1;
  const method = sourceLinkMethodForStage(decision.decidedStage);
  const matchRule = `${decision.decidedStage}:${decision.policyVersionId}`;

  /**
   * The canonical ATTACHMENT of a source observation — #58's other open seam,
   * closed here.
   *
   * `match.service` deliberately writes only the NATIVE attachment and leaves
   * this one to "the ingestion path that owns the observation", which is this
   * file. Both links are `ON CONFLICT DO NOTHING` on their active partial
   * unique, so a re-run of an unchanged object writes nothing at all.
   */
  await db.transaction(async (tx) => {
    if (decision.matchedCanonicalProductId !== null) {
      await insertCanonicalProductSourceLink(tx, {
        productId: decision.matchedCanonicalProductId,
        sourceRecordId: observationId,
        method,
        matchRule,
        ...(method === 'heuristic' && decision.confidence !== null
          ? { confidence: decision.confidence }
          : {}),
      });
    }
    if (decision.matchedCanonicalVariantId !== null) {
      await insertCanonicalVariantSourceLink(tx, {
        variantId: decision.matchedCanonicalVariantId,
        sourceRecordId: observationId,
        method,
        matchRule,
        ...(method === 'heuristic' && decision.confidence !== null
          ? { confidence: decision.confidence }
          : {}),
      });
    }
    await setSourceObjectState(tx, {
      id: object.id,
      state: 'matched',
      matchDecisionId: decision.id,
    });
  });

  /**
   * ISSUE WRITE BOUNDARY 2 — the merchant comes from the source's BINDING.
   *
   * A source with no merchant bound produces no offers, and that is a state an
   * operator can see and fix rather than a merchant nobody authorised. The
   * object stays `matched`, which is honest: the canonical attachment happened
   * and the commercial half did not.
   *
   * `resolveOfferMerchantId` answers exactly that binding for every source that
   * existed before #65. A source an operator marked `per_record` — a
   * MARKETPLACE, whose every item is sold by a different account — resolves the
   * seller from the record's own `merchantHint` instead, into a namespace no
   * claimed merchant can occupy. `services/ingestion/seller-identity.ts` states
   * why that does not weaken the boundary, and it answers `null` for the same
   * reason this branch always did: there is nobody to attribute the sale to.
   */
  const merchantId = await resolveOfferMerchantId({
    resolved,
    merchantHint: normalized.merchantHint,
    sourceRecordId: observationId,
    now,
  });
  if (merchantId === null) return;

  const offerId = await materializeOffer({
    object,
    observationId,
    resolved,
    merchantId,
    canonicalVariantId: decision.matchedCanonicalVariantId,
    confidence: method === 'heuristic' ? decision.confidence : null,
    normalized,
    now,
  });
  pipeline.offersUpserted += 1;
  await setSourceObjectState(db, {
    id: object.id,
    state: 'offer_current',
    matchDecisionId: decision.id,
    offerId,
  });
}

/**
 * Write the offer, with the rights deciding what it may carry.
 *
 * `recordExternalOffer` (#57) is the only writer of an `offers` row reached
 * from here, and it takes a `canonicalVariantId` it is GIVEN — this domain
 * resolves nothing about identity. Three rights shape the row rather than being
 * checked after it:
 *
 *  - `display_price` absent ⇒ NO price is persisted onto the offer. The
 *    observation keeps it under the `store` right; the offer is the display
 *    surface, and storing a price nothing may ever show is the thing a rights
 *    withdrawal exists to prevent.
 *  - `outbound_link` absent ⇒ the kind is `informational` and there is no
 *    destination for `offers_kind_shape_check` to refuse.
 *  - `affiliate_params` absent ⇒ no affiliate routing metadata at all, so #37
 *    has nothing to compose a tracked URL from and degrades to the plain link.
 */
async function materializeOffer(args: {
  object: CatalogSourceObjectRow;
  observationId: string;
  resolved: ResolvedIngestionSource;
  merchantId: string;
  canonicalVariantId: string;
  confidence: number | null;
  normalized: NormalizedSourceRecord;
  now: Date;
}): Promise<string> {
  const { object, observationId, resolved, merchantId, canonicalVariantId, normalized, now } = args;
  const rights = resolved.rights;
  const conditionProvider = conditionMappingProviderFor(resolved.source.config.provider);
  const destinationUrl = rights.outbound_link ? normalized.sourceUrl : undefined;
  const kind = offerKindFor(rights, resolved.source.sourceKind, destinationUrl);
  const affiliateUrl = rights.affiliate_params ? normalized.affiliateUrl : undefined;

  return recordExternalOffer(
    {
      kind,
      canonicalVariantId,
      merchantId,
      ...(resolved.source.config.storefrontId === null
        ? {}
        : { storefrontId: resolved.source.config.storefrontId }),
      sourceRecordId: observationId,
      provider: resolved.source.config.provider,
      ...(resolved.source.config.sourceAccountRef === null
        ? {}
        : { sourceAccountRef: resolved.source.config.sourceAccountRef }),
      externalOfferId: object.externalId,
      ...(rights.display_price && normalized.price !== undefined
        ? { price: { ...normalized.price } }
        : {}),
      ...(rights.display_price && normalized.compareAtPrice !== undefined
        ? { compareAtPrice: { ...normalized.compareAtPrice } }
        : {}),
      ...(normalized.availability === undefined ? {} : { availability: normalized.availability }),
      ...(normalized.availableQuantity === undefined
        ? {}
        : { availableQuantity: normalized.availableQuantity }),
      ...(normalized.conditionLabel === undefined
        ? {}
        : { conditionSourceLabel: normalized.conditionLabel }),
      /**
       * #90's ruleset reads the label; nothing here decides a taxonomy key.
       *
       * A source whose provider owns no ruleset vocabulary passes NOTHING, and
       * `recordExternalOffer` then stores the wording with the condition
       * `unknown` — the fail-closed direction, and the one that makes the first
       * ruleset for a new source writable from what it actually says rather
       * than from a guess about what it might.
       */
      ...(conditionProvider === undefined ? {} : { conditionMappingProvider: conditionProvider }),
      ...(normalized.merchantSku === undefined ? {} : { sellerSku: normalized.merchantSku }),
      merchantTitle: normalized.title,
      ...(destinationUrl === undefined ? {} : { destinationUrl }),
      ...(affiliateUrl === undefined
        ? {}
        : {
            affiliate: {
              network: resolved.source.config.provider,
              // The composed URL is deliberately NOT stored as the destination
              // (#57's rule): `destination_url` stays the ORIGINAL and #37
              // builds the tracked address at redirect time, so a routing
              // failure degrades to the plain link instead of a dead one.
              trackingTemplate: affiliateUrl,
            },
          }),
      ...(normalized.country === undefined ? {} : { country: normalized.country }),
      ...(normalized.region === undefined ? {} : { region: normalized.region }),
      ...(normalized.language === undefined ? {} : { language: normalized.language }),
      ...(normalized.delivery === undefined
        ? {}
        : {
            delivery: {
              ...(normalized.delivery.cost === undefined
                ? {}
                : { cost: { ...normalized.delivery.cost } }),
              ...(normalized.delivery.freeOver === undefined
                ? {}
                : { freeOver: { ...normalized.delivery.freeOver } }),
              ...(normalized.delivery.minDays === undefined
                ? {}
                : { minDays: normalized.delivery.minDays }),
              ...(normalized.delivery.maxDays === undefined
                ? {}
                : { maxDays: normalized.delivery.maxDays }),
            },
          }),
      ...(normalized.returnPolicy === undefined ? {} : { returnPolicy: { ...normalized.returnPolicy } }),
      observedAt: object.currentObservedAt,
      staleAt: object.staleAt,
      ...(args.confidence === null ? {} : { confidence: args.confidence }),
    },
    now,
  );
}

/** Close a run: classify, finish, then retire — in that order. See the module docblock. */
async function closeRun(args: {
  run: CatalogSourceRunRow;
  resolved: ResolvedIngestionSource;
  freshness: ResolvedFreshnessPolicy;
  leaseOwner: string;
  outcome: CatalogSourceHealthState;
  failed: boolean;
  error: string | null;
  retryAfterMs: number | undefined;
  now: Date;
  pageStats?: { intake: IntakeTally; pipeline: PipelineTally };
  /** The closing page's distribution — the baseline candidate. See below. */
  closingDistribution?: SourceObservationDistribution;
  /** What the closing page's gate found, so a clean run can CORRECT them. */
  pageFindings?: readonly SourceAnomalyFinding[];
}): Promise<IngestPageResult> {
  const db = getDb();
  const owned = await finishSourceRun(db, {
    id: args.run.id,
    leaseOwner: args.leaseOwner,
    outcome: args.outcome,
    failed: args.failed,
    error: args.error,
    now: args.now,
  });
  if (!owned) return emptyResult(args.run.id, args.run.sourceId, 'lease_lost');

  /**
   * MASS DISAPPEARANCE gates RETIREMENT, and is measured only here (#68 anomaly
   * 1 and 5).
   *
   * It is the one finding a page cannot make: "how much of the catalogue did
   * this pass fail to mention" is only answerable once the pass is over, and
   * only a COMPLETE enumeration makes silence mean anything at all. So the
   * detector runs inside the `mayRetireUnseen` branch — which is also where its
   * consequence lives, because a feed that dropped nine tenths of its rows must
   * not have those rows retired on its say-so.
   */
  const thresholds = args.freshness.anomalyThresholds;
  let retired = 0;
  let disappearanceFindings: readonly SourceAnomalyFinding[] = [];
  // Counted ONCE and reused by both the detector and the baseline: two reads
  // could legitimately disagree, since a retirement between them changes the
  // answer — and the denominator the share was taken over is exactly what the
  // baseline should record.
  let knownObjects = 0;
  let knownObjectsCounted = false;
  if (mayRetireUnseen({ enumerationComplete: args.run.enumerationComplete, outcome: args.outcome })) {
    const seenSince = args.run.startedAt ?? args.now;
    const unseen = await listUnseenSourceObjects(db, {
      sourceId: args.run.sourceId,
      seenSince,
      limit: config.catalogIngestion.retirementBatchSize,
    });
    knownObjects = await countActiveSourceObjects(db, args.run.sourceId);
    knownObjectsCounted = true;

    const verdict = await judgePagePublication(db, {
      runId: args.run.id,
      sourceId: args.run.sourceId,
      distribution: args.closingDistribution ?? EMPTY_DISTRIBUTION,
      thresholds,
      unseenPriorObjects: unseen.length,
      priorObjectCountOverride: knownObjects,
      heldObjects: unseen.length,
      now: args.now,
    });
    disappearanceFindings = verdict.findings;

    if (verdict.mayPublish) {
      retired = await retireUnseen(unseen, args.now);
      await recordSourceRunRetirement(db, { id: args.run.id, retired });
    }
  }

  /**
   * Adopt this run's distribution as the source's new baseline, and CORRECT the
   * findings it no longer trips (#68 anomaly 4).
   *
   * The baseline is the CLOSING page's distribution rather than the whole run's,
   * and that approximation is stated rather than hidden: a running median needs
   * every price of a million-row feed in memory or a t-digest, and neither is
   * worth building for a comparison whose job is to notice a change of SHAPE.
   * A page is a representative sample of a paginated feed, and the detector's
   * own minimum-sample floor is what keeps a short final page from becoming the
   * baseline.
   */
  const closing = args.closingDistribution ?? EMPTY_DISTRIBUTION;
  await settleRunQuarantines(db, {
    runId: args.run.id,
    sourceId: args.run.sourceId,
    distribution: closing,
    objectCount:
      knownObjectsCounted || closing.sampleSize === 0
        ? knownObjects
        : await countActiveSourceObjects(db, args.run.sourceId),
    findings: [...(args.pageFindings ?? []), ...disappearanceFindings],
    now: args.now,
  });

  const delayMs = nextRunDelayMs({
    cadenceSeconds: args.resolved.source.config.fetchCadenceSeconds,
    consecutiveFailures: isDegraded(args.outcome)
      ? args.resolved.source.config.consecutiveFailures + 1
      : 0,
    retryAfterMs: args.retryAfterMs,
    maxBackoffMs: config.catalogIngestion.maxBackoffMs,
  });

  await recordSourceHealth(db, {
    sourceId: args.run.sourceId,
    healthState: args.outcome,
    status: statusAfterRun(args.resolved.source.config.status, args.outcome),
    succeeded: !isDegraded(args.outcome),
    fetchDurationMs: args.run.fetchDurationMs,
    rateLimitHits: args.run.rateLimitHits,
    error: args.error,
    nextRunAt: new Date(args.now.getTime() + delayMs),
    now: args.now,
  });

  return {
    runId: args.run.id,
    sourceId: args.run.sourceId,
    fetched: args.pageStats?.intake.fetched ?? 0,
    stored: args.pageStats?.intake.stored ?? 0,
    rejected: args.pageStats?.intake.rejected ?? 0,
    offersUpserted: args.pageStats?.pipeline.offersUpserted ?? 0,
    outcome: args.outcome,
    skipped: null,
  };
}

/**
 * Retire what a COMPLETE enumeration did not mention.
 *
 * Reached only through `mayRetireUnseen`, and it deliberately has no opinion of
 * its own about whether retiring is allowed — asking it to would put the rule
 * in two places, and the whole failure this domain guards against is the two
 * places disagreeing.
 *
 * The offer is RETIRED and never deleted (#57): the row, its `source_record_id`
 * and the append-only observation chain behind it all survive, which is what
 * keeps the observed price history reachable afterwards.
 */
export async function retireUnseen(
  objects: readonly CatalogSourceObjectRow[],
  now: Date,
): Promise<number> {
  const db = getDb();
  let retired = 0;
  for (const object of objects) {
    if (object.offerId !== null) {
      await retireOffers(db, [object.offerId], 'source_disappeared', now);
    }
    // `snapshot_omission` and never `explicit_removal`: this branch is reached
    // only from a COMPLETE enumeration's silence, and recording it as a
    // statement the source made would put a claim in the trace nobody made.
    if (await retireSourceObject(db, { id: object.id, kind: 'snapshot_omission', now })) {
      retired += 1;
    }
  }
  return retired;
}

function emptyResult(
  runId: string,
  sourceId: string,
  skipped: IngestPageResult['skipped'],
): IngestPageResult {
  return {
    runId,
    sourceId,
    fetched: 0,
    stored: 0,
    rejected: 0,
    offersUpserted: 0,
    outcome: null,
    skipped,
  };
}
