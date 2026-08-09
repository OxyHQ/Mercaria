/**
 * Composing, freezing and revalidating a retail cost quote (#120).
 *
 * The wiring between the pure parts — the formula, the completeness gate, the
 * content hash — and the two things that are not pure: FX and Postgres.
 *
 * ## Supplier costs stay in their SOURCE currency, and the conversion is captured
 *
 * A caller states each cost the way its SOURCE stated it: a supplier item cost
 * in the supplier's billing currency, a carrier charge in the carrier's, a tax
 * determination in the destination's. Nothing is converted on write. Conversion
 * to the buyer's presentment currency happens HERE, once per component, through
 * `fx.service.convert` (half-even, one rounding), and the exact `FxRateSnapshot`
 * is stored beside the converted figure — so the conversion is reproducible
 * after the rate has moved, and a later rate change can never alter a stored
 * amount.
 *
 * **The FX base is the SOURCE currency, never a pivot.** `getRates` takes any
 * base and derives the pair internally; which currency the configured providers
 * happen to publish against is that module's private business (`fx.service`
 * says so explicitly). Nothing in this domain names FAIR, asks for a FAIR rate,
 * or routes a conversion through one — #120 currency rule 4, and a static gate
 * asserts it over this whole directory.
 *
 * **Quoted FX is distinguished from provider FX.** Every conversion composed
 * here carries `fxBasis: 'quoted'`. A `provider_final` component is one whose
 * rate came from the payment provider's own balance transaction, which #123
 * supplies and #128 reconciles; the difference between the two is COST VARIANCE
 * and may never become planned profit.
 *
 * ## The order of operations, and why quantity is applied FIRST
 *
 * `unitSourceAmount × quantity` is exact integer arithmetic in the source
 * currency; only the product is converted. Converting a unit price and
 * multiplying afterwards would multiply one rounding error by the quantity —
 * the difference is a real minor-unit drift on any order of more than one unit,
 * and it is why the quantity lives on the component input rather than on the
 * total.
 *
 * ## A quote is composed even when it is BLOCKED
 *
 * The completeness gate runs after composition, and a blocked verdict still
 * produces a stored row — with `presentation: 'not_purchasable'`, its block
 * reasons, and no claim of a final total. That is deliberate: an operator
 * asking "why is this offer dark" needs the evidence, and refusing to record it
 * would leave only an absence to interpret.
 */

import type {
  CurrencyCode,
  FxRateSnapshot,
  Money,
  RetailCostComponent,
  RetailCostComponentKind,
  RetailCostConfidence,
  RetailPromotionSubsidy,
  RetailQuoteDestination,
  RetailQuoteSupersedeReason,
} from '@mercaria/shared-types';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  acceptRetailCostQuote,
  findRetailCostQuoteById,
  insertRetailCostQuote,
  type NewRetailCostQuoteComponent,
  type RetailCostQuoteAcceptanceRecord,
  type RetailCostQuoteWithComponents,
} from '../../db/retailPricing/retailCostQuoteRepository.js';
import type { RetailPricingPolicyRecord } from '../../db/retailPricing/retailPricingPolicyRepository.js';
import { conflict, validationError } from '../../lib/errors/error-codes.js';
import { convert, getRates, pairRate } from '../fx.service.js';
import { composeRetailCostOnlyTotal } from './retail-cost-formula.js';
import { deriveRetailCompleteness } from './retail-completeness.js';
import { hashRetailQuote } from './retail-quote-hash.js';

/**
 * One direct cost as its SOURCE stated it. `unitSourceAmount` is per unit for
 * `supplier_item` and `supplier_variant_surcharge` (the two the quantity
 * multiplies) and a whole-order figure for everything else — which is why
 * `perUnit` is explicit rather than inferred from the kind: a supplier that
 * charges handling per item exists, and guessing would be wrong for it.
 */
