/**
 * The search domain's operator surface (#70) — read plus ONE trigger.
 *
 * Two handlers, and the set is closed. There is deliberately no "boost this
 * product", no "pin this result", no "suppress this entity from search" and no
 * "set the relevance weights": every one of them would be a ranking control
 * living outside the versioned policy, which is exactly what
 * `SEARCH_RELEVANCE_POLICY_VERSION` being a code constant exists to prevent.
 * An operator who needs a different ordering ships a policy version.
 *
 * ## Both are readable while the public lever is OFF
 *
 * The `/internal/backfill` rule, for the same reason: the evidence has to be
 * readable during the incident that turned the surface off. A rollout decision
 * is made from the shadow counters, and a shadow run's whole purpose is to be
 * inspected while shoppers see nothing.
 */

import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { runCanonicalSearch } from '../services/search/canonical-search.service.js';
import { readShadowComparisons } from '../services/search/shadow.js';
import { toSearchFilters } from './search.controller.js';
import { sendSuccess } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';

/**
 * `GET /internal/search/shadow` — the rollout evidence.
 *
 * PROCESS-LOCAL counters (`services/search/shadow.ts` explains why), so a
 * fleet's answer is the sum across tasks and `oxy-infra` owns the scraping.
 * The lever is reported beside them, because "canonical_only was zero" means
 * two completely different things depending on whether the shadow mode was even
 * running.
 */
export function searchShadowMetricsHandler(_req: Request, res: Response): void {
  sendSuccess(res, {
    mode: config.canonicalRollout.search,
    comparisons: readShadowComparisons(),
  });
}

/**
 * `POST /internal/search/explain` — what one query returns RIGHT NOW.
 *
 * The trace is the response itself: `applied` carries the normalization, the
 * tokens and how the query was read as an identifier, and every result carries
 * the STAGES that found it and the score it was ordered on. That is the whole
 * of what the pipeline decided, published in the same shape a shopper would
 * receive — an operator diagnosing "why is this product not showing" is looking
 * at exactly the object the public surface would have produced, rather than at
 * a second rendering of it that could disagree.
 *
 * It emits NO analytics event. An operator's diagnostic query is not a search
 * somebody performed, and counting it would put staff traffic into
 * `zero_result_rate` — the metric a rollout is judged on.
 */
export async function searchExplainHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Parameters<typeof toSearchFilters>[0];
    const outcome = await runCanonicalSearch({
      term: body.q,
      kinds: body.kinds ?? [],
      filters: toSearchFilters(body),
      limit: body.limit ?? 20,
      ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
    });
    sendSuccess(res, { mode: config.canonicalRollout.search, ...outcome.response });
  } catch (error) {
    respondWithError(res, error, '[search] explain failed');
  }
}
