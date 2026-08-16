/**
 * The `mercaria_retail` half of native checkout (#123, ADR 0004 D3/D4/D5).
 *
 * `checkout.service` calls exactly two functions here — {@link partitionRetailLines}
 * and {@link planRetailCheckout} — and imports nothing else from the retail,
 * supplier or procurement domains. That is the same boundary
 * `services/payments/provider-account.service.ts` draws for the card rail, and
 * it is drawn for a stronger reason: the checkout path must not learn what a
 * supplier is, or the supply chain becomes structural to placing an order and a
 * marketplace-only deployment starts carrying it.
 *
 * ## What this file refuses to do, and why each refusal is structural
 *
 * **It cannot price anything.** Every amount it returns comes from a #120 quote
 * that #120 composed, gated and hashed; there is no arithmetic here that could
 * add to one. The customer total is the LOCKED total, read back from the
 * acceptance row — not recomputed, not summed from components, not adjusted.
 *
 * **It cannot reserve local stock.** ADR 0004 D5: there is no `InventoryLevel`
 * for supplier stock and no reservation row, so the reservation step of
 * checkout is a structural no-op for retail lines. `partitionRetailLines`
 * removing them from the group map is HOW that happens — there is no `if` in
 * the reservation loop to delete, because the loop never sees them.
 *
 * **It cannot decide eligibility.** #121 owns that verdict, #122 owns whether
 * the supplier answered, #120 owns whether a cost is complete. This file
 * CONJOINS three answers other domains gave and adds the two nobody else can
 * see (the binding, and the operator's kill switches).
 *
 * ## The conjunction is evaluated per LINE and refuses the whole checkout
 *
 * A cart holding one ineligible retail line is refused entirely rather than
 * partially placed, matching what the rest of checkout already does for an
 * unpriced variant, an unready seller and a stale line: checkout is
 * all-or-nothing (`checkout.service`'s own first paragraph). The buyer's remedy
 * is `sellerKeys` — deselect the retail group and place the rest — which is the
 * same remedy a mixed cart with an unready store already has.
 */

import type {
  CurrencyCode,
  Money,
  RetailCheckoutRefusal,
  RetailCostComponentKind,
  RetailCustomerType,
  RetailFulfilmentMethod,
  ShippingMethod,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findLiveRetailBindingsForVariants,
  type NewRetailProcurementIntent,
  type NewRetailProcurementIntentLine,
  type RetailOfferBindingRecord,
} from '../../db/retailCheckout/retailCheckoutRepository.js';
import { findActiveRetailPricingPolicy } from '../../db/retailPricing/retailPricingPolicyRepository.js';
import { findProcurementOfferById } from '../../db/procurement/procurementOfferRepository.js';
import { log } from '../../lib/logger.js';
import type { CommerceActor } from '../commerce-actor.js';
import { getRetailEligibility } from '../retail-eligibility/retail-eligibility.service.js';
import {
  RETAIL_ELIGIBILITY_POLICY_KEY,
} from '../retail-eligibility/retail-eligibility.service.js';
import { composeRetailCostQuote } from '../retail-pricing/retail-cost-quote.service.js';
import { lockRetailCostQuote } from '../retail-pricing/retail-cost-quote.service.js';
import {
  evaluateRetailPilotAdmission,
  retailPilotAudienceFor,
} from '../retail-pilot/pilot.service.js';
import { assertPreflightSatisfiesCheckout } from '../supplier-preflight/checkout-contract.js';
import { runSupplierPreflight } from '../supplier-preflight/preflight.service.js';
import { SUPPLIER_SOURCING_POLICY_KEY } from '../supplier-preflight/preflight.service.js';
import { getDb } from '../../db/postgres.js';
import { checkoutRefusal } from './refusal.js';

/**
 * The #120 pricing policy native retail checkout prices under.
 *
 * A CODE CONSTANT, matching `RETAIL_ELIGIBILITY_POLICY_KEY` and
 * `SUPPLIER_SOURCING_POLICY_KEY` and for the identical reason
 * (`CROWDSOURCE_APP_ID`'s): which policy governs Mercaria's own retail sales is
 * not a per-deployment choice, and an environment variable holding it could
 * only ever disagree with the quotes that cite it. Changing the policy is
 * publishing a NEW VERSION under this key, which is #120's operator surface.
 *
 * #120 deliberately left the key caller-supplied — a policy repository should
 * not have an opinion about who its callers are — so naming it is #123's, as
 * the first caller that prices a real buyer.
 */
export const RETAIL_CHECKOUT_PRICING_POLICY_KEY = 'mercaria-retail-pricing';

