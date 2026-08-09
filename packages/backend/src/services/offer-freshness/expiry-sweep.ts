/**
 * Retiring what lapsed, WITHOUT losing a catalogue to a bad night (#68
 * scheduler 6 and 8, acceptance 1).
 *
 * ## Display and retirement are two different instants, deliberately
 *
 * An offer past its deadline STOPS BEING SHOWN immediately, derived, with no
 * sweep involved — `assessOfferFreshness` answers `expired` and
 * `mayAppearInComparison` refuses it. That is what makes "grace during an
 * outage" safe: nothing old is ever presented as fresh.
 *
 * The durable RETIREMENT waits an extra window while the source is in a FETCH
 * failure, so a transient outage does not cost the catalogue. The offers come
 * back to `current` when the feed does, with their ids, their `first_seen_at`
 * and their whole observation chain intact — where a retire-and-reingest cycle
 * would have split the history and broken every link into it.
 *
 * ## Which failures earn grace, and the one that must not
 *
 * `sourceHealthGrantsGrace` admits the three FETCH failures and nothing else. A
 * `schema_drift` means Mercaria read the feed perfectly well and did not like
 * what was in it; granting grace there keeps serving prices the source has had
 * every chance to correct. `rights_suspended` earns none at all, and that
 * exclusion is the important one: a withdrawn right is a decision to STOP
 * showing the data, so extending its life is precisely what the grace must
 * never do.
 *
 * ## Idempotent, bounded, resumable
 *
 * `retireOffers` is scoped to `status = 'active'`, so a repeat is a genuine
 * no-op rather than a rewrite of the reason a previous retirement recorded, and
 * the candidate read takes a limit ordered by the deadline — a backlog is swept
 * in chunks a lease can finish rather than in one statement holding locks for
 * minutes. Nothing here deletes anything (#68 scheduler 8): the row, its
 * `source_record_id` and the append-only observation chain behind it all
 * survive, which is what keeps the observed price history reachable.
 */

import { offerRetirementDueAt } from '@mercaria/shared-types';
import type { CatalogSourceHealthState } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import { findCatalogSourceConfig } from '../../db/ingestion/catalogSourceConfigRepository.js';
import {
  listLapsedExternalOfferCandidates,
  retireOffers,
} from '../../db/offers/offerRepository.js';
import { resolveSourceFreshnessPolicy } from './policy.js';

/** What one sweep pass did. */
export interface ExpirySweepResult {
  /** Rows whose STORED deadline had passed. */
  examined: number;
  /** Rows the live policy agreed were past retirement. */
  retired: number;
  /** Rows still inside a source's outage grace. */
  withheld: number;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * One bounded pass.
 *
 * The candidate read is the indexed pre-filter and the decision is the LIVE
 * policy, applied per source. Two spellings of the freshness rule — one in SQL
 * and one in TypeScript — is exactly the disagreement that would let a
 * transient outage delist a catalogue, so there is only the second, and the
 * first narrows.
 */
export async function sweepExpiredOffers(now: Date = new Date()): Promise<ExpirySweepResult> {
  const db = getDb();
  const candidates = await listLapsedExternalOfferCandidates(db, {
    limit: config.offerFreshness.expirySweepBatchSize,
    now,
  });

  // One policy and one health read per SOURCE, not per offer: a sweep over five
  // hundred offers from three feeds resolves three contracts.
  const policies = new Map<string, Awaited<ReturnType<typeof resolveSourceFreshnessPolicy>>>();
  const healths = new Map<string, CatalogSourceHealthState>();

  const dueNow: string[] = [];
  let withheld = 0;
  for (const candidate of candidates) {
    if (candidate.sourceId === null) {
      // An offer whose observation no longer resolves to a source has no
      // contract to be judged against. It is LEFT ALONE rather than retired:
      // the honest reading of "I cannot find out" is not "it is gone", and
      // `assessOfferFreshness` already answers `unknown`, which keeps it out of
      // comparison without anybody deciding anything.
      continue;
    }

    if (!policies.has(candidate.sourceId)) {
      policies.set(candidate.sourceId, await resolveSourceFreshnessPolicy(candidate.sourceId, db));
      const sourceConfig = await findCatalogSourceConfig(db, candidate.sourceId);
      healths.set(candidate.sourceId, sourceConfig?.healthState ?? 'unknown');
    }
    const resolved = policies.get(candidate.sourceId);
    if (resolved === undefined) continue;

    const health: CatalogSourceHealthState = healths.get(candidate.sourceId) ?? 'unknown';
    const dueAt = offerRetirementDueAt(
      {
        sourceId: candidate.sourceId,
        observedAt: candidate.observedAt,
        firstSeenAt: candidate.firstSeenAt,
        lastSeenAt: candidate.lastSeenAt,
        lastConfirmedAt: candidate.lastConfirmedAt,
        declaredUnavailableAt: candidate.declaredUnavailableAt,
        storedExpiresAt: candidate.staleAt,
      },
      resolved.policy,
      health,
    );
    if (dueAt === null) continue;

    if (now.getTime() >= dueAt.getTime()) dueNow.push(candidate.offerId);
    else withheld += 1;
  }

  const retired = await retireOffers(db, dueNow, 'source_expired', now);
  if (retired > 0 || withheld > 0) {
    log.general.info(
      { examined: candidates.length, retired, withheld },
      '[OfferFreshness] expiry sweep',
    );
  }
  return { examined: candidates.length, retired, withheld };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await sweepExpiredOffers();
  } catch (error: unknown) {
    log.general.error({ err: error }, '[OfferFreshness] expiry sweep failed');
  } finally {
    running = false;
  }
}

/** Begin sweeping. Idempotent — a second call is a no-op. */
export function startOfferExpirySweep(): void {
  if (timer !== undefined) return;
  if (!config.offerFreshness.expirySweepEnabled) {
    log.general.info(
      '[OfferFreshness] expiry sweep disabled; lapsed offers still leave comparison, because ' +
        'the freshness verdict is derived at read time and needs no sweep',
    );
    return;
  }

  timer = setInterval(() => {
    void tick();
  }, config.offerFreshness.expirySweepIntervalMs);
  // Never hold the event loop open for the poll — see `~/Oxy/AGENTS.md`.
  timer.unref?.();

  log.general.info(
    { intervalMs: config.offerFreshness.expirySweepIntervalMs },
    '[OfferFreshness] expiry sweep started',
  );
}

/** Stop sweeping. A pass already in flight finishes. */
export function stopOfferExpirySweep(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