export interface RetailSourceCost {
  kind: RetailCostComponentKind;
  /** What produced this figure: `supplier_quote`, `carrier_tariff`, `tax_engine`, … */
  sourceRef: string;
  /** The amount in the SOURCE's own currency, in minor units. */
  amount: number;
  currency: CurrencyCode;
  /** Whether the quote's quantity multiplies this amount. */
  perUnit: boolean;
  confidence: RetailCostConfidence;
  observedAt: Date;
  supplierQuoteRef?: string;
  sourceObservationRef?: string;
  evidenceRef?: string;
  description?: string;
}

/** Everything composing one quote needs. */
export interface ComposeRetailCostQuoteInput {
  policy: RetailPricingPolicyRecord;
  supplierId: string;
  supplierAccountId: string;
  agreementId: string;
  procurementOfferId?: string;
  canonicalProductId?: string;
  canonicalVariantId?: string;
  supplierSku: string;
  quantity: number;
  destination?: RetailQuoteDestination;
  presentmentCurrency: CurrencyCode;
  /** The costs, as their sources stated them. */
  sourceCosts: readonly RetailSourceCost[];
  /** The kinds that APPLY to this order, quoted or not — the gate's input. */
  applicableKinds: readonly RetailCostComponentKind[];
  /** Kinds known to apply whose amount the source will not document. */
  undocumentedKinds?: readonly RetailCostComponentKind[];
  taxTreatmentDetermined: boolean;
  marketSupported: boolean;
  subsidy?: RetailPromotionSubsidy;
  /** The quote this one replaces, and why, when a re-quote produced it. */
  supersedesQuoteId?: string;
  supersedeReason?: RetailQuoteSupersedeReason;
  now?: Date;
}

/** A composed, persisted quote plus the verdict a surface reads. */
export interface ComposedRetailCostQuote extends RetailCostQuoteWithComponents {
  /** The DTO-shaped components, as the formula and the hash saw them. */
  componentDtos: RetailCostComponent[];
}

/**
 * Compose, gate, hash and persist one retail cost quote.
 *
 * @throws When a quoted component is not approved by the policy version (ADR
 *   0004 D3.7), when the payment-processing component appears without the
 *   policy's lawful-basis pass-through, or when a required FX pair is
 *   unavailable — a conversion is never completed with a fabricated rate.
 */
