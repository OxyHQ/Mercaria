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
 * ## ONE reason code for three levers, and the seller NAMED
 *
 * `seller_not_activated`, the `guest_rollout_blocked` decision applied to the
 * authenticated path. A buyer cannot act on which of the three fired, and a
 * client able to vary one input at a time could read out whether a particular
 * merchant is under an operator hold — which is a moderation fact about somebody
 * else's business. Which lever fired goes to the log line and the operator trace.
 *
 * WHICH seller is refused is the buyer's to know, because their remedy is to
 * deselect it: the message names each one by its public name (the store's name,
 * a private seller's Oxy display name — `nameRefusedSellers`, the same reader
 * the payment-readiness refusal uses), and the keys ride `details.sellers`, never
 * the sentence. Naming the seller says nothing about the lever.
 *
 * ## A deployment that has published no fee schedule is unaffected
 *
 * No applicable schedule is #88's honest zero and the predicate reads it as
 * satisfied. So on today's configuration this gate refuses only a store somebody
 * deliberately paused or held.
 *
 * ## Both owner kinds, and why the P2P half is acceptance ONLY
 *
 * A schedule's scope is `eligible_seller_type`, whose values are `store`,
 * `user`, and ABSENT meaning both. So `planConnectedMarketplaceFee` selects for
 * a `user` seller exactly as it does for a store, calculates the fee, and
 * snapshots it with `termsVersionAccepted` absent — and until this gate read
 * `user:` groups, nothing refused that sale. A commission charged to somebody
 * who was never offered the terms is precisely what #88's acceptance gate
 * exists to prevent, and the scope that reaches them is the DEFAULT one.
 *
 * An individual seller has no `merchant_activation_settings` row, so the hold
 * and pause levers are store-only and are not evaluated for them — that is a
 * fact about the schema, not a lenience: there is no P2P hold to miss.
 *
 * **This gate refuses; it is not the acceptance surface.** A private seller
 * accepts on the storefront's Settings → Payments (`/seller/fees/accept`), a
 * store on the dashboard's Settings → Marketplace fees
 * (`/admin/stores/:storeId/fees/accept`); both write `fee_schedule_acceptances`
 * through the same handler, and both select in the card rail's currencies, so
 * the version a seller accepted is the version this gate is handed (ADR 0018
 * D3). `POST /seller/activation/policies` writes
 * `merchant_activation_policy_acceptances`, a different table.
 */

import type { RefusedCheckoutSeller } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { findFeeScheduleAcceptance } from '../../db/fees/feeScheduleRepository.js';
import { readMerchantActivationSettings } from '../../db/merchantActivation/activationSettingsRepository.js';
import { log } from '../../lib/logger.js';
import { checkoutRefusal } from '../checkout/refusal.js';
import { nameRefusedSellers } from '../payments/provider-account.service.js';
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
 * Examines `store:` and `user:` groups, with different requirement sets: see
 * the module docblock for why the P2P half is fee acceptance only.
 */
export async function assertSellerGroupsActivated(
  groups: readonly ActivationGateGroup[],
): Promise<void> {
  const owners = groups.flatMap((group) => {
    for (const ownerType of ['store', 'user'] as const) {
      const prefix = `${ownerType}:`;
      if (!group.sellerKey.startsWith(prefix)) continue;
      const ownerId = group.sellerKey.slice(prefix.length);
      return ownerId.length > 0 ? [{ ...group, ownerType, ownerId }] : [];
    }
    return [];
  });
  if (owners.length === 0) return;

  const refused: { sellerKey: string; reasons: string[] }[] = [];
  for (const group of owners) {
    const acceptance = group.feeSchedule
      ? await findFeeScheduleAcceptance(getDb(), {
          ownerType: group.ownerType,
          ownerId: group.ownerId,
          scheduleKey: group.feeSchedule.scheduleKey,
          scheduleVersion: group.feeSchedule.version,
        })
      : undefined;

    const outcomes = [
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

    // The hold and the pause are settings on a STORE row. Reading them for an
    // individual seller would be a lookup by a store id that does not exist,
    // and `readMerchantActivationSettings` answers its UNWRITTEN default for
    // any id it does not find — so an unconditional read would not throw, it
    // would silently evaluate a person against a store's defaults.
    if (group.ownerType === 'store') {
      const settings = await readMerchantActivationSettings(group.ownerId);
      outcomes.push(deriveNoPlatformHold(settings), deriveNativeCheckoutNotPaused(settings));
    }

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
  const sellers = await nameRefusedSellers(refused.map((group) => group.sellerKey));
  throw checkoutRefusal('seller_not_activated', sellersNotActivatedMessage(sellers), {
    reason: 'seller_not_activated',
    sellers,
  });
}

/** The English refusal sentence. Clients localize it from `details`; this is the fallback. */
function sellersNotActivatedMessage(sellers: readonly RefusedCheckoutSeller[]): string {
  if (sellers.length === 1) {
    return (
      `${sellers[0]?.name ?? 'A seller'} is not accepting orders right now. ` +
      'Remove their items from your order to check out with the rest.'
    );
  }
  const names = sellers.map((seller) => seller.name ?? 'a seller');
  const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names);
  return (
    `These sellers are not accepting orders right now: ${list}. ` +
    'Remove their items from your order to check out with the rest.'
  );
}
