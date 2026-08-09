/**
 * Instrumenting one search (#77 discovery events 1–3, search privacy, metrics
 * 1–4 and 14).
 *
 * ## One call, four records, one correlation handle
 *
 * A served search produces `search_submitted`, `search_results_returned` (or
 * `search_zero_results`), and one `analytics_search_queries` row — all sharing
 * a `queryEventId` minted here. That handle is the ONLY thing joining a later
 * click, add-to-cart or outbound click back to the search that produced it,
 * which is what makes search success computable WITHOUT an identity join. The
 * metric definition's attribution limit says the consequence out loud: it
 * follows the search, not the shopper.
 *
 * The handle is returned to the caller so it can travel to the client in the
 * response and come back on the impression and click events. It is a random
 * uuid and authorizes nothing — it names a row in a telemetry table, and the
 * worst a client that forged one achieves is attaching its own clicks to its own
 * fabricated search.
 *
 * ## The query text is redacted BEFORE it leaves this function
 *
 * `redactSearchQuery` runs on the raw term and nothing downstream ever sees the
 * original: it is not logged, not passed to the sink, and not held in a
 * closure. That is the mechanical form of "raw query text is never retained".
 */

import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { ANALYTICS_QUERY_TEXT_RETENTION_DAYS } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { recordSearchQuery } from './sink.js';
import { emitAnalyticsEvent } from './emit.js';
import { redactSearchQuery } from './redact-query.js';
import { readAnalyticsRequestContext } from './request-context.js';

/** How long an `analytics_search_queries` row survives after its text is nulled. */
const QUERY_ROW_RETENTION_DAYS = 180;

/** What a caller knows about the search it just served. */
export interface SearchInstrumentationInput {
  /** The raw term. Redacted here and never stored, logged or returned. */
  readonly term?: string;
  /** How many rows came back. Zero IS the zero-result fact. */
  readonly resultCount: number;
  /** Server-side duration in milliseconds. */
  readonly latencyMs: number;
  /** The category filter in force, when there was one. */
  readonly categoryId?: string;
  /**
   * The canonical product id of each result row, in order, where one is known.
   *
   * The duplicate-product-rate numerator is the count of rows whose id repeats
   * an earlier row on the SAME page — a property of the page that was served
   * and not re-derivable later, which is why it is computed here.
   *
   * The native listing search passes none of these today, and since #58 landed
   * that is a COST decision rather than a missing capability — the distinction
   * matters, because the two have different fixes and only one of them is
   * anybody's to make here.
   *
   * A listing now has TWO routes to a canonical product, and they are not the
   * same set: a variant barcode through `product_identifiers` (what #76's
   * `findCanonicalProductIdForListing` walks, on the product-detail page), and
   * `native_listing_links`, which #58's matcher writes for listings it attached
   * on evidence other than a barcode. Neither is batched — the existing
   * resolver is one query per VARIANT — so resolving a twenty-row page would
   * cost tens of queries on the hottest read path in the API, inside the very
   * latency this module measures. Doing it asynchronously in the sink is the
   * shape that would work, and it needs a batched resolver plus a precedence
   * rule for when the two routes disagree; both belong with the rollup writers
   * that own this metric, not with its instrumentation.
   *
   * So the count stays 0 here and the metric's `attributionLimit` says the
   * number is UNMEASURED on that surface rather than a lower bound — which is
   * the difference between an honest gap and a chart reading "no duplicates".
   * A title-similarity guess would fill the column with a number nobody could
   * defend, which is worse than either.
   */
  readonly canonicalProductIds?: readonly (string | undefined)[];
  /** The #74 search policy version, once one exists. */
  readonly searchPolicyVersion?: string;
  /** The #74 ranking policy version, once one exists. */
  readonly rankingPolicyVersion?: string;
}

/**
 * Record a served search.
 *
 * @returns The `queryEventId` a client should echo on the impressions and
 *   clicks that follow, or `undefined` when collection is off — in which case
 *   the caller has nothing to send and no branch to write, because the response
 *   field is simply absent.
 *
 * Never throws and never awaits a write: everything goes through the sink.
 */
export function instrumentSearch(
  req: Request,
  input: SearchInstrumentationInput,
): string | undefined {
  if (!config.analytics.enabled) return undefined;

  const queryEventId = randomUUID();
  const now = new Date();
  const context = readAnalyticsRequestContext(req);
  const redacted = redactSearchQuery(input.term ?? '');

  const entities = {
    queryEventId,
    ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
  };
  const policyVersions = {
    ...(input.searchPolicyVersion === undefined
      ? {}
      : { searchPolicyVersion: input.searchPolicyVersion }),
    ...(input.rankingPolicyVersion === undefined
      ? {}
      : { rankingPolicyVersion: input.rankingPolicyVersion }),
  };

  emitAnalyticsEvent(req, { eventType: 'search_submitted', entities, ...policyVersions });
  emitAnalyticsEvent(req, {
    // Two events rather than a flag, because they are two different
    // denominators: `zero_result_rate` divides by submissions and
    // `search_success_rate` divides by RESULTS RETURNED. A single event with a
    // `resultCount` would make one of those a filter somebody has to remember.
    eventType: input.resultCount === 0 ? 'search_zero_results' : 'search_results_returned',
    entities,
    measures: { resultCount: input.resultCount, latencyMs: input.latencyMs },
    ...policyVersions,
  });

  recordSearchQuery({
    queryEventId,
    redactedText: redacted.redactedText,
    redactionKinds: redacted.redactionKinds,
    normalizedTokens: redacted.normalizedTokens,
    resultCount: input.resultCount,
    duplicateResultCount: countDuplicates(input.canonicalProductIds),
    latencyMs: input.latencyMs,
    market: context.market ?? null,
    categoryId: input.categoryId ?? null,
    searchPolicyVersion: input.searchPolicyVersion ?? null,
    rankingPolicyVersion: input.rankingPolicyVersion ?? null,
    trafficClass: context.trafficClass,
    textExpiresAt: new Date(now.getTime() + ANALYTICS_QUERY_TEXT_RETENTION_DAYS * 86_400_000),
    expiresAt: new Date(now.getTime() + QUERY_ROW_RETENTION_DAYS * 86_400_000),
  });

  return queryEventId;
}

/**
 * How many rows repeat a canonical product already seen on this page.
 *
 * `undefined` entries are rows with no canonical link and are skipped rather
 * than collapsed into one bucket — treating "unknown" as a single value would
 * report an unmatched page as almost entirely duplicated, which is the opposite
 * of the truth.
 */
function countDuplicates(ids: readonly (string | undefined)[] | undefined): number {
  if (ids === undefined) return 0;
  const seen = new Set<string>();
  let duplicates = 0;
  for (const id of ids) {
    if (id === undefined) continue;
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
  }
  return duplicates;
}
