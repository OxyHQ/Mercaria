/**
 * Everything the activation derivation reads — #85's "authoritative subsystem
 * state, not a checklist the client can mark complete".
 *
 * This is the ONE module in the domain that touches a database or a
 * configuration, and the split is the same one #112 made between `facts.ts` and
 * `eligibility.ts`: keeping the reads here is what lets `requirements.ts` be
 * pure and testable over a plain object, and what makes "the derivation cannot
 * reach a table" a fact a scanned gate can check rather than a habit.
 *
 * ## It DEFAULTS NOTHING
 *
 * Every field below is a fact somebody stated or a fact this deployment can
 * observe. Where a row is absent, the ABSENCE is the fact and it is recorded as
 * such (`merchant: null`, `applicableFeeSchedule: null`) rather than being
 * smoothed into a value the derivation would then read as a yes.
 *
 * The one exception is `merchant_activation_settings`, and it is not a
 * smoothing: a store with no row has made no decisions, which is exactly what
 * `enabled`/`enabled`/no hold/no contact says. Minting the row on a READ would
 * make "how many stores have started activation" unanswerable and would write on
 * a path that must not write — a checkout reads this.
 */

import { and, count, eq, inArray } from 'drizzle-orm';
import type { ChannelReadiness, CurrencyCode, MerchantActivationPolicyKey } from '@mercaria/shared-types';
import { MERCHANT_ACTIVATION_POLICIES } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { findActiveLinkByStore } from '../../db/commerce-graph/nativeStoreLinkRepository.js';
import { findMerchantById } from '../../db/commerce-graph/merchantRepository.js';
import { findFeeScheduleAcceptance } from '../../db/fees/feeScheduleRepository.js';
import {
  listPolicyAcceptancesForOwner,
  type MerchantActivationPolicyAcceptanceRow,
} from '../../db/merchantActivation/policyAcceptanceRepository.js';
import {
  readMerchantActivationSettings,
  type MerchantActivationSettingsFacts,
} from '../../db/merchantActivation/activationSettingsRepository.js';
import { listStorePickupLocations } from '../../db/pickup/nearbyRepository.js';
import { orders } from '../../db/schema/orders.js';
import { storeMembers } from '../../db/schema/stores.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import { deriveChannelReadiness } from '../channels/channel-readiness.js';
import { locationCollectionBlockers } from '../pickup/eligibility.js';
import { findApplicableSchedule } from '../fees/order-fees.service.js';
import { isSellerPaymentReady } from '../payments/provider-account.service.js';
import { hasGuestMessageTransport } from '../guest-portal/transport.js';

/** The store columns activation reads. Named explicitly — a store row is wide. */
export interface ActivationStoreFacts {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly defaultCurrency: CurrencyCode;
  readonly policiesRefundPolicy: string | null;
  readonly policiesPrivacyPolicy: string | null;
}

/** What a policy acceptance says at derivation time. */
export interface ActivationPolicyFact {
  readonly policyVersion: string;
  readonly acceptedByOxyUserId: string;
  readonly acceptedAt: Date;
  /** Whether the accepted version is the one currently published. */
  readonly current: boolean;
}

/**
 * The per-mode half — what each fulfilment mode needs, asked one mode at a time.
 *
 * Both capabilities that name a mode (`shipping_checkout`, `pickup_checkout`)
 * read only from here. That is the correction: they used to share
 * `guest_fulfilment_deterministic`, which answers "is there at least one
 * priceable, unblocked method" and therefore answers the SAME thing for both —
 * so `pickup_checkout` was granted on every deployment with a shipping rate
 * configured, including every deployment with `STORE_PICKUP_ENABLED` off, and
 * withheld from a store whose only remaining method was collection.
 */
export interface ActivationFulfilmentFacts {
  /**
   * Priceable methods that put goods in transit — everything but `pickup`.
   *
   * A deployment fact and not a store one, and stated as such: Moovo owns
   * per-store shipping serviceability (#155/#160) and this repository holds
   * only the seam, so the strongest thing that can honestly be said here is
   * whether a shipping method can be priced at all.
   */
  readonly shippingMethods: readonly string[];
  /** `STORE_PICKUP_ENABLED` — whether a checkout may resolve a collection at all. */
  readonly storePickupEnabled: boolean;
  /** `GUEST_STORE_PICKUP_ENABLED`, which additionally requires the store lever. */
  readonly guestPickupEnabled: boolean;
  /**
   * How many of THIS store's publications a shopper could collect from.
   *
   * Derived through #93's own `locationCollectionBlockers`, so this domain
   * holds no second spelling of what "collectable" means. It is the location
   * half only — a count above zero says the store has somewhere to collect
   * from, never that any particular item can be collected now.
   */
  readonly collectableLocationCount: number;
}