/**
 * One cart line that a live binding makes a Mercaria-retail line.
 *
 * The BINDING is what makes it retail, and nothing else. Not the listing's
 * owner (a retail item's catalogue row is an ordinary listing), not a flag on
 * the variant, not the presence of a procurement offer for the same canonical
 * variant — that last one is the tempting inference and it is wrong: a P2P
 * seller may well be selling the same model a supplier carries, and reading
 * that as "Mercaria sells this" would reclassify somebody else's sale.
 */
/**
 * The seller key every retail line is grouped under.
 *
 * ONE key for the whole retail order, because Mercaria is ONE seller (ADR 0004
 * D5) however many suppliers the lines come from. Multi-supplier splitting
 * happens at the PurchaseOrder grain, under this single order — which is what
 * keeps ADR 0001's one-PaymentIntent-per-group invariant intact on a mixed
 * cart.
 *
 * It is in the same namespace as `store:<id>` and `user:<id>` so `sellerKeys`
 * (per-seller checkout) works unchanged: a buyer with a mixed cart deselects
 * `platform` exactly as they would deselect a store.
 *
 * It lives HERE rather than in `checkout.service` because the CART now names it
 * too (#129 gives each group the key its own checkout would take), and two
 * spellings of one key would disagree in the direction that matters: a cart
 * button sending `platform:` or `mercaria` reaches checkout as "no matching
 * cart items" and a buyer with only Mercaria-sold items cannot pay at all.
 */
export const RETAIL_SELLER_KEY = 'platform';

export interface RetailCheckoutLine<TLine> {
  line: TLine;
  variantId: string;
  quantity: number;
  binding: RetailOfferBindingRecord;
}

/** The retail and non-retail halves of one cart. */
export interface RetailPartition<TLine> {
  retail: RetailCheckoutLine<TLine>[];
  remaining: TLine[];
}

/**
 * Split resolved cart lines into the ones Mercaria sells itself and the rest.
 *
 * Pure of policy: it asks only which variants carry a LIVE binding. Everything
 * about whether those lines may be bought is {@link planRetailCheckout}'s, and
 * the split is separate so that a deployment with the retail flag off still
 * knows a line is retail — which is what lets it be refused by name instead of
 * silently checked out as a marketplace sale from whoever happens to own the
 * listing row.
 */
export async function partitionRetailLines<TLine>(
  lines: readonly TLine[],
  read: (line: TLine) => { variantId: string; quantity: number },
  db?: DatabaseOrTransaction,
): Promise<RetailPartition<TLine>> {
  const facts = lines.map((line) => ({ line, ...read(line) }));
  const bindings = await findLiveRetailBindingsForVariants(
    [...new Set(facts.map((fact) => fact.variantId))],
    db,
  );
  const retail: RetailCheckoutLine<TLine>[] = [];
  const remaining: TLine[] = [];
  for (const fact of facts) {
    const binding = bindings.get(fact.variantId);
    if (binding) {
      retail.push({ line: fact.line, variantId: fact.variantId, quantity: fact.quantity, binding });
    } else {
      remaining.push(fact.line);
    }
  }
  return { retail, remaining };
}

/** Everything one retail plan needs from the checkout it belongs to. */
export interface PlanRetailCheckoutInput<TLine> {
  actor: CommerceActor;
  checkoutGroupId: string;
  lines: readonly RetailCheckoutLine<TLine>[];
  destination: { country: string; region?: string };
  /** The buyer's presentment currency — what every locked total is denominated in. */
  presentmentCurrency: CurrencyCode;
  shippingMethod: ShippingMethod;
  now?: Date;
  db?: DatabaseOrTransaction;
}

