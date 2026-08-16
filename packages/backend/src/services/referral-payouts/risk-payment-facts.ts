/**
 * Answering the referral integrity domain's payment-facts port (#344, #148
 * "Risk signals", ADR 0005 D17/A2).
 *
 * ## Why the queries live HERE and not in either domain
 *
 * `referral-integrity-isolation.test.ts` WALL 2 forbids everything under
 * `services/referrals/integrity/` from importing the payment domain, in all
 * four shapes it has learned about — `services/payments/`, `db/payments/`,
 * `db/schema/{payments,ledger}.` and a bare `stripe`. That wall is right: a
 * fraud detector able to read the payment domain is one join from a fraud
 * DECISION that depends on it.
 *
 * The reverse edge is worse and is the one #123 warns about by name: adding a
 * referral-shaped reader to `db/payments/` would make the payment domain
 * depend on the marketing domain to satisfy a marketing question. So the SQL
 * sits in this module, which is neither — the same reasoning that put
 * `readiness.ts` here for #146, and deliberately the same directory rather than
 * a second join, because two places bridging referrals and payments would be
 * two places to get the direction wrong.
 *
 * Every edge runs join → domain. This file names `db/schema/payments.ts`,
 * `db/schema/orders.ts` and the referral domain's PORT; nothing in either
 * walled domain names this file.
 *
 * ## It reads the RECORD, so `STRIPE_ENABLED` does not gate it
 *
 * `readiness.ts` returns before touching Postgres when the rail is off, and
 * that is correct THERE: it asks "may Mercaria send this person money now",
 * which is a live capability question, and with no rail configured the honest
 * answer is that Mercaria cannot tell.
 *
 * This asks a different kind of question — "what did a provider already do to
 * these orders" — and `disputes` and `payment_attempts` are Mercaria's own
 * durable record of that. They keep their rows when the rail is switched off,
 * and `external` and `manual_pos` payments exist on deployments that never had
 * one. Gating on the flag would report UNMEASURED for facts that are sitting in
 * the database, which is the failure the facts type's whole `undefined`
 * convention exists to make visible rather than to manufacture.
 *
 * ## The two facts are disjoint halves of one cohort
 *
 * `disputeRateBps` counts conversions whose order carries a dispute;
 * `providerAdverseOutcomeCount` counts DECLINED charge attempts. A dispute is
 * never counted twice, because scoring one occurrence under two signal kinds is
 * the cross-kind version of the double-count `risk-thresholds.ts` already
 * refuses within `refund_dispute_concentration`.
 *
 * ## What it deliberately cannot return
 *
 * No account id, charge id, dispute id, customer reference or provider handle —
 * `ReferralRiskPaymentFacts` has no field for one (#148 boundary 2, ADR 0005
 * A2: a fraud signal may reference payment-domain OUTCOMES and never
 * payment-domain IDENTIFIERS). The select lists below name COUNTS and one set
 * of Mercaria ORDER ids, which are the caller's own values coming back.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PaymentAttemptStatus } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { orders } from '../../db/schema/orders.js';
import { disputes, paymentAttempts } from '../../db/schema/payments.js';
import type {
  ReferralRiskPaymentFacts,
  ReferralRiskPaymentSubject,
} from '../referrals/integrity/payment-facts.port.js';

/** 10_000 basis points is 100%, as everywhere else in this repository. */
const BPS = 10_000;

/**
 * The attempt status that IS a decline.
 *
 * TYPED, so renaming the member in `@mercaria/shared-types` fails `tsc` here
 * rather than silently making this counter read zero forever — which is the
 * failure the whole port exists to avoid one level up. `pending` is a call
 * still running and `succeeded` is the opposite outcome; there is no fourth.
 */
const DECLINED_ATTEMPT_STATUS: PaymentAttemptStatus = 'failed';

/**
 * The payment-domain facts for one partner's window, or silence.
 *
 * Registered into the port by `register.ts`. It never throws for the caller's
 * benefit — the port catches anyway — but it also never invents: every branch
 * that cannot measure returns the empty object rather than a zero.
 */