/** The guest half, which #85 insists is asked separately. */
export interface ActivationGuestFacts {
  readonly commerceEnabled: boolean;
  readonly cartEnabled: boolean;
  readonly inlineDestinationEnabled: boolean;
  readonly presentmentCurrencies: readonly CurrencyCode[];
  readonly paymentMethods: readonly string[];
  readonly markets: readonly string[];
  readonly blockedMarkets: readonly string[];
  readonly fulfilmentMethods: readonly string[];
  readonly sellerBlockedByOperator: boolean;
  readonly transactionalTransportConfigured: boolean;
  readonly buyerRequestsEnabled: boolean;
}

/** Everything `requirements.ts` is allowed to see. */
export interface MerchantActivationFacts {
  readonly store: ActivationStoreFacts;
  readonly settings: MerchantActivationSettingsFacts;
  readonly merchant: { readonly id: string; readonly claimState: string } | null;
  readonly channelReadiness: ChannelReadiness;
  readonly railEnabled: boolean;
  readonly paymentsReady: boolean;
  readonly presentmentCurrencies: readonly CurrencyCode[];
  readonly paymentMethods: readonly string[];
  readonly markets: readonly string[];
  readonly fulfilmentMethods: readonly string[];
  readonly applicableFeeSchedule: { readonly scheduleKey: string; readonly version: number } | null;
  readonly feeScheduleAccepted: boolean;
  readonly feeScheduleAcceptedVersionCurrent: boolean;
  readonly acceptedPolicies: Partial<Record<MerchantActivationPolicyKey, ActivationPolicyFact>>;
  readonly completedOrderCount: number;
  readonly refundPermissionAssigned: boolean;
  readonly buyerDataPermissionAssigned: boolean;
  readonly fulfilment: ActivationFulfilmentFacts;
  readonly guest: ActivationGuestFacts;
  /**
   * Whether the NATIVE conjunction holds — the one fact the guest registry's
   * first member reads.
   *
   * Computed by the composer and handed back in, rather than by
   * `requirements.ts` calling itself: a derivation that recurses into its own
   * registry is one whose answer depends on evaluation order, and the guest
   * half would then be sensitive to where in the record the native members sit.
   */
  readonly nativeSatisfied: boolean;
}

/**
 * Read every fact for one store, EXCEPT `nativeSatisfied`, which the composer
 * supplies after running the native half.
 */
export type MerchantActivationFactsWithoutNative = Omit<MerchantActivationFacts, 'nativeSatisfied'>;

/**
 * Read the facts.
 *
 * Every read is live and nothing is cached, for `deriveChannelReadiness`'
 * reason: the cost of a stale answer is asymmetric. A merchant told they cannot
 * sell when they can loses a minute and refreshes; a merchant told they CAN sell
 * when they cannot takes orders whose money has nowhere to go.
 */
