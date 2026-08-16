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
 * ## The digest covers the SOURCE-REPORTED fields and nothing Mercaria decided
 *
 * State, both money pairs, both instants, the advertiser and the publisher
 * reference. Not `match_state`, not `unmatched_reason`, not `matched_click_id`:
 * those are Mercaria's bookkeeping, and folding them in would make a change in
 * Mercaria's own matching rule read as a network having restated its report.
 *
 * **`network_click_ref` is deliberately NOT in the digest, and
 * {@link classifyAffiliateObservation} compares it separately.** It IS
 * source-reported, so leaving it out of the digest alone would make a network
 * that started echoing an attribution reference read as `unchanged` forever —
 * and the match would never be recomputed. Comparing it in the classifier keeps
 * the digest to the field list #67 names while closing that hole; the cost is
 * one extra comparison and the benefit is that a network gaining attribution is
 * a `restated` observation somebody can see.
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
  readonly networkClickRef: string | null;
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
  ]);
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/** What the incoming poll carried, for the classification. */
export interface IncomingAffiliateObservation {
  readonly state: AffiliateTransactionState;
  readonly orderValue: { readonly amount: number; readonly currency: CurrencyCode } | null;
  readonly commission: { readonly amount: number; readonly currency: CurrencyCode };
  readonly networkClickRef: string | null;
  readonly contentDigest: string;
}

/**
 * Which of the five kinds this observation is.
 *
 * The precedence is checked in this order and the ORDER is the definition:
 *
 * 1. **`first_observation`** — nothing stored. The only kind that can be
 *    decided without a comparison.
 * 2. **`state_change`** — the network's own word about the transaction moved.
 *    Checked before the amounts deliberately: an approval that also carries a
 *    corrected commission is a state change first, because that is the fact an
 *    operator reads and the fact that decides whether money is booked. Reading
 *    it as `amount_change` would bury a reversal in the bucket that means
 *    "somebody adjusted a number".
 * 3. **`amount_change`** — same state, and one of the two money pairs moved
 *    (either amount or either currency).
 * 4. **`restated`** — same state, same money, and something else the network
 *    reported moved: an event or processing instant, an advertiser or publisher
 *    reference, or a click reference it did not send before.
 * 5. **`unchanged`** — the digest matches and so does the click reference. A
 *    confirming re-poll, which is the COMMONEST outcome: a 45-day lookback
 *    re-reads every transaction it has already seen.
 *
 * `restated` and `amount_change` are separate kinds because they send an
 * operator to different places — a moved amount is money to re-book, a
 * re-issued record is a network correcting its own metadata. The shared-types
 * docblock argues for the separation and does not settle which side of the line
 * a same-state commission correction falls on; it is `amount_change` here,
 * because that is what the NAME of the bucket says and a reader who never read
 * the docblock will read the name. Flipping it is one branch in this function.
 */
export function classifyAffiliateObservation(
  previous: StoredAffiliateObservation | undefined,
  incoming: IncomingAffiliateObservation,
): AffiliateObservationKind {
  if (previous === undefined) return 'first_observation';
  if (previous.state !== incoming.state) return 'state_change';

  const commissionMoved =
    previous.commissionAmount !== incoming.commission.amount ||
    previous.commissionCurrency !== incoming.commission.currency;
  const orderValueMoved =
    previous.orderValueAmount !== (incoming.orderValue?.amount ?? null) ||
    previous.orderValueCurrency !== (incoming.orderValue?.currency ?? null);
  if (commissionMoved || orderValueMoved) return 'amount_change';

  if (previous.contentDigest !== incoming.contentDigest) return 'restated';
  if (previous.networkClickRef !== incoming.networkClickRef) return 'restated';
  return 'unchanged';
}

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