export async function readReferralRiskPartnerPaymentFacts(
  subject: ReferralRiskPaymentSubject,
): Promise<ReferralRiskPaymentFacts> {
  // A truncated cohort would under-report a fraud rate, which is the one
  // direction this measurement must never fail in. Both facts are withheld
  // together: the count is over the same population as the rate, so serving one
  // of them would report a partial cohort under a whole fact's name.
  if (subject.orderCohort.kind === 'not_enumerable') return {};

  const orderRefs = subject.orderCohort.orderRefs;

  // DEDUPED for the query and NOT for the arithmetic. Two conversions derived
  // from one order are two conversions — the contract is a rate over
  // conversions — so the duplicate-preserving list is what the numerator counts
  // against the deduplicated set the database answered with.
  const distinctOrderRefs = [...new Set(orderRefs)];

  const disputedOrderIds =
    distinctOrderRefs.length === 0 ? new Set<string>() : await readDisputedOrderIds(distinctOrderRefs);
  const declinedAttempts =
    distinctOrderRefs.length === 0 ? 0 : await countDeclinedAttempts(distinctOrderRefs);

  const disputedConversions = orderRefs.filter((ref) => disputedOrderIds.has(ref)).length;

  return {
    // Always supplied once the cohort is enumerated: a COUNT of zero is "we
    // counted and found none", exactly as `capRefusalCount: 0` is one field
    // over, and `deriveRiskSignals` emits nothing for it.
    providerAdverseOutcomeCount: declinedAttempts,
    // A rate over zero conversions is UNDEFINED, never zero — the rule
    // `collectRiskSignalFacts` applies to `refundRateBps` immediately beside
    // this, and the reason the denominator is passed in rather than counted
    // here. Left off the object entirely rather than set to 0, because a 0 bps
    // dispute rate asserts a clean cohort nobody could have measured.
    ...(subject.conversionsInWindow > 0
      ? {
          disputeRateBps: Math.round((disputedConversions * BPS) / subject.conversionsInWindow),
        }
      : {}),
  };
}

/**
 * Which of these orders carry a dispute.
 *
 * NOT time-bounded, deliberately. The window scopes the CONVERSIONS — that is
 * what the cohort already is — and a dispute is raised weeks after the purchase
 * it disputes, so re-applying the window to `disputes.created_at` would make
 * the fact structurally unable to observe the thing it names.
 *
 * Every status counts, `warning` (an inquiry) included. An inquiry books no
 * money and `chargeSucceeded`'s ledger treatment tells it apart from a
 * chargeback for exactly that reason — but this is not accounting. It is the
 * earliest thing a provider ever says about a referred cohort, and a signal can
 * only ever open a review: `referral_enforcement_actions_forfeiture_basis_check`
 * makes an action on a `risk_signal` basis unable to destroy money. The cost is
 * stated rather than hidden — a partner whose orders attract inquiries that all
 * resolve in Mercaria's favour scores the same as one losing chargebacks, and
 * telling those apart is an operator's job with the evidence in front of them.
 */
async function readDisputedOrderIds(distinctOrderRefs: string[]): Promise<Set<string>> {
  const rows = await getDb()
    .selectDistinct({ orderId: disputes.orderId })
    .from(disputes)
    .where(inArray(disputes.orderId, distinctOrderRefs));

  const found = new Set<string>();
  for (const row of rows) {
    // `disputes.order_id` is nullable — a dispute is attributed to its order
    // after the fact — and `inArray` cannot match a NULL, so this is belt and
    // braces rather than a live branch. It exists so the set can never acquire
    // an `undefined` member that would then match nothing and read as a clean
    // cohort.
    if (row.orderId !== null && row.orderId !== undefined) found.add(row.orderId);
  }
  return found;
}

/**
 * How many charge ATTEMPTS a provider declined across these orders.
 *
 * Attempts rather than payment status: `payment_attempts` is append-only and
 * per call, so an order that was declined four times and paid on the fifth
 * still records four declines — which is the card-testing shape this signal is
 * for, and the shape a `payments.status = 'failed'` read cannot see at all
 * because the aggregate ends at `succeeded`.
 *
 * `orders.payment_id` is the link and it is indexed
 * (`orders_payment_id_idx`). `payments.order_id` is deliberately not used: it
 * is set only where one payment stands for one order, so a multi-seller
 * checkout group — the ordinary case — carries NULL there and would silently
 * contribute nothing.
 *
 * ## `count(distinct …)`, and it is not tidiness
 *
 * ONE payment covers EVERY order in a checkout group — that is the whole reason
 * `payments.order_id` is null for a group and `orders.payment_id` is stamped on
 * each — so a plain `count(*)` over this join multiplies each declined attempt
 * by the number of referred orders sharing its payment. Three declines on a
 * twenty-order group read as SIXTY, which is not a rounding error: it is an
 * `elevated` signal manufactured out of an ordinary basket, in the alarming
 * direction, on the commonest checkout shape there is. Measured — the realdb
 * fixture reported exactly 60 before this line said `distinct`.
 *
 * The attempt is the unit because the attempt is what the provider did: one
 * decline is one decline however many sellers the basket had.
 *
 * Not time-bounded, for `readDisputedOrderIds`' reason: the cohort is already
 * the window, and a decline arriving a minute after it closed belongs to the
 * order that is in it.
 */
async function countDeclinedAttempts(distinctOrderRefs: string[]): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<string>`count(distinct ${paymentAttempts.id})` })
    .from(paymentAttempts)
    .innerJoin(orders, eq(orders.paymentId, paymentAttempts.paymentId))
    .where(
      and(
        inArray(orders.id, distinctOrderRefs),
        eq(paymentAttempts.status, DECLINED_ATTEMPT_STATUS),
      ),
    );

  // postgres.js decodes `count(*)` (an int8) as a STRING while drizzle types it
  // `number`, so the coercion happens once, here. A missed one is arithmetic on
  // a string, which concatenates silently.
  return Number(row?.total ?? 0);
}