export async function composeRetailCostQuote(
  input: ComposeRetailCostQuoteInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ComposedRetailCostQuote> {
  const now = input.now ?? new Date();
  const allowed = new Set(input.policy.allowedComponentKinds as RetailCostComponentKind[]);

  if (input.quantity < 1 || !Number.isInteger(input.quantity)) {
    throw validationError(
      `A retail cost quote prices a whole number of units, received ${String(input.quantity)}.`,
    );
  }

  for (const cost of input.sourceCosts) {
    if (!allowed.has(cost.kind)) {
      throw conflict(
        `Retail pricing policy ${input.policy.policyKey} v${String(input.policy.version)} does ` +
          `not approve the component \`${cost.kind}\`. A cost enters a customer amount only ` +
          'once a policy version names it (ADR 0004 D3.7); publish a new version first.',
      );
    }
    if (cost.kind === 'payment_processing' && !input.policy.paymentCostPassthroughEnabled) {
      throw conflict(
        'Passing the payment-processing cost through to the buyer requires a policy version ' +
          'that enables it with its lawful basis and disclosure recorded; this one does not.',
      );
    }
  }

  const componentDtos = await convertSourceCosts({
    sourceCosts: input.sourceCosts,
    quantity: input.quantity,
    presentmentCurrency: input.presentmentCurrency,
  });

  const total = composeRetailCostOnlyTotal({
    components: componentDtos,
    presentmentCurrency: input.presentmentCurrency,
    ...(input.subsidy ? { subsidy: input.subsidy } : {}),
  });

  const verdict = deriveRetailCompleteness({
    allowedComponentKinds: input.policy.allowedComponentKinds as RetailCostComponentKind[],
    applicableKinds: input.applicableKinds,
    quotedKinds: componentDtos.map((component) => component.kind),
    ...(input.undocumentedKinds ? { undocumentedKinds: input.undocumentedKinds } : {}),
    ...(input.destination ? { destinationCountry: input.destination.country } : {}),
    taxTreatmentDetermined: input.taxTreatmentDetermined,
    marketSupported: input.marketSupported,
    now,
  });

  const expiresAt = new Date(now.getTime() + input.policy.quoteTtlSeconds * 1_000);
  const destination = input.destination
    ? {
        country: input.destination.country.toUpperCase(),
        ...(input.destination.region ? { region: input.destination.region } : {}),
      }
    : undefined;

  const contentHash = hashRetailQuote({
    policyKey: input.policy.policyKey,
    policyVersion: input.policy.version,
    supplierId: input.supplierId,
    supplierAccountId: input.supplierAccountId,
    agreementId: input.agreementId,
    ...(input.procurementOfferId ? { procurementOfferId: input.procurementOfferId } : {}),
    ...(input.canonicalProductId ? { canonicalProductId: input.canonicalProductId } : {}),
    ...(input.canonicalVariantId ? { canonicalVariantId: input.canonicalVariantId } : {}),
    supplierSku: input.supplierSku,
    quantity: input.quantity,
    ...(destination ? { destination } : {}),
    presentmentCurrency: input.presentmentCurrency,
    components: componentDtos,
    customerTotal: total.costOnlyTotal,
    buyerPayable: total.buyerPayable,
    ...(total.subsidy ? { subsidy: total.subsidy } : {}),
    quotedAt: now,
    expiresAt,
  });

  const persisted = await insertRetailCostQuote(db, {
    policyId: input.policy.id,
    policyKey: input.policy.policyKey,
    policyVersion: input.policy.version,
    supplierId: input.supplierId,
    supplierAccountId: input.supplierAccountId,
    agreementId: input.agreementId,
    ...(input.procurementOfferId ? { procurementOfferId: input.procurementOfferId } : {}),
    ...(input.canonicalProductId ? { canonicalProductId: input.canonicalProductId } : {}),
    ...(input.canonicalVariantId ? { canonicalVariantId: input.canonicalVariantId } : {}),
    supplierSku: input.supplierSku,
    quantity: input.quantity,
    ...(destination ? { destinationCountry: destination.country } : {}),
    ...(destination?.region ? { destinationRegion: destination.region } : {}),
    presentmentCurrency: input.presentmentCurrency,
    customerTotalAmount: total.costOnlyTotal.amount,
    ...(total.subsidy
      ? {
          subsidyAmount: total.subsidy.amount.amount,
          subsidySource: total.subsidy.source,
          subsidyBudgetRef: total.subsidy.budgetRef,
        }
      : {}),
    buyerPayableAmount: total.buyerPayable.amount,
    completeness: verdict.completeness,
    presentation: verdict.presentation,
    blockReasons: verdict.blockReasons,
    quotedAt: now,
    expiresAt,
    contentHash,
    ...(input.supersedesQuoteId ? { supersedesQuoteId: input.supersedesQuoteId } : {}),
    ...(input.supersedeReason ? { supersedeReason: input.supersedeReason } : {}),
    components: componentDtos.map(toComponentRow),
  });

  return { ...persisted, componentDtos };
}

/**
 * Convert every source cost into the presentment currency, capturing the exact
 * rate used.
 *
 * Rates are fetched ONCE per distinct source currency rather than per component
 * — several components from one supplier convert at ONE rate, which is what
 * makes a multi-component quote reproducible rather than a set of conversions
 * taken microseconds apart. The base is the SOURCE currency; no pivot currency
 * is named anywhere in this function.
 */
async function convertSourceCosts(input: {
  sourceCosts: readonly RetailSourceCost[];
  quantity: number;
  presentmentCurrency: CurrencyCode;
}): Promise<RetailCostComponent[]> {
  const sourceCurrencies = [...new Set(input.sourceCosts.map((cost) => cost.currency))];
  const ratesByCurrency = new Map<CurrencyCode, Awaited<ReturnType<typeof getRates>>>();
  for (const currency of sourceCurrencies) {
    if (currency === input.presentmentCurrency) continue;
    ratesByCurrency.set(currency, await getRates(currency, [input.presentmentCurrency]));
  }

  return input.sourceCosts.map((cost, index) => {
    // Quantity is applied in the SOURCE currency, as exact integer arithmetic,
    // BEFORE the single conversion — see the module docblock.
    const lineSourceMinor = cost.perUnit ? cost.amount * input.quantity : cost.amount;
    assertSafeMoneyAmount(lineSourceMinor, `retail.sourceCost[${String(index)}].${cost.kind}`);
    const sourceAmount: Money = { amount: lineSourceMinor, currency: cost.currency };

    if (cost.currency === input.presentmentCurrency) {
      return {
        kind: cost.kind,
        sourceRef: cost.sourceRef,
        sourceAmount,
        presentmentAmount: sourceAmount,
        confidence: cost.confidence,
        observedAt: cost.observedAt.toISOString(),
        ...optionalRefs(cost),
      };
    }

    const rates = ratesByCurrency.get(cost.currency);
    if (!rates) {
      throw validationError(
        `No exchange rate set was resolved for ${cost.currency}; a retail cost is never ` +
          'converted with a fabricated rate.',
      );
    }
    // `convert` throws when the pair is unavailable rather than inventing a
    // number — which is the fail-closed behaviour a cost-only price needs.
    const presentmentAmount = convert(sourceAmount, input.presentmentCurrency, rates);
    const fxSnapshot: FxRateSnapshot = {
      from: cost.currency,
      to: input.presentmentCurrency,
      // The SAME rate set `convert` just read, through the FX service's own
      // accessor — not a second lookup that could disagree with the conversion
      // it claims to describe.
      rate: pairRate(cost.currency, input.presentmentCurrency, rates),
      provider: rates.provider,
      asOf: rates.asOf,
    };

    return {
      kind: cost.kind,
      sourceRef: cost.sourceRef,
      sourceAmount,
      presentmentAmount,
      fxSnapshot,
      // Every conversion composed here is Mercaria's own quote-time rate. A
      // `provider_final` component arrives from #123 with the charge's balance
      // transaction; the difference between the two is variance, never profit.
      fxBasis: 'quoted' as const,
      confidence: cost.confidence,
      observedAt: cost.observedAt.toISOString(),
      ...optionalRefs(cost),
    };
  });
}

/** The optional provenance refs, present only when the source supplied them. */
function optionalRefs(
  cost: RetailSourceCost,
): Pick<
  RetailCostComponent,
  'supplierQuoteRef' | 'sourceObservationRef' | 'evidenceRef' | 'description'
> {
  return {
    ...(cost.supplierQuoteRef ? { supplierQuoteRef: cost.supplierQuoteRef } : {}),
    ...(cost.sourceObservationRef ? { sourceObservationRef: cost.sourceObservationRef } : {}),
    ...(cost.evidenceRef ? { evidenceRef: cost.evidenceRef } : {}),
    ...(cost.description ? { description: cost.description } : {}),
  };
}

/** DTO → the repository's row shape. Field by field, never a spread. */
function toComponentRow(component: RetailCostComponent): NewRetailCostQuoteComponent {
  return {
    kind: component.kind,
    sourceRef: component.sourceRef,
    sourceAmount: component.sourceAmount.amount,
    sourceCurrency: component.sourceAmount.currency,
    presentmentAmount: component.presentmentAmount.amount,
    presentmentCurrency: component.presentmentAmount.currency,
    ...(component.fxSnapshot ? { fxSnapshot: component.fxSnapshot } : {}),
    ...(component.fxBasis ? { fxBasis: component.fxBasis } : {}),
    confidence: component.confidence,
    observedAt: new Date(component.observedAt),
    ...(component.supplierQuoteRef ? { supplierQuoteRef: component.supplierQuoteRef } : {}),
    ...(component.sourceObservationRef
      ? { sourceObservationRef: component.sourceObservationRef }
      : {}),
    ...(component.evidenceRef ? { evidenceRef: component.evidenceRef } : {}),
    ...(component.description ? { description: component.description } : {}),
  };
}

/**
 * Whether a stored quote may be charged against right now, and if not, why.
 *
 * A STRING discriminant rather than a boolean: this package compiles with
 * `strict: false`, under which a `true` / `false` discriminant does not narrow
 * a union and every consumer would need a cast to read the failure reason. A
 * literal-string tag narrows either way, and it also makes the failure a value
 * a caller can switch on rather than a flag plus an optional field.
 */
export type RetailQuoteRevalidation =
  | { outcome: 'chargeable'; quote: RetailCostQuoteWithComponents }
  | { outcome: 'not_found' | 'incomplete' | 'expired' | 'content_mismatch' };

/**
 * Re-check a stored quote at the authoritative checkout point (#120 checkout
 * lock, ADR 0004 D4 concern 2: the supplier quote that expired while the buyer
 * sat inside a 3DS challenge).
 *
 * Re-derives BOTH facts from the row rather than reading a status: completeness
 * is what the row stored, expiry is the row's deadline against the clock, and
 * the content hash is recomputed from the components so a row that was edited
 * out of band fails rather than being charged.
 */
export async function revalidateRetailCostQuote(
  input: { quoteId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailQuoteRevalidation> {
  const now = input.now ?? new Date();
  const found = await findRetailCostQuoteById(db, input.quoteId);
  if (!found) return { outcome: 'not_found' };
  if (found.quote.completeness !== 'complete') {
    return { outcome: 'incomplete' };
  }
  if (found.quote.expiresAt.getTime() <= now.getTime()) {
    return { outcome: 'expired' };
  }

  const recomputed = hashRetailQuote({
    policyKey: found.quote.policyKey,
    policyVersion: found.quote.policyVersion,
    supplierId: found.quote.supplierId,
    supplierAccountId: found.quote.supplierAccountId,
    agreementId: found.quote.agreementId,
    ...(found.quote.procurementOfferId
      ? { procurementOfferId: found.quote.procurementOfferId }
      : {}),
    ...(found.quote.canonicalProductId
      ? { canonicalProductId: found.quote.canonicalProductId }
      : {}),
    ...(found.quote.canonicalVariantId
      ? { canonicalVariantId: found.quote.canonicalVariantId }
      : {}),
    supplierSku: found.quote.supplierSku,
    quantity: found.quote.quantity,
    ...(found.quote.destinationCountry
      ? {
          destination: {
            country: found.quote.destinationCountry,
            ...(found.quote.destinationRegion ? { region: found.quote.destinationRegion } : {}),
          },
        }
      : {}),
    presentmentCurrency: found.quote.presentmentCurrency,
    components: found.components.map(fromComponentRow),
    customerTotal: {
      amount: found.quote.customerTotalAmount,
      currency: found.quote.customerTotalCurrency,
    },
    buyerPayable: {
      amount: found.quote.buyerPayableAmount,
      currency: found.quote.buyerPayableCurrency,
    },
    ...(found.quote.subsidyAmount !== null &&
    found.quote.subsidyCurrency !== null &&
    found.quote.subsidySource !== null &&
    found.quote.subsidyBudgetRef !== null
      ? {
          subsidy: {
            source: found.quote.subsidySource,
            budgetRef: found.quote.subsidyBudgetRef,
            amount: {
              amount: found.quote.subsidyAmount,
              currency: found.quote.subsidyCurrency,
            },
          },
        }
      : {}),
    quotedAt: found.quote.quotedAt,
    expiresAt: found.quote.expiresAt,
  });
  if (recomputed !== found.quote.contentHash) {
    return { outcome: 'content_mismatch' };
  }
  return { outcome: 'chargeable', quote: found };
}

/** Row → the DTO the hash and the formula read. Field by field, never a spread. */
function fromComponentRow(
  row: RetailCostQuoteWithComponents['components'][number],
): RetailCostComponent {
  return {
    kind: row.kind,
    sourceRef: row.sourceRef,
    sourceAmount: { amount: row.sourceAmount, currency: row.sourceCurrency },
    presentmentAmount: { amount: row.presentmentAmount, currency: row.presentmentCurrency },
    ...(row.fxRateFrom !== null &&
    row.fxRateTo !== null &&
    row.fxRateRate !== null &&
    row.fxRateProvider !== null &&
    row.fxRateAsOf !== null
      ? {
          fxSnapshot: {
            from: row.fxRateFrom,
            to: row.fxRateTo,
            rate: row.fxRateRate,
            provider: row.fxRateProvider,
            asOf: row.fxRateAsOf,
          },
        }
      : {}),
    ...(row.fxBasis !== null ? { fxBasis: row.fxBasis } : {}),
    confidence: row.confidence,
    observedAt: row.observedAt.toISOString(),
    ...(row.supplierQuoteRef !== null ? { supplierQuoteRef: row.supplierQuoteRef } : {}),
    ...(row.sourceObservationRef !== null
      ? { sourceObservationRef: row.sourceObservationRef }
      : {}),
    ...(row.evidenceRef !== null ? { evidenceRef: row.evidenceRef } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
  };
}

/** Who took the checkout lock — an Oxy account or a #103 guest session. */
export type RetailAcceptanceActor =
  | { kind: 'oxy'; oxyUserId: string }
  | { kind: 'guest'; guestSessionId: string };

/**
 * Take the checkout lock on a revalidated quote (#120 checkout lock steps 5–7).
 *
 * Revalidation runs FIRST, inside this function, so a caller cannot lock an
 * expired or incomplete quote by holding a stale object. A repeat with the same
 * `(checkoutGroupId, quoteId)` converges on the existing lock, which is what
 * makes an idempotent checkout retry return the same total rather than
 * re-pricing.
 *
 * @throws When the quote is not chargeable — the caller must re-quote and take
 *   an explicit new buyer acceptance, never mutate this one.
 */
export async function lockRetailCostQuote(
  input: {
    quoteId: string;
    checkoutGroupId: string;
    actor: RetailAcceptanceActor;
    /** The lock this one replaces, when the buyer re-accepted a revised total. */
    supersedesAcceptanceId?: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ acceptance: RetailCostQuoteAcceptanceRecord; created: boolean }> {
  const now = input.now ?? new Date();
  const revalidation = await revalidateRetailCostQuote({ quoteId: input.quoteId, now }, db);
  if (revalidation.outcome !== 'chargeable') {
    throw conflict(
      `Retail cost quote ${input.quoteId} cannot be locked (${revalidation.outcome}). Re-quote ` +
        'and take an explicit new buyer acceptance; an accepted amount is never mutated and ' +
        'never rises.',
    );
  }

  return await acceptRetailCostQuote(db, {
    quoteId: revalidation.quote.quote.id,
    checkoutGroupId: input.checkoutGroupId,
    acceptedTotalAmount: revalidation.quote.quote.buyerPayableAmount,
    acceptedTotalCurrency: revalidation.quote.quote.buyerPayableCurrency,
    quoteContentHash: revalidation.quote.quote.contentHash,
    acceptedAt: now,
    ...(input.actor.kind === 'oxy'
      ? { acceptedByOxyUserId: input.actor.oxyUserId }
      : { acceptedGuestSessionId: input.actor.guestSessionId }),
    ...(input.supersedesAcceptanceId
      ? { supersedesAcceptanceId: input.supersedesAcceptanceId }
      : {}),
  });
}
