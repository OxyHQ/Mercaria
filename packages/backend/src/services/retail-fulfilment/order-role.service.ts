/**
 * What a retail order records about ITSELF at the moment it is placed (#126
 * §"Immutable order-role snapshot" and §"Fulfilment and quantity mapping").
 *
 * One function, {@link recordRetailFulfilmentPlan}, called from
 * `checkout.service` inside the transaction that writes the retail order — the
 * same transaction that already carries the guest contact row and #123's frozen
 * procurement intents, and for the same reason: every one of these rows is
 * meaningless without the order and the order is incomplete without them.
 *
 * It writes four things:
 *
 *  1. the order-role snapshot — who sold this and under what consumer terms;
 *  2. one fulfilment intent per supplier, carrying what the agreement PERMITTED;
 *  3. the line allocations — exactly which units of which customer line each
 *     supplier covers;
 *  4. the accepted delivery promise, when the suppliers gave a window.
 *
 * ## Why the allocation is composed from the PLAN and not matched afterwards
 *
 * `buildRetailOrder` maps `plan.lines[i]` to `order_items[i]`, in order, so the
 * pairing is positional and exact. The alternative in the tree — matching an
 * intent line to an order item by its money amount — pairs two lines that
 * happen to cost the same, and its own comment says so. Reading the items back
 * by `position` inside the transaction is one indexed read and removes the
 * ambiguity entirely.
 *
 * ## The mode written here is the CONTRACTUAL one, and only that
 *
 * `permitted_fulfilment_mode` comes off the supply agreement version this
 * purchase was made under. The mode actually USED cannot be known yet — Mode A
 * needs verified package facts, which arrive after a supplier accepts — so
 * `fulfilment_mode` is left NULL and written exactly once later. See
 * `fulfilment-mode.ts` for why those are two facts with two clocks.
 *
 * ## Nothing here talks to Moovo, and nothing here may
 *
 * This runs inside the transaction that places a buyer's order. An outbound
 * logistics call in that path would put a multi-second timeout between a
 * captured charge and a committed order, and a task restart mid-call would
 * leave a paid buyer with no order at all — the argument
 * `retail-checkout/fulfilment.service.ts` already makes about supplier calls.
 * Transport is arranged later, from the intent rows this writes.
 */

import { log } from '../../lib/logger.js';
import { config } from '../../config/index.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { findAgreementById } from '../../db/procurement/agreementRepository.js';
import {
  insertRetailFulfilmentIntents,
  insertRetailOrderRoleSnapshot,
  listOrderItemIdsInPosition,
  type RetailFulfilmentIntentRow,
} from '../../db/retailFulfilment/retailFulfilmentRepository.js';
import { currentRetailCustomerTerms } from './customer-terms.js';
import { determinePermittedFulfilmentMode } from './fulfilment-mode.js';
import { recordAcceptedDeliveryPromise } from './delivery-promise.service.js';

/** One planned retail line, reduced to what this module needs. */
export interface RetailFulfilmentPlanLine {
  /** Which supplier fulfils it — the key its intent is found by. */
  supplierId: string;
  /** Units of this catalogue line. */
  quantity: number;
  /** The supplier's stated transit range, from #122's quote. NULL = unknown. */
  deliveryDaysMin: number | null;
  deliveryDaysMax: number | null;
}

/** What `checkout.service` hands over, after the order and its intents exist. */
export interface RetailFulfilmentPlanInput {
  orderId: string;
  /** In the SAME order `buildRetailOrder` composed the order items. */
  lines: readonly RetailFulfilmentPlanLine[];
  /** #123's freshly written procurement intents, keyed by supplier below. */
  procurementIntents: readonly { id: string; supplierId: string; agreementId: string }[];
  /** The order's own creation instant — the clock the promise is measured from. */
  placedAt: Date;
}

