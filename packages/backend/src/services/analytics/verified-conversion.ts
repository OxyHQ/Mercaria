/**
 * The ONE seam through which analytics reads financial truth (#77 identity rule
 * 8, acceptances 3 and 9).
 *
 * ## Why this file exists at all
 *
 * Every conversion metric could have been computed from events. A
 * `checkout_started` and a `payment_succeeded` event would join cleanly, the
 * numbers would look right, and the whole thing would be forgeable by any
 * client that could POST to the ingest endpoint. So the conversion numerators
 * do not come from events: they come from `payments` and `orders`, and this
 * module is the only place the analytics domain touches them.
 *
 * `services/payments/order-linkage.ts` is the precedent one domain over — the
 * payment domain reads orders through a projection it owns rather than reaching
 * into the order repository from five places. Same reasoning, opposite
 * direction: analytics reads payments and orders through a projection IT owns,
 * so the surface is one file to audit rather than a habit spread through the
 * rollup.
 *
 * ## What it deliberately does NOT read
 *
 * No amounts and no currencies. Native GMV and marketplace revenue are named in
 * #77's metric list, and both are computed by the existing report and
 * reconciliation surfaces from the ledger; recomputing money here would create a
 * second answer to a question that already has one, which is the thing the
 * ledger rules forbid. What this module returns is COUNTS — how many checkout
 * groups reached a succeeded payment — which is all a conversion RATE needs.
 *
 * No buyer identity of any kind. The projection carries `checkout_group_id`,
 * `buyer_origin` and a count, and nothing else. It could not join to a person
 * if a caller wanted it to.
 */

import { and, countDistinct, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres.js';
import { orders } from '../../db/schema/orders.js';
import { payments } from '../../db/schema/payments.js';

/**
 * The payment statuses that mean the money actually arrived.
 *
 * Read from the payment aggregate, which #48's verified event ingress is the
 * only writer of. A client success callback cannot reach it — that is the whole
 * of acceptance 9, and the reason this list is here rather than inlined in a
 * query: it is a claim about what "converted" means, and it should be readable
 * as one.
 */
const SUCCEEDED_PAYMENT_STATUSES = ['succeeded', 'partially_refunded', 'refunded'] as const;

/**
 * A refunded payment still COUNTS as a conversion, and that is deliberate.
 *
 * The purchase happened; a refund is a later, separate fact with its own metric
 * (`guest_post_purchase_demand`). Excluding refunded orders here would make the
 * conversion rate move when a return is processed weeks later, silently
 * rewriting history in a chart somebody already acted on.
 */
export const VERIFIED_CONVERSION_STATUSES: readonly string[] = SUCCEEDED_PAYMENT_STATUSES;

/** One day's verified conversions, sliced by the origin dimension. */
export interface VerifiedConversionSlice {
  /** `'authenticated' | 'external'` today; `'guest'` once #106 lands. */
  readonly buyerOrigin: string;
  /** Distinct checkout groups that reached a succeeded payment. */
  readonly checkoutGroups: number;
}

/**
 * How buyer origin is derived TODAY, and the seam that replaces it.
 *
 * ADR 0003 D6 adds `orders.buyer_origin` (`oxy | guest | external`, immutable
 * after insert) and #106 owns it. Until then the column does not exist, and the
 * honest derivation from what DOES exist is the `ext:` prefix connector imports
 * write into `buyer_oxy_user_id` — the synthetic-identifier precedent ADR 0003
 * opens by criticising, and which is still the only origin signal on the table.
 *
 * Two consequences are stated rather than hidden:
 *
 *  - `'guest'` is not producible today, because `buyer_oxy_user_id` is still
 *    `NOT NULL` and no guest order can exist. `guest_checkout_funnel`'s
 *    numerator therefore reads zero, correctly, rather than reading a number
 *    derived from something else.
 *  - When #106 lands, this expression becomes `orders.buyer_origin` and the
 *    `'authenticated'` label becomes `'oxy'`. That is a one-line change HERE and
 *    nowhere else, which is the whole reason the derivation is a named constant
 *    instead of an inline `case` in the query.
 */
const BUYER_ORIGIN_EXPRESSION = sql<string>`
  case when ${orders.buyerOxyUserId} like 'ext:%' then 'external' else 'authenticated' end
`;

/**
 * Count verified conversions in a window, by buyer origin.
 *
 * The window is on the PAYMENT's own timestamp, not the order's: a checkout
 * that started on the 3rd and was confirmed on the 4th converted on the 4th,
 * and the numerator has to agree with what the rail says happened when.
 *
 * Buyer origin comes from {@link BUYER_ORIGIN_EXPRESSION}, which ADR 0003 D6
 * turns into an immutable `orders.buyer_origin` column when #106 lands — so a
 * guest order that is later CLAIMED will still count as guest here. That is
 * #77 identity rule 7 in the metric: a claim never rewrites which funnel a
 * purchase belonged to.
 */
export async function countVerifiedConversions(input: {
  from: Date;
  to: Date;
}): Promise<readonly VerifiedConversionSlice[]> {
  const rows = await getDb()
    .select({
      buyerOrigin: BUYER_ORIGIN_EXPRESSION,
      checkoutGroups: countDistinct(payments.checkoutGroupId),
    })
    .from(payments)
    .innerJoin(orders, eq(orders.checkoutGroupId, payments.checkoutGroupId))
    .where(
      and(
        inArray(payments.status, [...SUCCEEDED_PAYMENT_STATUSES]),
        isNotNull(payments.checkoutGroupId),
        gte(payments.updatedAt, input.from),
        lt(payments.updatedAt, input.to),
      ),
    )
    .groupBy(BUYER_ORIGIN_EXPRESSION);

  return rows.map((row) => ({
    buyerOrigin: row.buyerOrigin,
    checkoutGroups: Number(row.checkoutGroups),
  }));
}

/**
 * Whether ONE checkout group reached a verified payment.
 *
 * The operator trace's conversion answer. A boolean, deliberately: a trace that
 * returned the payment row would let the analytics surface display provider
 * state, amounts and reference ids — every one of which already has an audited
 * surface behind the PAYMENT operator allow-list, which is a different list and
 * a different vetting.
 */
export async function checkoutGroupConverted(checkoutGroupId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(payments)
    .where(
      and(
        eq(payments.checkoutGroupId, checkoutGroupId),
        inArray(payments.status, [...SUCCEEDED_PAYMENT_STATUSES]),
      ),
    );
  return Number(rows[0]?.total ?? 0) > 0;
}
