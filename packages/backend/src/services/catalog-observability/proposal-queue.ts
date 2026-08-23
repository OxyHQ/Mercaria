/**
 * The proposal review queue's depth, aging and SLA visibility (#367 W6 —
 * "add proposal queue metrics and aging/SLA visibility").
 *
 * ## ONE derivation, two consumers
 *
 * `metrics.service.ts`'s six proposal producers and
 * `GET /internal/catalog-metrics/proposal-queue` both come out of
 * `tallyProposals` — the same statement, the same snapshot, the same clock. Two
 * spellings of "how deep is the backlog" is the shape that lets a dashboard tile
 * and the page behind it disagree with nothing saying which is right; #70
 * extracted `summariseProjectedOffers` for exactly this and the reasoning is
 * unchanged.
 *
 * So this module derives and never reads: it takes a `ProposalTally` and turns it
 * into the published DTO. Everything it adds is arithmetic over numbers the one
 * statement already produced.
 *
 * ## Why it lives in `catalog-observability/` and not in `catalog-proposals/`
 *
 * The dependency already points this way — `queries.ts` reads
 * `catalog_proposals` and nothing in the proposal domain reads this one. Putting
 * the queue read in the proposal domain would have the operator surface for
 * proposals import an observability collector, and the metrics collector import
 * the proposal domain, which is a cycle at the domain level for no gain.
 *
 * ## What a caller gets that a bare count does not
 *
 * - **Depth for every state**, empty ones included, each with its own oldest age.
 *   `CatalogMetricBucket` cannot carry a per-bucket AGE (it is a numerator and a
 *   denominator), which is why the distribution is a DTO of its own rather than a
 *   `by` breakdown on one of the registry metrics.
 * - **`countsAgree`**, which is the only thing in this domain that can notice a
 *   row carrying a state this build does not know about.
 * - **`unbandedOpenCount`**, which is the only thing that can notice a row whose
 *   `created_at` is in the future.
 * - **Percentiles, or an explicit refusal.** Below
 *   `CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION` the p95 is arithmetically the
 *   maximum, so it is withheld rather than published under a name that implies
 *   more than it holds.
 * - **The SLA answer**, which is that there is no target.
 */

import {
  CATALOG_PROPOSAL_AGE_BANDS,
  CATALOG_PROPOSAL_OPEN_STATES,
  CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION,
  type CatalogProposalQueueAging,
  type CatalogProposalState,
  type CatalogProposalStateDepth,
  type CatalogProposalWaitAge,
  describeCatalogProposalSla,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { tallyProposals, type ProposalTally } from './queries.js';

/**
 * The window `readProposalQueueAging` passes through to `tallyProposals`.
 *
 * Seven days, matching `proposal_creation_count` and `proposal_decision_count`.
 * The queue DTO publishes no windowed figure of its own — every field on it is a
 * gauge — so this only decides which of the tally's columns go unused, and it is
 * stated rather than passed as a magic number.
 */
const QUEUE_TALLY_WINDOW_SECONDS = 7 * 24 * 3_600;

/**
 * The waiting-age percentiles, or the refusal to state them.
 *
 * The refusal branch carries the population and the floor and NO percentile
 * property, so a caller cannot render one — the shape does the enforcing, not the
 * reason string. It also carries the population on the way out, because "the
 * queue is empty" and "the queue is too small to summarise" lead an operator to
 * opposite conclusions and both land here.
 *
 * A percentile that came back NULL over a population above the floor would mean
 * the statement's `filter` and this function's population disagree — the same
 * predicate in the same statement, so it cannot happen. It is answered with its
 * OWN reason rather than folded into the floor's, because reporting a defect as
 * a small sample sends whoever reads it to wait for the queue to grow. Either
 * way the worst case is a withheld figure rather than an invented one.
 */
function deriveWaitAge(tally: ProposalTally): CatalogProposalWaitAge {
  const population = tally.openNow;
  const { p50Seconds, p90Seconds, p95Seconds, maxSeconds } = tally.openAgePercentiles;
  if (population < CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION) {
    return {
      state: 'unmeasured',
      population,
      reason: 'population_below_floor',
      floor: CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION,
    };
  }
  if (p50Seconds === null || p90Seconds === null || p95Seconds === null || maxSeconds === null) {
    return {
      state: 'unmeasured',
      population,
      reason: 'percentiles_unavailable',
      floor: CATALOG_PROPOSAL_WAIT_AGE_MIN_POPULATION,
    };
  }
  return {
    state: 'measured',
    population,
    p50Seconds,
    p90Seconds,
    p95Seconds,
    maxSeconds,
  };
}

/** Turn one tally into the published queue reading. Pure. */
export function deriveProposalQueueAging(
  tally: ProposalTally,
  measuredAt: Date = new Date(),
): CatalogProposalQueueAging {
  const openStates = new Set<string>(CATALOG_PROPOSAL_OPEN_STATES);

  const depthByState: CatalogProposalStateDepth[] = tally.byState.map((entry) => ({
    state: entry.state as CatalogProposalState,
    count: entry.count,
    open: openStates.has(entry.state),
    oldestAgeSeconds: entry.oldestAgeSeconds,
  }));

  // The per-state sum against the independently counted total. These agree
  // unless a row carries a state outside this build's tuple — see the DTO's
  // docblock for why that is reachable rather than theoretical.
  const summedByState = depthByState.reduce((total, entry) => total + entry.count, 0);

  const bandsByKey = new Map(tally.openByAgeBand.map((band) => [band.key, band.count]));
  const agingBands = CATALOG_PROPOSAL_AGE_BANDS.map((band) => ({
    key: band.key,
    fromSeconds: band.fromSeconds,
    toSeconds: band.toSeconds,
    count: bandsByKey.get(band.key) ?? 0,
  }));

  // By SUBTRACTION, never from the tally's own `age < 0` filter, and the
  // difference is the point: the subtraction is what "fell in no band" means, so
  // it catches a GAP opened between two bands as well as the negative age. The
  // two are separately computed and must agree while the bands stay contiguous,
  // which is what `proposal-queue.realdb.test.ts` cross-checks against a row
  // deliberately dated in the future.
  const bandedOpen = agingBands.reduce((total, band) => total + band.count, 0);

  return {
    measuredAt: measuredAt.toISOString(),
    depthByState,
    openDepth: tally.openNow,
    totalDepth: tally.totalRows,
    countsAgree: summedByState === tally.totalRows,
    agingBands,
    unbandedOpenCount: tally.openNow - bandedOpen,
    oldestOpenAgeSeconds: tally.oldestOpenAgeSeconds,
    deferredAheadCount: tally.deferredAhead,
    waitAge: deriveWaitAge(tally),
    sla: describeCatalogProposalSla(),
  };
}

/** Read the queue and derive its published shape. */
export async function readProposalQueueAging(
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogProposalQueueAging> {
  return deriveProposalQueueAging(await tallyProposals(QUEUE_TALLY_WINDOW_SECONDS, db));
}
