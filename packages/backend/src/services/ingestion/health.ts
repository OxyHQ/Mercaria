/**
 * HEALTH — issue #62 §"Health / error states", and the rule that costs money if
 * it is got wrong: **do not mass-expire healthy offers because one refresh
 * failed.**
 *
 * ## Why that failure is so easy to write and so hard to see
 *
 * A refresh sweep normally ends by retiring everything the source did not
 * mention this time. That is correct after a COMPLETE enumeration and
 * catastrophic after anything else, and the two are indistinguishable from
 * inside the sweep: a feed that returned 401 on page two produced a set of
 * observed ids exactly like a feed whose catalogue shrank. Retiring on it
 * delists a merchant's entire inventory, reports success, and is discovered by
 * the merchant.
 *
 * So retirement is authorised by TWO independent things that must agree, and
 * neither of them is the sweep's own opinion:
 *
 *  1. the ADAPTER said this page completed a full enumeration
 *     (`AdapterFetchPage.complete`), and
 *  2. the run's OUTCOME is in `CATALOG_SOURCE_RETIRING_OUTCOMES`, which has one
 *     member.
 *
 * `catalog_source_runs_retirement_check` then refuses to store a non-zero
 * retirement count unless both hold, rendered from the same tuple this module
 * reads — so the constraint and the service cannot drift, and a hand-written
 * `UPDATE` is refused with them.
 *
 * `partial_feed` is deliberately outside the retiring set even though the run
 * succeeded in part. "The half I read did not mention it" is not evidence about
 * the half I did not read.
 */

import type {
  CatalogSourceFetchFailureKind,
  CatalogSourceHealthState,
  CatalogSourceStatus,
} from '@mercaria/shared-types';
import { CATALOG_SOURCE_RETIRING_OUTCOMES } from '@mercaria/shared-types';

/** What one completed pass observed, as the classifier reads it. */
export interface RunHealthInput {
  /** The adapter's own claim that it enumerated the source completely. */
  readonly enumerationComplete: boolean;
  /** The failure that stopped it, when one did. */
  readonly failure: CatalogSourceFetchFailureKind | null;
  /** Records the run refused for schema or parse reasons. */
  readonly rejected: number;
  /** Records held out of the pipeline. */
  readonly quarantined: number;
  /** Records that reached a matcher verdict of "a person must decide". */
  readonly reviewRequired: number;
  /** Records the run fetched at all. */
  readonly fetched: number;
  /** Whether the source's rights currently permit refreshing it. */
  readonly refreshPermitted: boolean;
}

/**
 * The share of a page that must be rejected or quarantined before the run is
 * called degraded rather than successful.
 *
 * A provider legitimately publishes the odd unparseable row; a provider that
 * renamed a field publishes nothing else. One in five is the line, and it is a
 * constant rather than a config value because it is a definition of "drifted",
 * not a tuning knob — a deployment that could lower it could make drift
 * invisible.
 */
export const SCHEMA_DRIFT_REJECTION_RATIO = 0.2;

/**
 * The share of a page that may need review before the run reports
 * `matching_ambiguity`.
 *
 * Higher than the drift threshold on purpose: ambiguity is the normal state of
 * a catalogue nobody has curated yet, and reporting it as unhealthy on day one
 * would make the health board useless exactly when a new source is being
 * brought up. It is a signal that the review queue is growing faster than
 * anybody can drain it (#59's), not that the fetch failed.
 */
export const MATCHING_AMBIGUITY_RATIO = 0.5;

/**
 * Classify one completed pass.
 *
 * ORDER is the decision procedure and it runs worst-first, because a run can be
 * several of these at once and the one that matters is the most severe: a pass
 * that authenticated, drifted AND left review work owes its operator "your
 * schema changed", not "your queue is long". That is `deriveRetailCompleteness`'
 * severity rule (#120) applied to a health state.
 */