export async function readMerchantActivationFacts(
  storeId: string,
): Promise<MerchantActivationFactsWithoutNative | null> {
  const store = await findStoreById(storeId);
  if (!store) return null;

  const sellerKey = `store:${storeId}`;
  const [
    settings,
    link,
    channelReadiness,
    paymentsReady,
    acceptanceRows,
    completedOrderCount,
    memberPermissions,
    pickupLocations,
  ] = await Promise.all([
    readMerchantActivationSettings(storeId),
    findActiveLinkByStore(getDb(), storeId),
    deriveChannelReadiness(storeId),
    isSellerPaymentReady(sellerKey),
    listPolicyAcceptancesForOwner({ ownerType: 'store', ownerId: storeId }),
    countCompletedOrders(storeId),
    readStorePermissionCoverage(storeId),
    listStorePickupLocations(storeId),
  ]);

  const merchant = link ? await findMerchantById(getDb(), link.merchantId) : undefined;

  // #88's schedule selection, run for THIS store's seller type and settlement
  // currency. No applicable schedule is the honest zero and is not a failure.
  const schedule = await findApplicableSchedule({
    sellerType: 'store',
    currency: store.defaultCurrency as CurrencyCode,
  });
  const acceptance = schedule
    ? await findFeeScheduleAcceptance(getDb(), {
        ownerType: 'store',
        ownerId: storeId,
        scheduleKey: schedule.scheduleKey,
        scheduleVersion: schedule.version,
      })
    : undefined;

  const stripe = config.payments.stripe;
  const priceableMethods = Object.entries(config.orders.shippingRates)
    .filter(([, rate]) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0)
    .map(([method]) => method);
  const rollout = config.guest.checkoutRollout;
  const pickup = config.pickup;
  const collectableLocationCount = pickupLocations.filter(
    (location) => locationCollectionBlockers(location).length === 0,
  ).length;
  const fulfilment: ActivationFulfilmentFacts = {
    shippingMethods: priceableMethods.filter((method) => method !== PICKUP_METHOD),
    storePickupEnabled: pickup.storePickupEnabled,
    guestPickupEnabled: pickup.guestPickupEnabled,
    collectableLocationCount,
  };
  const guestFulfilmentMethods = deriveGuestFulfilmentMethods({
    priceableMethods,
    blockedFulfilmentMethods: rollout.blockedFulfilmentMethods,
    fulfilment,
  });

  return {
    store: {
      id: store.id,
      name: store.name,
      description: store.description,
      status: store.status,
      defaultCurrency: store.defaultCurrency as CurrencyCode,
      policiesRefundPolicy: store.policiesRefundPolicy ?? null,
      policiesPrivacyPolicy: store.policiesPrivacyPolicy ?? null,
    },
    settings,
    merchant: merchant ? { id: merchant.id, claimState: merchant.claimState } : null,
    channelReadiness,
    railEnabled: stripe.enabled,
    paymentsReady,
    presentmentCurrencies: stripe.presentmentCurrencies,
    paymentMethods: stripe.enabled ? stripe.paymentSurfaceMethods : [],
    markets: config.checkout.destinationCountries,
    fulfilmentMethods: priceableMethods,
    applicableFeeSchedule: schedule
      ? { scheduleKey: schedule.scheduleKey, version: schedule.version }
      : null,
    feeScheduleAccepted: acceptance !== undefined,
    // Selection already answered with the CURRENT applicable schedule, so an
    // acceptance found against it is by construction the current version. The
    // field stays separate because #88 can supersede a schedule between the two
    // reads, and collapsing them would make that race read as "accepted".
    feeScheduleAcceptedVersionCurrent:
      acceptance !== undefined && schedule !== undefined && acceptance.scheduleVersion === schedule.version,
    acceptedPolicies: indexAcceptances(acceptanceRows),
    completedOrderCount,
    refundPermissionAssigned: memberPermissions.refunds,
    buyerDataPermissionAssigned: memberPermissions.buyerData,
    fulfilment,
    guest: {
      commerceEnabled: config.guest.enabled,
      cartEnabled: config.guest.cartEnabled,
      inlineDestinationEnabled: config.guest.inlineDestinationEnabled,
      presentmentCurrencies: stripe.enabled ? stripe.presentmentCurrencies : [],
      paymentMethods: stripe.enabled ? stripe.paymentSurfaceMethods : [],
      markets: config.checkout.destinationCountries,
      blockedMarkets: rollout.blockedMarkets,
      fulfilmentMethods: guestFulfilmentMethods,
      sellerBlockedByOperator: rollout.blockedSellerKeys.includes(sellerKey),
      transactionalTransportConfigured: hasGuestMessageTransport(),
      buyerRequestsEnabled: config.buyerRequests.requestsEnabled,
    },
  };
}

/** The one fulfilment method that is a COLLECTION rather than a carriage. */
const PICKUP_METHOD = 'pickup';