/** One priced, locked retail line, ready to become an order item. */
export interface PlannedRetailLine<TLine> {
  line: TLine;
  binding: RetailOfferBindingRecord;
  quantity: number;
  /** The LOCKED customer amount for this line, presentment side. Never recomputed. */
  lockedTotal: Money;
  acceptanceId: string;
  quoteId: string;
  supplierQuoteRef: string | null;
  supplierSku: string;
  /**
   * The SUPPLIER's own shipping service, as #122's quote selected it.
   *
   * Carried so #125's pilot can bound which services it permits. Deliberately
   * the supplier's code and not Mercaria's `ShippingMethod`: the pilot's bound
   * is "supported shipping services only", and `standard` is not a service — it
   * is Mercaria's word for whichever one the supplier happened to choose.
   */
  supplierShippingServiceCode: string | null;
  canonicalProductId: string | null;
  canonicalVariantId: string | null;
  supplierUnitCost: Money;
  supplierLineTotal: Money;
  /**
   * The shipping and tax SHARES of this line's locked total, presentment side.
   *
   * Read off the quote's own component rows rather than computed, and carried
   * so the retail order's `totals` decompose the way every other order's do —
   * a receipt reading "tax: 0" on an order that plainly paid VAT is a document
   * a buyer cannot reconcile and a tax authority would ask about.
   *
   * `subtotal` is deliberately NOT carried: it is the locked total minus these
   * two, so there is exactly one figure that is authoritative (the lock) and
   * two that are attributions of it. Carrying all three would let them
   * disagree.
   */
  shippingShare: Money;
  taxShare: Money;
  /**
   * The SUPPLIER's stated transit range for this line, from #122's quote
   * (`supplier_quotes.delivery_days_min` / `_max`), or NULL where it stated
   * none.
   *
   * Carried so #126 can record the delivery promise the buyer accepted, in the
   * order's own transaction, from the answer that was actually used to price
   * it — ADR 0004 D9.9's *"derived from the supplier quote's stated service and
   * transit range, snapshotted on the order"*. Re-reading the supplier quote
   * later would not do: #122 purges its own quotes on its own retention
   * schedule, so by the time a buyer asks what they were promised the evidence
   * may be gone.
   *
   * NULL is preserved rather than defaulted, because #126 rule 10 is *"unknown
   * cost/estimate is not zero/on time"* and a zero here would become a promise
   * of same-day delivery.
   */
  deliveryDaysMin: number | null;
  deliveryDaysMax: number | null;
}

/** What checkout builds one `platform` order and its intents from. */
export interface RetailCheckoutPlan<TLine> {
  lines: PlannedRetailLine<TLine>[];
  /** The order's grand total, presentment side: the exact sum of the locks. */
  lockedTotal: Money;
  /** One per supplier, ready for `insertRetailProcurementIntents` bar the order id. */
  intents: readonly Omit<NewRetailProcurementIntent, 'orderId'>[];
}

/**
 * The fulfilment method #121 is asked about.
 *
 * `pickup` has no retail meaning — a supplier ships to the buyer's address and
 * there is nothing to collect from. Mapping it explicitly rather than casting
 * is what keeps that a compile-time fact instead of a coincidence.
 *
 * What makes a retail line reach here on a shipping method is NO LONGER the #93
 * seam, which is filled: `assertSellerGroupsAcceptDestination` now accepts an
 * all-collection order and delegates to `resolvePickupForCheckout`. It is that
 * `MERCARIA_RETAIL_ENABLED` and `STORE_PICKUP_ENABLED` both default off, so the
 * combination has no deployment. That is a LEVER pair rather than a structural
 * bar, which is exactly why the `pickup` branch below throws.
 */
function retailFulfilmentMethod(method: ShippingMethod): RetailFulfilmentMethod {
  switch (method) {
    case 'standard':
      return 'standard_delivery';
    case 'express':
      return 'expedited_delivery';
    case 'pickup':
      // Unreachable only while retail and store pickup are not both enabled.
      // A throw rather than a fallback: a deployment that turned both on would
      // fail loudly here rather than quietly telling #121 that a supplier ships
      // parcels a buyer is going to collect.
      throw checkoutRefusal(
        'retail_line_ineligible',
        'This item cannot be collected in person. Choose delivery, or remove it to continue.',
      );
  }
}

/** The one sentence a buyer ever reads for any of the ten conditions. */
const REFUSAL_MESSAGE =
  'One of the items in your basket is not available to order right now. Remove it, or try ' +
  'again later.';

/**
 * Refuse, recording WHICH condition fired where a reader is already authorized.
 *
 * The buyer's message names none of them (see `refusal.ts`'s note on this
 * reason). The log line does, with the binding row id and never a supplier
 * name, a stock figure or a cost — an operator tracing a refusal opens from the
 * binding and reaches everything from there.
 */
function refuseRetail(reason: RetailCheckoutRefusal, bindingId: string): never {
  log.general.info({ reason, bindingId }, '[Retail] checkout refused a retail line');
  throw checkoutRefusal('retail_line_ineligible', REFUSAL_MESSAGE);
}

/**
 * Price, gate and lock every retail line — the whole of #123's "offer and cart
 * eligibility" and steps 5–8 of its checkout decomposition.
 *
 * The order of the checks is deliberate and matches the rest of checkout's:
 * everything answerable from configuration and already-loaded rows runs BEFORE
 * anything that calls a supplier, so a refused checkout never spends a provider
 * call — the reasoning 4c–4f in `checkout.service` already applies to stock.
 *
 *  1. the kill switches and the flag (configuration only);
 *  2. the binding's own supply side (one indexed read per line);
 *  3. #121's verdict (reads eleven tables, calls nobody);
 *  4. #122's preflight (the first thing that talks to a supplier);
 *  5. #122's `assertPreflightSatisfiesCheckout` re-validation;
 *  6. #120's compose, which fails closed on an unknown cost;
 *  7. #120's lock, which is idempotent on `(checkoutGroupId, quoteId)`.
 *
 * Step 7 is what makes a retry converge: `lockRetailCostQuote` re-validates and
 * then upserts the acceptance, so a second attempt under the same
 * `Idempotency-Key` — which reuses the same `checkoutGroupId` only when it
 * converges, and mints a fresh one when it does not — reads the locked total
 * back rather than re-pricing. A genuinely new attempt gets a new group and a
 * new quote, which is correct: it is a new offer to the buyer.
 */
