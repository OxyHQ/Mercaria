/**
 * Applying ONE reported transaction: the observation, the match and the money
 * (#67).
 *
 * ## The three writes commit together, and that is the load-bearing property
 *
 * The transaction row, its observation and any ledger posting are one
 * `db.transaction(...)`. Splitting them has a specific, silent failure: an
 * observation that committed without its posting is classified `unchanged` by
 * the very next poll — because the stored digest already matches — so the
 * accrual is never booked and nothing anywhere says a commission was missed.
 * That is a commission Mercaria earned, recorded, and did not recognize, found
 * (if ever) when a publisher statement fails to reconcile weeks later.
 *
 * One transaction per REPORTED transaction rather than one per page: a page of
 * five hundred rows in one database transaction holds locks for the length of a
 * network call's worth of work, and one bad row would roll back four hundred
 * and ninety-nine good ones.
 *
 * ## A refusal is an OUTCOME, not an exception
 *
 * Two things can make a row unapplicable after it parsed — a commission
 * re-denominated after it was booked, and an attribution nothing can resolve —
 * and both are reported as named refusals rather than thrown. The poll counts
 * them apart from the five observation buckets, because the run's CHECK
 * partitions what it APPLIED and a row it refused belongs in neither.
 */

import type { AffiliateNetworkId, AffiliateObservationKind } from '@mercaria/shared-types';
import { AFFILIATE_CLICK_REFERENCE_SUPPORT } from '@mercaria/shared-types';
import type { Database } from '../../../db/postgres.js';
import {
  applyChangedAffiliateTransaction,
  confirmAffiliateTransactionUnchanged,
  insertAffiliateTransactionIfAbsent,
  insertAffiliateTransactionObservation,
  lockAffiliateTransactionForUpdate,
  type ObservedAffiliateTransaction,
} from '../../../db/affiliateOutbound/transactionRepository.js';
import {
  affiliateContentDigest,
  classifyAffiliateObservation,
  observationChangedTheRecord,
} from './observe.js';
import { lookupAffiliateClick, matchReportedTransaction } from './matching.js';
import {
  bookAffiliateCommissionPostings,
  planAffiliateCommissionPostings,
  readBookedAffiliatePostings,
  type BookedAffiliateCommission,
} from './posting.js';
import type { ReportedAffiliateTransaction } from './reader.js';

/** Why one row could not be applied after it parsed. */
export type AffiliateApplyRefusal = 'currency_restated' | 'attribution_unresolvable';

/**
 * A refusal raised from INSIDE the database transaction, so it rolls back.
 *
 * Returning a refusal from the transaction callback would COMMIT everything
 * written before it — on a first observation that is a stored transaction row
 * with no observation and no posting, which is precisely the half-written state
 * the single-transaction rule exists to prevent. A throw is the only way to
 * leave nothing behind, so the refusal travels as one and is converted back to
 * an outcome outside.
 */
