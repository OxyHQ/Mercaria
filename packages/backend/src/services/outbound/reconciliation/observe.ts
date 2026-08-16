/**
 * What one poll SAW about one transaction, as a digest and a classification
 * (#67 conversion requirement 5, acceptance 4).
 *
 * Both functions here are PURE, and that is what makes the run counters real:
 * `affiliate_report_runs_counters_total_check` forces `seen` to equal the sum
 * of the five outcome buckets, so every transaction a pass applies has to land
 * in exactly one — and a classification computed inside a database round trip
 * could only ever be tested through one.
 *
 * ## The digest covers EVERY source-reported field and nothing Mercaria decided
 *
 * State, both money pairs, both instants, the advertiser reference, the
 * publisher reference AND the click reference. Not `match_state`, not
 * `unmatched_reason`, not `matched_click_id`: those are Mercaria's bookkeeping,
 * and folding them in would make a change in Mercaria's own matching rule read
 * as a network having restated its report.
 *
 * **`network_click_ref` is IN the digest, and leaving it out was a real defect
 * caught in review.** It is source-reported, so a digest without it would make
 * a network that STARTED echoing an attribution reference read as `unchanged`
 * forever — the transaction would never be re-observed, so the match would
 * never be recomputed, and the symptom would be an attribution that silently
 * never arrives. "Harmless today because both networks are `not_supported`" is
 * exactly what would have let it survive review: it waits for somebody else's
 * contract to change and then presents as normal operation. There is no
 * volatility argument against including it — a network echoes the same
 * reference on every poll of one transaction, so it moves precisely when the
 * attribution moves. {@link classifyAffiliateObservation} therefore compares
 * digests and nothing else, because two mechanisms for one fact can disagree.
 */

import { createHash } from 'node:crypto';
import type {
  AffiliateObservationKind,
  AffiliateTransactionState,
  CurrencyCode,
} from '@mercaria/shared-types';

/** The source-reported facts one poll carried, before any Mercaria decision. */
export interface AffiliateSourceFacts {
  readonly state: AffiliateTransactionState;
  readonly orderValue: { readonly amount: number; readonly currency: CurrencyCode } | null;
  readonly commission: { readonly amount: number; readonly currency: CurrencyCode };
  readonly eventAt: Date;
  readonly networkProcessedAt: Date | null;
  readonly advertiserRef: string | null;
  readonly publisherRef: string | null;
  /** The reference the NETWORK echoed. See the module docblock — it is IN. */
  readonly networkClickRef: string | null;
}

/**
 * The stored side of a comparison.
 *
 * Deliberately NOT `AffiliateTransactionRow`: this function must be callable
 * with a hand-built previous state in a unit test, and typing it to the row
 * would make every case in that test a full row literal whose irrelevant
 * columns invite somebody to read them as inputs.
 */
export interface StoredAffiliateObservation {
  readonly state: AffiliateTransactionState;
  readonly orderValueAmount: number | null;
  readonly orderValueCurrency: string | null;
  readonly commissionAmount: number;
  readonly commissionCurrency: string;
  readonly contentDigest: string;
}

/**
 * The sha256 hex digest of the source-reported fields. Exactly 64 characters,
 * which `affiliate_transactions_digest_check` requires.
 *
 * The serialization is a fixed-order ARRAY with explicit nulls, so two polls of
 * one unchanged transaction produce byte-identical input — a key-ordered object
 * would depend on property insertion order, which is stable in V8 today and is
 * not a guarantee anybody should rest a change-detector on. Instants are ISO
 * strings so a `Date` object's identity never enters it.
 */