export async function planRetailCheckout<TLine>(
  input: PlanRetailCheckoutInput<TLine>,
): Promise<RetailCheckoutPlan<TLine>> {
  const now = input.now ?? new Date();
  const destinationCountry = input.destination.country.trim().toUpperCase();

  // 1. Configuration. ONE reason code covers the flag and both block lists, so
  // a client cannot map the switchboard one input at a time.
  const [first] = input.lines;
  if (!first) {
    throw new Error('planRetailCheckout was called with no retail lines');
  }
  if (!config.retail.enabled) refuseRetail('retail_disabled', first.binding.id);
  if (config.retail.blockedMarkets.includes(destinationCountry)) {
    refuseRetail('retail_disabled', first.binding.id);
  }
  // ADR 0001 D8's presentment set. Checked here as well as in
  // `assertCheckoutCurrencyEligible` because a retail line's cost quote is
  // composed IN this currency and an unchargeable one would produce a locked
  // amount nobody can pay.
  if (
    config.payments.stripe.enabled &&
    !config.payments.stripe.presentmentCurrencies.includes(input.presentmentCurrency)
  ) {
    refuseRetail('currency_unsupported', first.binding.id);
  }

  const fulfilmentMethod = retailFulfilmentMethod(input.shippingMethod);
  // `consumer` for BOTH actor kinds, and the absence of a distinction is ADR
  // 0006 G8's "guest status cannot change the pricing policy, service or
  // fulfilment priority" holding at the one gate that could break it: a
  // `RetailCustomerType` with a guest member would let a policy version scope
  // itself to signed-out buyers, which is exactly the second-class checkout
  // ADR 0003 refuses. The vocabulary has no such member, so it is unwritable.
  const customerType: RetailCustomerType = 'consumer';
  const policy = await findActiveRetailPricingPolicy(input.db ?? getDb(), {
    policyKey: RETAIL_CHECKOUT_PRICING_POLICY_KEY,
    at: now,
  });
  if (!policy) {
    // No active pricing policy means no cost may be composed at all — #120's
    // fail-closed rule, reached before any supplier is troubled.
    refuseRetail('cost_incomplete', first.binding.id);
  }

  const planned: PlannedRetailLine<TLine>[] = [];
  for (const retailLine of input.lines) {
    const { binding } = retailLine;

    if (config.retail.blockedSuppliers.includes(binding.supplierId.toLowerCase())) {
      refuseRetail('retail_disabled', binding.id);
    }
    // #107's guest axes, extended by #123's supplier one. An Oxy buyer skips
    // all of it — a signed-in purchase is never subject to the guest rollout.
    if (
      input.actor.kind === 'guest' &&
      config.guest.checkoutRollout.blockedSuppliers.includes(binding.supplierId.toLowerCase())
    ) {
      refuseRetail('guest_not_eligible', binding.id);
    }

    // 2. The binding's supply side, as it stands right now. A retired offer, a
    // suspended supplier or a withdrawn destination all land here rather than
    // at the supplier's own API.
    const offer = await findProcurementOfferById(binding.procurementOfferId, input.db);
    if (!offer || offer.status !== 'active') refuseRetail('binding_inactive', binding.id);
    if (!offer.eligibleDestinationCountries.includes(destinationCountry)) {
      refuseRetail('destination_unsupported', binding.id);
    }

    // 3. #121's verdict. `unknown` is NOT a soft yes — the two failing verdicts
    // are collapsed into one buyer-facing reason and kept apart in the log.
    const eligibility = await getRetailEligibility(
      {
        procurementOfferId: binding.procurementOfferId,
        channel: 'mercaria_retail',
        destinationCountry,
        currency: input.presentmentCurrency,
        quantity: retailLine.quantity,
        fulfilmentMethod,
        customerType,
        at: now.toISOString(),
      },
      { surface: 'checkout', db: input.db },
    );
    if (eligibility.verdict !== 'eligible') {
      log.general.info(
        { verdict: eligibility.verdict, reasons: eligibility.reasons, bindingId: binding.id },
        '[Retail] eligibility refused a retail line',
      );
      refuseRetail(eligibility.verdict === 'unknown' ? 'not_eligible' : 'blocked', binding.id);
    }

    // 4. The supplier. The FIRST outbound call this gate makes.
    //
    // The idempotency key carries the checkout GROUP and the offer, so two
    // deliveries of one checkout attempt reuse a still-open quote rather than
    // taking a second hold — #122's own policy, driven from here rather than
    // reimplemented.
    const preflight = await runSupplierPreflight({
      procurementOfferId: binding.procurementOfferId,
      quantity: retailLine.quantity,
      destination: {
        country: destinationCountry,
        ...(input.destination.region ? { region: input.destination.region } : {}),
      },
      currency: input.presentmentCurrency,
      checkoutGroupId: input.checkoutGroupId,
      idempotencyKey: `checkout:${input.checkoutGroupId}:${binding.procurementOfferId}`,
      requestReservation: true,
      pricingPolicyKey: policy.policyKey,
      pricingPolicyVersion: policy.version,
      eligibilityPolicyKey: RETAIL_ELIGIBILITY_POLICY_KEY,
      ...(eligibility.policyVersion !== undefined
        ? { eligibilityPolicyVersion: eligibility.policyVersion }
        : {}),
      at: now,
      ...(input.db ? { db: input.db } : {}),
    });

    // 5. #122's own re-validation, called and never reimplemented. It is
    // COMPLETE and waits on nothing (its docblock says so), so the whole of
    // "does this stored answer still answer the question I am about to ask" is
    // one call.
    const satisfied = assertPreflightSatisfiesCheckout(
      {
        quoteId: preflight.quote.id,
        status: preflight.quote.status,
        environment: preflight.quote.environment,
        procurementOfferId: preflight.quote.procurementOfferId,
        quantity: preflight.quote.quantity,
        requestedCurrency: preflight.quote.requestedCurrency as CurrencyCode,
        destinationCountry: preflight.quote.destinationCountry,
        destinationRegion: preflight.quote.destinationRegion,
        expiresAt: preflight.quote.expiresAt,
        consumedAt: preflight.quote.consumedAt,
        releasedAt: preflight.quote.releasedAt,
        supersededByQuoteId: preflight.quote.supersededByQuoteId,
        sourcingPolicyKey: preflight.quote.sourcingPolicyKey,
        sourcingPolicyVersion: preflight.quote.sourcingPolicyVersion,
        pricingPolicyKey: preflight.quote.pricingPolicyKey,
        pricingPolicyVersion: preflight.quote.pricingPolicyVersion,
        eligibilityPolicyKey: preflight.quote.eligibilityPolicyKey,
        eligibilityPolicyVersion: preflight.quote.eligibilityPolicyVersion,
        reservationExpiresAt: preflight.reservation?.providerExpiresAt ?? null,
      },
      {
        environment: preflight.quote.environment,
        procurementOfferId: binding.procurementOfferId,
        quantity: retailLine.quantity,
        currency: input.presentmentCurrency,
        destinationCountry,
        destinationRegion: input.destination.region ?? null,
        sourcingPolicyKey: SUPPLIER_SOURCING_POLICY_KEY,
        sourcingPolicyVersion: preflight.quote.sourcingPolicyVersion,
        pricingPolicyKey: policy.policyKey,
        pricingPolicyVersion: policy.version,
        eligibilityPolicyKey: RETAIL_ELIGIBILITY_POLICY_KEY,
        eligibilityPolicyVersion: eligibility.policyVersion ?? null,
        now,
      },
    );
    if (satisfied.satisfied !== true) {
      log.general.info(
        { refusals: satisfied.refusals, bindingId: binding.id },
        '[Retail] the stored preflight no longer satisfies this checkout',
      );
      refuseRetail('supplier_stock_unknown', binding.id);
    }
    if (preflight.completeness.status !== 'complete') {
      refuseRetail('supplier_stock_unknown', binding.id);
    }
    if (preflight.quote.unitCostAmount === null || preflight.quote.unitCostCurrency === null) {
      // An unknown direct cost is never zero (ADR 0004 D3). Reaching here with
      // a `complete` preflight would be #122 contradicting itself, so this is a
      // belt on a structural guarantee rather than a branch anybody expects.
      refuseRetail('cost_incomplete', binding.id);
    }

    // 6. #120 composes, gates and hashes the cost-only amount. Every figure it
    // receives comes from the preflight quote; nothing here adds a component,
    // and there is no parameter on `composeRetailCostQuote` that could.
    const supplierCurrency = preflight.quote.unitCostCurrency as CurrencyCode;
    const quote = await composeRetailCostQuote(
      {
        policy,
        supplierId: binding.supplierId,
        supplierAccountId: binding.supplierAccountId,
        agreementId: binding.agreementId,
        procurementOfferId: binding.procurementOfferId,
        ...(offer.canonicalProductId ? { canonicalProductId: offer.canonicalProductId } : {}),
        ...(offer.canonicalVariantId ? { canonicalVariantId: offer.canonicalVariantId } : {}),
        supplierSku: offer.supplierSku,
        quantity: retailLine.quantity,
        destination: {
          country: destinationCountry,
          ...(input.destination.region ? { region: input.destination.region } : {}),
        },
        presentmentCurrency: input.presentmentCurrency,
        sourceCosts: composeSourceCosts({
          quote: preflight.quote,
          supplierCurrency,
          observedAt: now,
        }),
        applicableKinds: applicableCostKinds(preflight.quote),
        taxTreatmentDetermined: eligibility.tax !== undefined,
        // #121 supplies `marketSupported` — the seam #120 named, closed here.
        marketSupported: eligibility.verdict === 'eligible',
        now,
      },
      input.db,
    );

    // 7. The lock. Idempotent on `(checkoutGroupId, quoteId)`: a retry READS
    // the locked total rather than re-pricing.
    const { acceptance } = await lockRetailCostQuote(
      {
        quoteId: quote.quote.id,
        checkoutGroupId: input.checkoutGroupId,
        actor:
          input.actor.kind === 'oxy'
            ? { kind: 'oxy', oxyUserId: input.actor.oxyUserId }
            : { kind: 'guest', guestSessionId: guestSessionIdOf(input.actor) },
        now,
      },
      input.db,
    );

    const unitCost: Money = {
      amount: preflight.quote.unitCostAmount,
      currency: supplierCurrency,
    };
    // The presentment-side shares, summed from the components #120 stored —
    // the same rows the locked total is the exact sum of, so the three figures
    // reconcile by construction rather than by a second calculation.
    const shareOf = (kind: RetailCostComponentKind): number =>
      quote.componentDtos
        .filter((component) => component.kind === kind)
        .reduce((sum, component) => sum + component.presentmentAmount.amount, 0);
    planned.push({
      line: retailLine.line,
      binding,
      quantity: retailLine.quantity,
      lockedTotal: {
        amount: acceptance.acceptedTotalAmount,
        currency: acceptance.acceptedTotalCurrency as CurrencyCode,
      },
      acceptanceId: acceptance.id,
      quoteId: quote.quote.id,
      supplierQuoteRef: preflight.quote.id,
      supplierSku: offer.supplierSku,
      supplierShippingServiceCode: preflight.quote.selectedShippingServiceCode,
      canonicalProductId: offer.canonicalProductId,
      canonicalVariantId: offer.canonicalVariantId,
      supplierUnitCost: unitCost,
      supplierLineTotal: {
        amount: unitCost.amount * retailLine.quantity,
        currency: supplierCurrency,
      },
      shippingShare: {
        amount: shareOf('destination_shipping'),
        currency: input.presentmentCurrency,
      },
      taxShare: { amount: shareOf('tax_duty'), currency: input.presentmentCurrency },
      deliveryDaysMin: preflight.quote.deliveryDaysMin,
      deliveryDaysMax: preflight.quote.deliveryDaysMax,
    });
  }

  const lockedTotal = sumLockedTotals(planned, input.presentmentCurrency);

  // 8. #125's bounded pilot: is Mercaria willing to do this AT ALL, today.
  //
  // LAST, and after the locks, for one reason that is worth stating because it
  // costs something: the pilot's value ceilings are bounds on the amount a
  // buyer would be charged, and that amount does not exist until #120 has
  // composed and locked it. Every earlier position would need either a second,
  // partial copy of the same rule or a third "provisional" verdict, and #125's
  // whole posture is that a bound with a soft state is not a bound.
  //
  // The cost is real and bounded: a retail line OUTSIDE the pilot has already
  // spent one supplier preflight by the time it is refused. That is acceptable
  // because a retail line exists only where an operator created a
  // `retail_offer_bindings` row (#123), so "a retail line the pilot does not
  // admit" is a configuration mismatch rather than ordinary traffic — and
  // because nothing has been charged, reserved or ordered at this point.
  //
  // Refusing here also refuses the WHOLE checkout rather than one line, which
  // is correct: the locked total this is measured against is the group's.
  for (const line of planned) {
    const admission = await evaluateRetailPilotAdmission(
      {
        supplierId: line.binding.supplierId,
        supplierAccountId: line.binding.supplierAccountId,
        supplierSku: line.supplierSku,
        destinationCountry,
        currency: input.presentmentCurrency,
        quantity: line.quantity,
        lineTotalMinor: line.lockedTotal.amount,
        orderTotalMinor: lockedTotal.amount,
        shippingServiceCode: line.supplierShippingServiceCode,
        audience: retailPilotAudienceFor({
          // Neither is knowable here yet: #125's cohort ladder needs a staff
          // and invite list that no Mercaria surface publishes. Until one
          // does, every buyer counts as `public`, so a cohort narrower than
          // `public` admits NOBODY — which is the fail-closed direction and
          // makes the ladder's narrow rungs a real bound rather than a
          // decorative one.
          isStaff: false,
          isInvited: false,
        }),
        at: now,
      },
      input.db ? { db: input.db } : {},
    );
    if (admission.outcome === 'refused') {
      log.general.info(
        { reason: admission.reason, bindingId: line.binding.id },
        '[Retail] the bounded pilot refused a retail line',
      );
      refuseRetail('retail_disabled', line.binding.id);
    }
  }

  return { lines: planned, lockedTotal, intents: composeIntents(planned, input.checkoutGroupId) };
}