class AffiliateApplyRefusalError extends Error {
  readonly reason: AffiliateApplyRefusal;
  readonly detail: string;
  constructor(reason: AffiliateApplyRefusal, detail: string) {
    super(detail);
    this.name = 'AffiliateApplyRefusalError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** A STRING discriminant, for this package's `strict: false` reason. */
export type AffiliateApplyOutcome =
  | {
      readonly outcome: 'applied';
      readonly kind: AffiliateObservationKind;
      readonly transactionId: string;
      /** The observation revision, absent on an `unchanged` confirming poll. */
      readonly revision: number | null;
      readonly booked: readonly BookedAffiliateCommission[];
    }
  | {
      readonly outcome: 'refused';
      readonly reason: AffiliateApplyRefusal;
      readonly detail: string;
    };

/**
 * Apply one reported transaction.
 *
 * @param db A database HANDLE, not an open transaction: this function opens its
 *   own, because the atomicity above is its guarantee rather than its caller's.
 */
export async function applyReportedTransaction(
  db: Database,
  input: {
    readonly network: AffiliateNetworkId;
    readonly reportRunId: string;
    readonly reported: ReportedAffiliateTransaction;
    readonly now: Date;
  },
): Promise<AffiliateApplyOutcome> {
  const { reported } = input;
  const referenceSupport = AFFILIATE_CLICK_REFERENCE_SUPPORT[input.network];

  const lookup = await lookupAffiliateClick({
    network: input.network,
    referenceSupport,
    reference: reported.networkClickRef,
  });
  if (lookup.outcome === 'resolver_unavailable') {
    // A network whose contract DOES supply a reference, on a deployment whose
    // redirect half is not wired up. Refused rather than stored as
    // `reference_not_recognized`, which would publish a verdict about a lookup
    // nobody performed.
    return {
      outcome: 'refused',
      reason: 'attribution_unresolvable',
      detail:
        `${input.network} supplies a publisher reference and no click resolver is registered, ` +
        'so this transaction cannot be attributed or honestly reported as unattributable.',
    };
  }

  const match = matchReportedTransaction({
    network: input.network,
    referenceSupport,
    networkClickRef: reported.networkClickRef,
    resolvedClick: lookup.outcome === 'resolved' ? lookup.click : null,
  });

  const contentDigest = affiliateContentDigest({
    state: reported.state,
    orderValue: reported.orderValue,
    commission: reported.commission,
    eventAt: reported.eventAt,
    networkProcessedAt: reported.networkProcessedAt,
    advertiserRef: reported.advertiserRef,
    publisherRef: reported.publisherRef,
  });

  const observed: ObservedAffiliateTransaction = {
    network: input.network,
    networkTransactionId: reported.networkTransactionId,
    advertiserRef: reported.advertiserRef,
    publisherRef: reported.publisherRef,
    state: reported.state,
    orderValue: reported.orderValue,
    commission: reported.commission,
    eventAt: reported.eventAt,
    networkProcessedAt: reported.networkProcessedAt,
    networkClickRef: reported.networkClickRef,
    matchedClickId: match.state === 'matched' ? match.clickId : null,
    matchState: match.state,
    unmatchedReason: match.state === 'unmatched' ? match.reason : null,
    contentDigest,
  };

  try {
    return await db.transaction(async (tx) => {
    const created = await insertAffiliateTransactionIfAbsent(tx, observed, input.now);
    if (created) {
      const booked = await bookIfOwed(tx, {
        transactionId: created.id,
        revision: 1,
        observed,
        now: input.now,
      });
      await insertAffiliateTransactionObservation(tx, {
        transactionId: created.id,
        reportRunId: input.reportRunId,
        revision: 1,
        kind: 'first_observation',
        observed,
        observedAt: input.now,
      });
      return {
        outcome: 'applied',
        kind: 'first_observation',
        transactionId: created.id,
        revision: 1,
        booked,
      };
    }

    // The insert was refused by the unique index, so the row exists: either it
    // was already there or a concurrent pass inserted it a moment ago. Either
    // way the LOCK is what makes the classification below a comparison against
    // a snapshot nobody else is mid-way through replacing.
    const previous = await lockAffiliateTransactionForUpdate(tx, {
      network: input.network,
      networkTransactionId: reported.networkTransactionId,
    });
    if (!previous) {
      throw new Error(
        `The affiliate transaction ${reported.networkTransactionId} could not be inserted and ` +
          'could not be read; nothing in this domain deletes one, so this is a fault rather ' +
          'than a race.',
      );
    }

    const kind = classifyAffiliateObservation(previous, {
      state: reported.state,
      orderValue: reported.orderValue,
      commission: reported.commission,
      networkClickRef: reported.networkClickRef,
      contentDigest,
    });

    if (!observationChangedTheRecord(kind)) {
      await confirmAffiliateTransactionUnchanged(tx, { id: previous.id, now: input.now });
      return {
        outcome: 'applied',
        kind,
        transactionId: previous.id,
        revision: null,
        booked: [],
      };
    }

    const applied = await applyChangedAffiliateTransaction(tx, {
      id: previous.id,
      observed,
      now: input.now,
    });
    const booked = await bookIfOwed(tx, {
      transactionId: previous.id,
      revision: applied.revision,
      observed,
      now: input.now,
    });
    await insertAffiliateTransactionObservation(tx, {
      transactionId: previous.id,
      reportRunId: input.reportRunId,
      revision: applied.revision,
      kind,
      observed,
      observedAt: input.now,
    });
    return {
      outcome: 'applied',
      kind,
      transactionId: previous.id,
      revision: applied.revision,
      booked,
    };
    });
  } catch (err) {
    if (err instanceof AffiliateApplyRefusalError) {
      return { outcome: 'refused', reason: err.reason, detail: err.detail };
    }
    throw err;
  }
}

/**
 * Plan and write whatever the book still owes this observation.
 *
 * Throws {@link AffiliateApplyRefusalError} rather than returning a refusal:
 * see its docblock — the rollback is the point.
 */
async function bookIfOwed(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  input: {
    transactionId: string;
    revision: number;
    observed: ObservedAffiliateTransaction;
    now: Date;
  },
): Promise<readonly BookedAffiliateCommission[]> {
  const alreadyBooked = await readBookedAffiliatePostings(tx, input.transactionId);
  const plan = planAffiliateCommissionPostings({
    state: input.observed.state,
    commission: input.observed.commission,
    networkTransactionId: input.observed.networkTransactionId,
    booked: alreadyBooked,
  });
  if (plan.outcome === 'refused') {
    throw new AffiliateApplyRefusalError(plan.reason, plan.detail);
  }
  return bookAffiliateCommissionPostings(tx, {
    transactionId: input.transactionId,
    revision: input.revision,
    postings: plan.postings,
    now: input.now,
  });
}
