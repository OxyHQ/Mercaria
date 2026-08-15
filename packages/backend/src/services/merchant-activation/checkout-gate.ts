/**
 * The activation gate on checkout (#85 acceptance 2 and 4, #88's deferred fee
 * acceptance gate).
 *
 * ## What it refuses, and — much more importantly — what it does NOT
 *
 * The full activation conjunction is an ONBOARDING question: whether a merchant
 * has a connected catalogue, a publishable listing or a completed test order has
 * no business deciding a checkout for a listing the buyer is holding in their
 * cart. Refusing on those would take a working store off sale because its
 * connector had a bad night.
 *
 * So this gate is deliberately NARROW, and every member of it is a fact about
 * whether this seller may sell RIGHT NOW that no existing gate already answers:
 *
 *  - an operator has held the store;
 *  - the merchant has paused its own checkout;
 *  - the marketplace fee schedule in force has not been accepted (#88's gate,
 *    deferred to #85 — a commission is a binding commercial term, and a checkout
 *    that charged one nobody agreed to is what acceptance asks about).
 *
 * Payment readiness is `assertSellerGroupsPaymentReady`'s and stays there;
 * listing status, stock and moderation are the cart's and the offer projection's.
 * Duplicating any of them here would be a second answer to a settled question.
 *
 * ## It reads TWO rows per store, and that is why it is a separate reader
 *
 * `deriveMerchantActivation` reads eleven tables. Calling it here would put a
 * channel-readiness derivation, an order count and a store-member scan on the
 * checkout path to answer three questions that need one settings row and one
 * acceptance row. So this reads narrowly — and calls the SAME pure predicates
 * the full registry calls, so the dashboard and the gate cannot disagree about
 * what "paused" or "not accepted" means. One definition, two callers, which is
 * the shape #88 already uses for the fee arithmetic itself.
 *
 * ## The fee schedule is the one CHECKOUT selected
 *
 * Not one this module selected again. Checkout has already run
 * `selectFeeSchedule` for every group at step 4f, in the presentment currency
 * the order will actually snapshot — so asking here would be a second selection
 * that could pick a different version, and the acceptance would then be checked
 * against a schedule the order does not use.
 *
 * ## ONE reason code for three levers
 *
 * `seller_not_activated`, the `guest_rollout_blocked` decision applied to the
 * authenticated path. A buyer cannot act on which of the three fired, and a
 * client able to vary one input at a time could read out whether a particular
 * merchant is under an operator hold — which is a moderation fact about somebody
 * else's business. Which lever fired goes to the log line and the operator trace.
 *
 * ## A deployment that has published no fee schedule is unaffected
 *
 * No applicable schedule is #88's honest zero and the predicate reads it as
 * satisfied. So on today's configuration this gate refuses only a store somebody
 * deliberately paused or held.
 */

import { getDb } from '../../db/postgres.js';
import { findFeeScheduleAcceptance } from '../../db/fees/feeScheduleRepository.js';
import { readMerchantActivationSettings } from '../../db/merchantActivation/activationSettingsRepository.js';
import { log } from '../../lib/logger.js';
import { checkoutRefusal } from '../checkout/refusal.js';
import {
  deriveFeeScheduleAccepted,
  deriveNativeCheckoutNotPaused,
  deriveNoPlatformHold,
} from './requirements.js';

/** One seller group, with the fee schedule checkout selected for it. */
export interface ActivationGateGroup {
  /** `store:<id>` or `user:<id>` — the key the client deselects by. */
  readonly sellerKey: string;
  /**
   * The schedule this group's order will snapshot, or `undefined` when none
   * applies. Passed IN rather than selected here — see the module docblock.
   */
  readonly feeSchedule?: { readonly scheduleKey: string; readonly version: number };
}

/**
 * Refuse a checkout whose seller may not currently sell.
 *
 * Runs for BOTH actor kinds — an activation hold is not a guest concept — and
 * BEFORE any reservation, for the reason every gate around it runs there: a
 * question this deployment's own state answers must never have taken stock.
 *
 * Only `store:` groups are examined. An individual seller has no store, no fee
 * acceptance row and no pause switch; guest P2P is refused earlier by #112, and
 * an authenticated P2P sale is governed by the seller's own payment readiness.
 */
export async function assertSellerGroupsActivated(
  groups: readonly ActivationGateGroup[],
): Promise<void> {
  const stores = groups.flatMap((group) => {
    if (!group.sellerKey.startsWith('store:')) return [];
    const storeId = group.sellerKey.slice('store:'.length);
    return storeId.length > 0 ? [{ ...group, storeId }] : [];
  });
  if (stores.length === 0) return;

  const refused: { sellerKey: string; reasons: string[] }[] = [];
  for (const group of stores) {
    const settings = await readMerchantActivationSettings(group.storeId);
    const acceptance = group.feeSchedule
      ? await findFeeScheduleAcceptance(getDb(), {
          ownerType: 'store',
          ownerId: group.storeId,
          scheduleKey: group.feeSchedule.scheduleKey,
          scheduleVersion: group.feeSchedule.version,
        })
      : undefined;

    const outcomes = [
      deriveNoPlatformHold(settings),
      deriveNativeCheckoutNotPaused(settings),
      deriveFeeScheduleAccepted({
        applicableFeeSchedule: group.feeSchedule ?? null,
        // Selection already answered with the schedule this order will use, so
        // an acceptance found against it IS the current version. The two flags
        // stay separate because the shared predicate serves the merchant surface
        // too, where the schedule can move between the two reads.
        feeScheduleAccepted: acceptance !== undefined,
        feeScheduleAcceptedVersionCurrent: acceptance !== undefined,
      }),
    ];
    const reasons = outcomes.flatMap((outcome) =>
      outcome.state === 'satisfied' ? [] : [outcome.reason],
    );
    if (reasons.length > 0) refused.push({ sellerKey: group.sellerKey, reasons });
  }
  if (refused.length === 0) return;

  log.general.warn(
    { refused },
    '[Activation] checkout refused: a seller is not currently activated',
  );
  throw checkoutRefusal(
    'seller_not_activated',
    'One of the sellers in this order is not currently accepting orders. ' +
      'Remove it to check out with the rest.',
  );
}