/**
 * A guest actor's session id, narrowed rather than asserted.
 *
 * `CommerceActor` has no common `id` field, so the compiler forces this switch
 * (ADR 0003 I1) — which is the whole reason a guest session id can never reach
 * an `oxyUserId` parameter anywhere in this file.
 */
function guestSessionIdOf(actor: CommerceActor): string {
  if (actor.kind !== 'guest') {
    throw new Error('guestSessionIdOf was called with a non-guest actor');
  }
  return actor.guestSessionId;
}

/**
 * The exact sum of the locked line totals — the retail order's grand total.
 *
 * A SUM of amounts #120 locked, and never a recomputation: this is the one
 * place a markup could be introduced by arithmetic, and the only arithmetic
 * here is addition of figures the buyer has already accepted. The currency
 * guard is not defensive tidiness — locks in two currencies added together
 * would produce a number in neither.
 */
function sumLockedTotals<TLine>(
  lines: readonly PlannedRetailLine<TLine>[],
  presentmentCurrency: CurrencyCode,
): Money {
  let amount = 0;
  for (const line of lines) {
    if (line.lockedTotal.currency !== presentmentCurrency) {
      throw new Error(
        `A retail line locked in ${line.lockedTotal.currency} cannot fund a checkout priced in ` +
          `${presentmentCurrency}.`,
      );
    }
    amount += line.lockedTotal.amount;
  }
  assertSafeMoneyAmount(amount, 'retail.lockedTotal');
  return { amount, currency: presentmentCurrency };
}

