/**
 * Canonical search controller (THIN) — `GET /search` (#70).
 *
 * ## Why this handler owns its rollout gate instead of `requireCanonicalReads`
 *
 * Every other canonical surface is gated by that middleware, which answers 404
 * for `off` and for `shadow` alike. This one cannot use it: `shadow` here means
 * COMPUTE BOTH ANSWERS AND COMPARE THEM (ADR 0002 D24 phase 3), and a
 * middleware that returns before the handler runs can never compute anything.
 * The visible behaviour is identical — `off` and `shadow` are both a 404, and no
 * shopper sees a canonical result until the lever is `on` — so the divergence
 * is in what happens BEHIND the 404, which is the entire point of a shadow mode.
 *
 * The rollback #70 acceptance 8 asks for is therefore one environment variable,
 * and it costs nothing: `GET /listings?q=` is the listing-first search, is
 * untouched by this issue, and keeps serving exactly as it does today whatever
 * this lever says.
 *
 * ## Analytics
 *
 * ONE call to `instrumentSearch` (#77), which mints the `queryEventId` a client
 * echoes on the impressions and clicks that follow, redacts the term before
 * anything is stored, and emits `search_submitted` plus either
 * `search_results_returned` or `search_zero_results`. It returns `void`-ish by
 * design — the id, or `undefined` when collection is off — and is never
 * awaited for a write, so a slow sink cannot join a search's latency.
 *
 * This surface is on `analytics-ranking-isolation.test.ts`'s scanned list: the
 * emitter is the ONLY analytics module a discovery path may import, so measured
 * popularity cannot become a ranking input by way of a controller reading a
 * rollup.
 */

import type { Request, Response } from 'express';
import type {
  ConditionGroup,
  OfferAvailability,
  OfferKind,
  SearchFilters,
  SearchResultKind,
} from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { runCanonicalSearch } from '../services/search/canonical-search.service.js';
import { recordShadowComparison } from '../services/search/shadow.js';
import { searchListingsOffset } from '../services/search.service.js';
import { instrumentSearch } from '../services/analytics/search-instrumentation.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/** The validated query, as `searchQuerySchema` leaves it. */
interface SearchQueryInput {
  q: string;
  kinds?: SearchResultKind[];
  categories?: string[];
  brandIds?: string[];
  market?: string;
  priceCurrency?: string;
  priceMin?: number;
  priceMax?: number;
  conditionGroups?: ConditionGroup[];
  availability?: OfferAvailability[];
  offerKinds?: OfferKind[];
  officialChannelOnly?: 'true' | 'false';
  merchantIds?: string[];
  attributes?: { key: string; value?: string; minNumber?: number; maxNumber?: number }[];
  nearLatitude?: number;
  nearLongitude?: number;
  nearRadiusMetres?: number;
  limit?: number;
  cursor?: string;
}

/** Translate the wire query into the service's filter shape. */
export function toSearchFilters(query: SearchQueryInput): SearchFilters {
  return {
    ...(query.categories === undefined ? {} : { categorySlugs: query.categories }),
    ...(query.brandIds === undefined ? {} : { brandIds: query.brandIds }),
    ...(query.market === undefined ? {} : { market: query.market.toUpperCase() }),
    ...(query.priceCurrency === undefined
      ? {}
      : {
          price: {
            currency: query.priceCurrency.toUpperCase(),
            ...(query.priceMin === undefined ? {} : { minMinor: query.priceMin }),
            ...(query.priceMax === undefined ? {} : { maxMinor: query.priceMax }),
          },
        }),
    ...(query.conditionGroups === undefined ? {} : { conditionGroups: query.conditionGroups }),
    ...(query.availability === undefined ? {} : { availability: query.availability }),
    ...(query.offerKinds === undefined ? {} : { offerKinds: query.offerKinds }),
    ...(query.officialChannelOnly === 'true' ? { officialChannelOnly: true } : {}),
    ...(query.merchantIds === undefined ? {} : { merchantIds: query.merchantIds }),
    ...(query.attributes === undefined ? {} : { attributes: query.attributes }),
    // Both halves or neither — the schema refuses a lone latitude, so this
    // guard is a type narrowing rather than a second validation.
    ...(query.nearLatitude === undefined || query.nearLongitude === undefined
      ? {}
      : {
          nearby: {
            latitude: query.nearLatitude,
            longitude: query.nearLongitude,
            ...(query.nearRadiusMetres === undefined
              ? {}
              : { radiusMetres: query.nearRadiusMetres }),
          },
        }),
  };
}

/**
 * `GET /search` — canonical multi-entity discovery.
 *
 * A 404 while the lever is not `on`, never a 403: a shopper hitting a surface
 * this deployment has not rolled out is looking at a page that does not exist
 * here, and a 403 would advertise one they cannot reach. The
 * `requireCanonicalReads` reasoning, applied by hand for the reason the module
 * docblock gives.
 */
export async function canonicalSearchHandler(req: Request, res: Response): Promise<void> {
  const mode = config.canonicalRollout.search;
  const query = req.query as unknown as SearchQueryInput;

  try {
    if (mode === 'off') {
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    const filters = toSearchFilters(query);
    const started = Date.now();
    const outcome = await runCanonicalSearch({
      term: query.q,
      kinds: query.kinds ?? [],
      filters,
      limit: query.limit ?? 20,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const latencyMs = Date.now() - started;

    if (mode === 'shadow') {
      // ADR 0002 D24 phase 3: compute BOTH, serve the legacy one — which here
      // means serve nothing, because `GET /search` has no legacy behaviour to
      // fall back to and `GET /listings` is where the legacy answer already
      // lives. The comparison is recorded and the shopper sees the 404 they
      // would have seen with the lever off.
      const legacy = await searchListingsOffset({ q: query.q }, 1, 20);
      recordShadowComparison(outcome.response.results.length, legacy.total);
      sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
      return;
    }

    // #77's instrumentation. The CATEGORY filter is passed only when the
    // request named exactly one, matching `analytics_search_queries.category_id`
    // — a single column that cannot express a set, and reporting one of several
    // would attribute a query to a category the shopper did not narrow to.
    const queryEventId = instrumentSearch(req, {
      term: query.q,
      resultCount: outcome.response.results.length,
      latencyMs,
      ...(query.categories !== undefined && query.categories.length === 1
        ? { categoryId: query.categories[0] }
        : {}),
      canonicalProductIds: outcome.canonicalProductIds,
      searchPolicyVersion: outcome.response.policyVersion,
    });

    sendSuccess(res, {
      ...outcome.response,
      ...(queryEventId === undefined ? {} : { queryEventId }),
    });
  } catch (error) {
    respondWithError(res, error, '[search] canonical search failed');
  }
}