/**
 * Which fulfilment methods a GUEST of this store may actually be offered.
 *
 * Pure and exported so it can be exercised over every combination, because the
 * defect it replaces was a wrong ANSWER rather than a crash and only a case
 * asserting the wrong answer is not returned can catch its return.
 *
 * Pickup used to be struck out unconditionally, on the premise that "#93
 * publishes no collection state and every pickup is refused at checkout". #93
 * landed: `assertPickupLocationEligible` is gone and `resolvePickupForCheckout`
 * refuses only what the levers and the publications say to refuse. So the
 * exclusion became a wrong answer in the direction that costs a merchant a
 * sale — and, with `GUEST_SELLER_ACTIVATION_REQUIRED` on, a CIRCULAR one: a
 * store whose only guest-capable fulfilment is collection read
 * `guest_fulfilment_method_blocked`, which withheld its guest activation, which
 * `derivePickupEligibility` then read back as `guest_seller_not_activated`.
 *
 * The three pickup conjuncts are what #93's own guest branch requires of a
 * DEPLOYMENT and a STORE. The per-REQUEST half — this item's stock, this
 * location's opening hours, the listing's status — is not answerable about a
 * store and is not answered here; `derivePickupEligibility` owns it and runs
 * when an actual collection is proposed.
 */
export function deriveGuestFulfilmentMethods(input: {
  priceableMethods: readonly string[];
  blockedFulfilmentMethods: readonly string[];
  fulfilment: ActivationFulfilmentFacts;
}): readonly string[] {
  const { fulfilment } = input;
  const guestPickupAvailable =
    fulfilment.storePickupEnabled &&
    fulfilment.guestPickupEnabled &&
    fulfilment.collectableLocationCount > 0;

  return input.priceableMethods.filter(
    (method) =>
      (method !== PICKUP_METHOD || guestPickupAvailable) &&
      !input.blockedFulfilmentMethods.includes(method),
  );
}

/**
 * Turn the acceptance rows into the CURRENT-version answer per policy.
 *
 * Keyed on the policy, holding the NEWEST accepted version, so a seller who
 * accepted v1 and then v2 reads as current and one who accepted only v1 reads as
 * superseded. Comparison is against `MERCHANT_ACTIVATION_POLICIES`, the code
 * constant — which is what makes bumping a version schedule a re-acceptance
 * without touching a row.
 */
function indexAcceptances(
  rows: readonly MerchantActivationPolicyAcceptanceRow[],
): Partial<Record<MerchantActivationPolicyKey, ActivationPolicyFact>> {
  const byPolicy: Partial<Record<MerchantActivationPolicyKey, ActivationPolicyFact>> = {};
  for (const row of rows) {
    const key = row.policyKey as MerchantActivationPolicyKey;
    const published = MERCHANT_ACTIVATION_POLICIES[key];
    if (!published) continue;
    const current = row.policyVersion === published.version;
    const existing = byPolicy[key];
    // A current acceptance always wins; otherwise the most recent one is what
    // the merchant last agreed to.
    if (!existing || (current && !existing.current) || (current === existing.current && row.createdAt > existing.acceptedAt)) {
      byPolicy[key] = {
        policyVersion: row.policyVersion,
        acceptedByOxyUserId: row.acceptedByOxyUserId,
        acceptedAt: row.createdAt,
        current,
      };
    }
  }
  return byPolicy;
}

/**
 * How many orders this store has taken to a state past payment.
 *
 * #85 state 12's test order, and it is deliberately not scoped to a test-mode
 * payment: livemode is DERIVED from the Stripe key's prefix (#48), so an order
 * paid on this deployment's configured rail IS an order paid in the mode this
 * deployment is running in. Counting a stored `livemode` column would be a
 * second answer to what the key already answers.
 */
async function countCompletedOrders(storeId: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(orders)
    .where(
      and(
        eq(orders.storeId, storeId),
        inArray(orders.status, [
          'paid',
          'processing',
          'shipped',
          'delivered',
          'refunded',
          'partially_refunded',
        ]),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Whether ANYBODY on the store holds the permissions a guest order needs
 * somebody to hold — #85 guest 11 and merchant-experience 9.
 *
 * A store whose only member cannot issue a refund can take a guest's money and
 * has nobody able to give it back, which is a real, checkable state and not a
 * hypothetical: `refunds:write` is not in `staff`'s nine.
 *
 * It asks about the STORE and never about a person: no oxy user id is returned,
 * so this cannot become a way to read who works where.
 */
async function readStorePermissionCoverage(
  storeId: string,
): Promise<{ refunds: boolean; buyerData: boolean }> {
  const rows = await getDb()
    .select({ permissions: storeMembers.permissions })
    .from(storeMembers)
    .where(eq(storeMembers.storeId, storeId));
  const held = new Set(rows.flatMap((row) => row.permissions));
  return { refunds: held.has('refunds:write'), buyerData: held.has('orders:read') };
}