/** Group the planned lines into one intent per supplier (ADR 0004 D5). */
function composeIntents<TLine>(
  lines: readonly PlannedRetailLine<TLine>[],
  checkoutGroupId: string,
): readonly Omit<NewRetailProcurementIntent, 'orderId'>[] {
  const bySupplier = new Map<string, PlannedRetailLine<TLine>[]>();
  for (const line of lines) {
    const bucket = bySupplier.get(line.binding.supplierId);
    if (bucket) bucket.push(line);
    else bySupplier.set(line.binding.supplierId, [line]);
  }

  // Sorted by supplier id so the intents — and therefore the outbox rows and
  // the purchase orders derived from them — are composed in the same order on
  // every attempt. The determinism `groupRetailLines` establishes upstream,
  // preserved rather than re-established.
  return [...bySupplier.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([supplierId, supplierLines]) => {
      const [first] = supplierLines;
      if (!first) throw new Error(`Retail intent for supplier ${supplierId} was built with no lines`);
      const supplierCurrency = first.supplierLineTotal.currency;
      let supplierCost = 0;
      let buyerLocked = 0;
      const intentLines: NewRetailProcurementIntentLine[] = [];
      for (const line of supplierLines) {
        if (line.supplierLineTotal.currency !== supplierCurrency) {
          // One supplier billing in two currencies for one order is not
          // something a purchase order can express — #122 groups by currency
          // for exactly this reason, and reaching here means a binding set
          // disagrees with the offers behind it.
          throw new Error(
            `Supplier ${supplierId} priced one order in ${supplierCurrency} and ` +
              `${line.supplierLineTotal.currency}; a purchase order carries one currency.`,
          );
        }
        supplierCost += line.supplierLineTotal.amount;
        buyerLocked += line.lockedTotal.amount;
        intentLines.push({
          procurementOfferId: line.binding.procurementOfferId,
          bindingId: line.binding.id,
          acceptanceId: line.acceptanceId,
          quoteId: line.quoteId,
          ...(line.supplierQuoteRef !== null ? { supplierQuoteRef: line.supplierQuoteRef } : {}),
          supplierSku: line.supplierSku,
          ...(line.canonicalProductId !== null
            ? { canonicalProductId: line.canonicalProductId }
            : {}),
          ...(line.canonicalVariantId !== null
            ? { canonicalVariantId: line.canonicalVariantId }
            : {}),
          quantity: line.quantity,
          supplierUnitCost: line.supplierUnitCost,
          supplierLineTotal: line.supplierLineTotal,
          buyerAcceptedTotal: line.lockedTotal,
        });
      }
      assertSafeMoneyAmount(supplierCost, 'retail.intent.supplierCost');
      assertSafeMoneyAmount(buyerLocked, 'retail.intent.buyerLockedTotal');
      return {
        checkoutGroupId,
        supplierId,
        supplierAccountId: first.binding.supplierAccountId,
        agreementId: first.binding.agreementId,
        supplierCost: { amount: supplierCost, currency: supplierCurrency },
        buyerLockedTotal: { amount: buyerLocked, currency: first.lockedTotal.currency },
        lines: intentLines,
      };
    });
}