export function classifyRunOutcome(input: RunHealthInput): CatalogSourceHealthState {
  // A source whose rights were withdrawn mid-run is not broken and its provider
  // is not at fault; saying `source_outage` would send somebody to check a
  // service that is answering fine.
  if (!input.refreshPermitted) return 'rights_suspended';

  if (input.failure !== null) {
    switch (input.failure) {
      case 'auth_failure':
        return 'auth_failure';
      case 'rate_limit':
        return 'rate_limit';
      case 'source_outage':
        return 'source_outage';
      case 'schema_drift':
        return 'schema_drift';
      case 'parse_failure':
        return 'parse_failure';
    }
  }

  if (input.fetched > 0) {
    const refusedRatio = (input.rejected + input.quarantined) / input.fetched;
    if (refusedRatio >= SCHEMA_DRIFT_REJECTION_RATIO) return 'schema_drift';
    if (input.reviewRequired / input.fetched >= MATCHING_AMBIGUITY_RATIO) {
      return 'matching_ambiguity';
    }
  }

  return input.enumerationComplete ? 'full_feed_success' : 'partial_feed';
}

/**
 * May this run retire the offers the source stopped publishing?
 *
 * BOTH conditions, and the tuple is the same one the CHECK is rendered from.
 * Callers must not re-derive this: `offersRetired` is refused at the row when
 * they disagree, so a caller that computed its own answer would surface the
 * disagreement as a constraint violation on an otherwise successful run.
 */
export function mayRetireUnseen(input: {
  readonly enumerationComplete: boolean;
  readonly outcome: CatalogSourceHealthState;
}): boolean {
  return input.enumerationComplete && CATALOG_SOURCE_RETIRING_OUTCOMES.includes(input.outcome);
}

/** Every outcome that is not a complete success, for the "is it degraded" read. */
export function isDegraded(outcome: CatalogSourceHealthState): boolean {
  return outcome !== 'full_feed_success';
}

/**
 * The status a source's config takes after a run.
 *
 * A source only becomes `failed` on a run that could not FETCH: a pass that
 * read the feed and refused half of it is degraded and stays `active`, because
 * `failed` is what the dispatcher's backoff reads and backing off from a
 * healthy provider over our own parse problem fixes nothing.
 *
 * Nothing here can move a source OUT of `paused` or `revoked` — those are
 * somebody's decision, and a run has no standing to undo one. Returning the
 * current status unchanged is how that is expressed, rather than by a branch
 * every caller has to remember.
 */
export function statusAfterRun(
  current: CatalogSourceStatus,
  outcome: CatalogSourceHealthState,
): CatalogSourceStatus {
  if (current === 'paused' || current === 'revoked' || current === 'draft') return current;
  switch (outcome) {
    case 'auth_failure':
    case 'rate_limit':
    case 'source_outage':
      return 'failed';
    default:
      return 'active';
  }
}

/**
 * When the source is next due, given how it just went.
 *
 * Capped exponential backoff on consecutive failures, the moderation and
 * payment outbox shape. A provider-supplied `retryAfterMs` WINS over the
 * computed backoff whenever it is longer, because guessing against a rate limit
 * that told you the answer is how an integration gets banned; it never
 * shortens the backoff, so a provider cannot talk Mercaria into hammering it.
 */
export function nextRunDelayMs(input: {
  readonly cadenceSeconds: number | null;
  readonly consecutiveFailures: number;
  readonly retryAfterMs: number | undefined;
  readonly maxBackoffMs: number;
}): number {
  const cadenceMs = (input.cadenceSeconds ?? 3_600) * 1_000;
  if (input.consecutiveFailures === 0) {
    return input.retryAfterMs !== undefined
      ? Math.max(cadenceMs, input.retryAfterMs)
      : cadenceMs;
  }
  // 2^n minutes, capped. `n` is bounded before the shift so a long outage
  // cannot overflow it into a negative delay.
  const exponent = Math.min(input.consecutiveFailures, 10);
  const backoffMs = Math.min(input.maxBackoffMs, 60_000 * 2 ** exponent);
  return input.retryAfterMs === undefined ? backoffMs : Math.max(backoffMs, input.retryAfterMs);
}