export function affiliateContentDigest(facts: AffiliateSourceFacts): string {
  const material = JSON.stringify([
    facts.state,
    facts.orderValue === null ? null : facts.orderValue.amount,
    facts.orderValue === null ? null : facts.orderValue.currency,
    facts.commission.amount,
    facts.commission.currency,
    facts.eventAt.toISOString(),
    facts.networkProcessedAt === null ? null : facts.networkProcessedAt.toISOString(),
    facts.advertiserRef,
    facts.publisherRef,
    facts.networkClickRef,
  ]);
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/** What the incoming poll carried, for the classification. */
export interface IncomingAffiliateObservation {
  readonly state: AffiliateTransactionState;
  readonly orderValue: { readonly amount: number; readonly currency: CurrencyCode } | null;
  readonly commission: { readonly amount: number; readonly currency: CurrencyCode };
  readonly contentDigest: string;
}

/**
 * The TOTAL ORDER the five kinds are decided in.
 *
 * A single ordered list rather than a chain of `if`s, because the thing that
 * goes wrong is never one predicate — it is two of them being true at once and
 * the wrong one winning. Every entry is a test, and the first that answers
 * `true` names the kind:
 *
 * 1. **`first_observation`** — nothing stored. The only kind decidable without
 *    a comparison, so it cannot be reached by any later rule.
 * 2. **`state_change`** — the network's own word moved. BEFORE the amounts,
 *    deliberately: a reversal carrying a corrected commission is a REVERSAL,
 *    and bucketing it as `amount_change` buries it among "somebody adjusted a
 *    number", which is the row an operator scrolls past. This is also the
 *    branch the degenerate case lands on — state, money and metadata all moving
 *    in one poll, which is exactly what a network does when it validates a
 *    transaction.
 * 3. **`amount_change`** — same state, and one of the two money pairs moved
 *    (either amount or either currency).
 * 4. **`restated`** — same state, same money, and something else the network
 *    reported moved: an event or processing instant, an advertiser reference, a
 *    publisher reference, or a click reference it did not send before.
 * 5. **`unchanged`** — the digest matches. The COMMONEST outcome: a 45-day
 *    lookback re-reads every transaction it has already seen.
 *
 * `restated` and `amount_change` are separate kinds because they send an
 * operator to different places — a moved amount is money to re-book, a
 * re-issued record is a network correcting its own metadata. The shared-types
 * docblock argues for the separation and does not settle which side a
 * same-state commission correction falls on; it is `amount_change` here,
 * because that is what the NAME of the bucket says and a reader who never read
 * the docblock will read the name.
 */
const CLASSIFICATION_ORDER: readonly {
  readonly kind: AffiliateObservationKind;
  readonly matches: (
    previous: StoredAffiliateObservation | undefined,
    incoming: IncomingAffiliateObservation,
  ) => boolean;
}[] = [
  { kind: 'first_observation', matches: (previous) => previous === undefined },
  {
    kind: 'state_change',
    matches: (previous, incoming) => previous !== undefined && previous.state !== incoming.state,
  },
  {
    kind: 'amount_change',
    matches: (previous, incoming) =>
      previous !== undefined &&
      (previous.commissionAmount !== incoming.commission.amount ||
        previous.commissionCurrency !== incoming.commission.currency ||
        previous.orderValueAmount !== (incoming.orderValue?.amount ?? null) ||
        previous.orderValueCurrency !== (incoming.orderValue?.currency ?? null)),
  },
  {
    kind: 'restated',
    matches: (previous, incoming) =>
      previous !== undefined && previous.contentDigest !== incoming.contentDigest,
  },
];

/** Which of the five kinds this observation is. See {@link CLASSIFICATION_ORDER}. */
export function classifyAffiliateObservation(
  previous: StoredAffiliateObservation | undefined,
  incoming: IncomingAffiliateObservation,
): AffiliateObservationKind {
  for (const rule of CLASSIFICATION_ORDER) {
    if (rule.matches(previous, incoming)) return rule.kind;
  }
  return 'unchanged';
}

/**
 * The order, exported so a test can assert it is the one documented above.
 *
 * A test that only drove the five kinds one at a time would pass under any
 * ordering; asserting the SEQUENCE is what makes "state before amount"
 * checkable rather than merely true today.
 */
export const AFFILIATE_CLASSIFICATION_ORDER: readonly AffiliateObservationKind[] =
  CLASSIFICATION_ORDER.map((rule) => rule.kind);

/**
 * Whether a kind means the stored row has to be rewritten.
 *
 * `unchanged` is the only kind that does not, and stating it as a function
 * rather than as `kind !== 'unchanged'` at three call sites is what stops a
 * sixth kind being added and silently landing on the wrong side of it.
 */
export function observationChangedTheRecord(kind: AffiliateObservationKind): boolean {
  return kind !== 'unchanged';
}