/** The preflight-quote columns the cost components are composed from. */
interface PreflightCostFacts {
  id: string;
  unitCostAmount: number | null;
  unitCostCurrency: string | null;
  supplierFeesAmount: number | null;
  shippingCostAmount: number | null;
  taxAmount: number | null;
  dutyAmount: number | null;
}

/**
 * Turn one supplier's answer into #120's source costs.
 *
 * Every component names the PREFLIGHT QUOTE as its evidence, which is what
 * makes the cost auditable back to the supplier's own answer at a stated
 * instant. Absent figures produce NO component rather than a zero one — the
 * whole of ADR 0004 D3's "an unknown direct cost is never zero" on this path,
 * because #120's completeness derivation then reports the missing kind and
 * blocks the quote.
 *
 * `perUnit` is stated per kind and never inferred: the item cost multiplies by
 * the quantity, and shipping, tax and duty are whole-order figures the supplier
 * quoted for this exact basket.
 */
function composeSourceCosts(input: {
  quote: PreflightCostFacts;
  supplierCurrency: CurrencyCode;
  observedAt: Date;
}): ReturnType<typeof buildSourceCosts> {
  return buildSourceCosts(input);
}

function buildSourceCosts(input: {
  quote: PreflightCostFacts;
  supplierCurrency: CurrencyCode;
  observedAt: Date;
}) {
  const base = {
    sourceRef: 'supplier_quote' as const,
    currency: input.supplierCurrency,
    confidence: 'quoted' as const,
    observedAt: input.observedAt,
    supplierQuoteRef: input.quote.id,
  };
  const costs = [];
  if (input.quote.unitCostAmount !== null) {
    costs.push({ ...base, kind: 'supplier_item' as const, amount: input.quote.unitCostAmount, perUnit: true });
  }
  if (input.quote.supplierFeesAmount !== null && input.quote.supplierFeesAmount > 0) {
    costs.push({
      ...base,
      kind: 'supplier_handling' as const,
      amount: input.quote.supplierFeesAmount,
      perUnit: false,
    });
  }
  if (input.quote.shippingCostAmount !== null) {
    costs.push({
      ...base,
      kind: 'destination_shipping' as const,
      amount: input.quote.shippingCostAmount,
      perUnit: false,
    });
  }
  // Tax and duty are ONE component kind in #120's vocabulary, so a supplier
  // that quoted both contributes their sum rather than two rows under one kind
  // — the total is the exact sum of the component rows and two rows of one kind
  // would make the customer total unattributable to a source.
  const taxDuty = (input.quote.taxAmount ?? 0) + (input.quote.dutyAmount ?? 0);
  if (taxDuty > 0) {
    costs.push({ ...base, kind: 'tax_duty' as const, amount: taxDuty, perUnit: false });
  }
  return costs;
}

/**
 * Which cost kinds APPLY to this order, quoted or not — #120's completeness
 * gate's input, and the half of it that makes an unknown cost block.
 *
 * The item cost and inbound shipping always apply to a supplier-fulfilled
 * order; tax applies whenever the supplier priced it. Declaring a kind
 * applicable that the supplier did not quote is exactly how a line is REFUSED,
 * which is the intended direction: #120 reports the missing kind and blocks
 * rather than silently pricing it at zero.
 */
function applicableCostKinds(quote: PreflightCostFacts): readonly RetailCostComponentKind[] {
  const kinds: RetailCostComponentKind[] = ['supplier_item', 'destination_shipping'];
  if (quote.taxAmount !== null || quote.dutyAmount !== null) kinds.push('tax_duty');
  if (quote.supplierFeesAmount !== null) kinds.push('supplier_handling');
  return kinds;
}