/** What was written, for the caller's log line. */
export interface RetailFulfilmentPlanResult {
  snapshotId: string;
  intents: readonly RetailFulfilmentIntentRow[];
  acceptedPromiseRecorded: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Write the role snapshot, the fulfilment intents, their allocations and the
 * accepted delivery promise — all inside the order's transaction.
 *
 * @param db MUST be the transaction the retail order was written in.
 */
export async function recordRetailFulfilmentPlan(
  db: DatabaseOrTransaction,
  input: RetailFulfilmentPlanInput,
): Promise<RetailFulfilmentPlanResult> {
  const terms = currentRetailCustomerTerms();
  const snapshot = await insertRetailOrderRoleSnapshot(db, {
    orderId: input.orderId,
    sellerLegalEntityName: config.retail.sellerLegalEntityName,
    sellerLegalEntityCountry: config.retail.sellerLegalEntityCountry,
    supplierFulfilmentDisclosureKey: terms.supplierFulfilmentDisclosureKey,
    supplierFulfilmentDisclosureVersion: terms.supplierFulfilmentDisclosureVersion,
    customerTermsVersion: terms.customerTermsVersion,
    cancellationWindowHours: terms.cancellationWindowHours,
    withdrawalWindowDays: terms.withdrawalWindowDays,
    returnWindowDays: terms.returnWindowDays,
    warrantyMonths: terms.warrantyMonths,
  });

  // The customer lines, in the order checkout composed them. `plan.lines[i]`
  // and `items[i]` are the same line — see the module docblock.
  const items = await listOrderItemIdsInPosition(db, input.orderId);
  if (items.length !== input.lines.length) {
    throw new Error(
      `Retail order ${input.orderId} has ${items.length} item(s) and its plan has ` +
        `${input.lines.length} line(s); a fulfilment allocation cannot be composed from a ` +
        'mismatch, because the pairing is positional.',
    );
  }

  const allocationsBySupplier = new Map<string, { orderItemId: string; quantity: number }[]>();
  input.lines.forEach((line, index) => {
    const item = items[index];
    if (!item) {
      // Unreachable given the length check above. A throw rather than a
      // non-null assertion, which the house rules forbid.
      throw new Error(`Retail order ${input.orderId} has no item at position ${index}`);
    }
    const existing = allocationsBySupplier.get(line.supplierId) ?? [];
    existing.push({ orderItemId: item.id, quantity: line.quantity });
    allocationsBySupplier.set(line.supplierId, existing);
  });

  const intents: Parameters<typeof insertRetailFulfilmentIntents>[1][number][] = [];
  for (const procurementIntent of input.procurementIntents) {
    const allocations = allocationsBySupplier.get(procurementIntent.supplierId);
    if (!allocations || allocations.length === 0) {
      // A supplier with an intent and no lines cannot happen — #123 composes
      // one intent per supplier FROM the lines — and if it ever did, a
      // fulfilment intent covering nothing would sit in the operator queue
      // forever with no remedy. Refusing is loud and the transaction rolls
      // back with the order, which is recoverable; the row is not.
      throw new Error(
        `Retail order ${input.orderId} names supplier ${procurementIntent.supplierId} in a ` +
          'procurement intent but in no line; a fulfilment intent would cover nothing.',
      );
    }

    const agreement = await findAgreementById(procurementIntent.agreementId, db);
    if (!agreement) {
      throw new Error(
        `Supply agreement ${procurementIntent.agreementId} does not exist; the fulfilment mode ` +
          'this purchase was made under cannot be recorded.',
      );
    }
    // `inForce: true` because #123's eligibility gate has already run the
    // fail-closed scope check for this exact sale — re-deriving it here would
    // be a second answer to a question `services/procurement/agreement-scope.ts`
    // owns, and the two would disagree the day one learned about a new scope
    // column.
    const decision = determinePermittedFulfilmentMode({
      inForce: true,
      dropshipRightsGranted: agreement.dropshipRightsGranted,
      moovoLabelDispatchPermitted: agreement.moovoLabelDispatchPermitted,
    });
    if (decision.outcome === 'refused') {
      throw new Error(
        `Supply agreement ${agreement.id} permits no fulfilment path (${decision.reason}); ` +
          'this line should have been refused at eligibility, before the buyer was charged.',
      );
    }

    intents.push({
      orderId: input.orderId,
      procurementIntentId: procurementIntent.id,
      permittedFulfilmentMode: decision.permitted,
      allocations,
    });
  }

  const written = await insertRetailFulfilmentIntents(db, intents);

  // The buyer's promise is about the WHOLE order, so it is the slowest line:
  // an order arrives when its last parcel does, and promising the fastest would
  // be a promise Mercaria breaks on every multi-supplier basket. A line whose
  // supplier stated no window contributes nothing rather than a zero — #126
  // rule 10 — so an order none of whose suppliers gave a window records no
  // accepted promise at all, which is a real state and not a gap.
  const earliestDays = maxStatedDays(input.lines.map((line) => line.deliveryDaysMin));
  const latestDays = maxStatedDays(input.lines.map((line) => line.deliveryDaysMax));
  let acceptedPromiseRecorded = false;
  if (earliestDays !== undefined || latestDays !== undefined) {
    await recordAcceptedDeliveryPromise(db, {
      orderId: input.orderId,
      ...(earliestDays !== undefined
        ? { earliestAt: new Date(input.placedAt.getTime() + earliestDays * MS_PER_DAY) }
        : {}),
      ...(latestDays !== undefined
        ? { latestAt: new Date(input.placedAt.getTime() + latestDays * MS_PER_DAY) }
        : {}),
      observedAt: input.placedAt,
    });
    acceptedPromiseRecorded = true;
  }

  log.general.info(
    {
      orderId: input.orderId,
      intents: written.length,
      allocations: intents.reduce((total, intent) => total + intent.allocations.length, 0),
      acceptedPromiseRecorded,
    },
    '[RetailFulfilment] order-role snapshot and fulfilment plan recorded',
  );
  return { snapshotId: snapshot.id, intents: written, acceptedPromiseRecorded };
}

/** The largest stated transit figure, ignoring the lines that stated none. */
function maxStatedDays(values: readonly (number | null)[]): number | undefined {
  let largest: number | undefined;
  for (const value of values) {
    if (value === null) continue;
    if (largest === undefined || value > largest) largest = value;
  }
  return largest;
}
