/**
 * Retail cost quotes, their components and the checkout lock (#120).
 *
 * ## The quote and its components commit TOGETHER
 *
 * `insertRetailCostQuote` is the ONLY writer of both tables and writes them in
 * one `db.transaction(...)`, so a quote whose components are missing — a total
 * with nothing behind it — is not a state the database can be in. The parent's
 * `customer_total` is asserted equal to the exact sum of the component rows
 * BEFORE the insert, because a CHECK cannot see across rows and a deferred
 * constraint would fire long after the caller who could explain it has gone.
 *
 * ## The acceptance is a CLAIM, not an insert
 *
 * `acceptRetailCostQuote` inserts with `ON CONFLICT DO NOTHING` on
 * `(checkout_group_id, quote_id)` and, when it loses, returns the row the
 * winner made — the moderation-event claim shape. That is what makes an
 * idempotent checkout retry return the SAME locked total: the second attempt
 * does not re-price, it reads.
 *
 * ## The ONE mutation this domain permits, and why it is safe
 *
 * `linkAcceptanceToOrder` moves `order_id` from NULL to a value, once. The
 * append-only trigger permits exactly that shape and refuses everything else,
 * so the freeze can be attached to the order that materialises after it without
 * making a financial record editable. The statement is a CAS on
 * `order_id IS NULL`, so two concurrent links produce one winner and the loser
 * reads `undefined` rather than silently re-pointing the lock.
 */

import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type {
  CurrencyCode,
  FxRateSnapshot,
  RetailCostBlockReason,
  RetailCostComponentKind,
  RetailCostConfidence,
  RetailFxBasis,
  RetailPricePresentation,
  RetailQuoteCompleteness,
  RetailQuoteSupersedeReason,
  RetailSubsidySource,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  retailCostQuoteAcceptances,
  retailCostQuoteComponents,
  retailCostQuotes,
} from '../schema/retailPricing.js';

/** One quote row, whole. */
export type RetailCostQuoteRecord = typeof retailCostQuotes.$inferSelect;

/** One component row, whole. */
export type RetailCostQuoteComponentRecord = typeof retailCostQuoteComponents.$inferSelect;

/** One acceptance row, whole. */
export type RetailCostQuoteAcceptanceRecord = typeof retailCostQuoteAcceptances.$inferSelect;

/** One component of a new quote — its amount, its provenance and its conversion. */
export interface NewRetailCostQuoteComponent {
  kind: RetailCostComponentKind;
  sourceRef: string;
  sourceAmount: number;
  sourceCurrency: CurrencyCode;
  presentmentAmount: number;
  presentmentCurrency: CurrencyCode;
  /** Present exactly when the two currencies differ — the CHECK enforces it. */
  fxSnapshot?: FxRateSnapshot;
  fxBasis?: RetailFxBasis;
  confidence: RetailCostConfidence;
  observedAt: Date;
  supplierQuoteRef?: string;
  sourceObservationRef?: string;
  evidenceRef?: string;
  description?: string;
}

/** What a new immutable quote is written from. */
export interface NewRetailCostQuote {
  policyId: string;
  policyKey: string;
  policyVersion: number;
  supplierId: string;
  supplierAccountId: string;
  agreementId: string;
  procurementOfferId?: string;
  canonicalProductId?: string;
  canonicalVariantId?: string;
  supplierSku: string;
  quantity: number;
  destinationCountry?: string;
  destinationRegion?: string;
  presentmentCurrency: CurrencyCode;
  customerTotalAmount: number;
  subsidyAmount?: number;
  subsidySource?: RetailSubsidySource;
  subsidyBudgetRef?: string;
  buyerPayableAmount: number;
  completeness: RetailQuoteCompleteness;
  presentation: RetailPricePresentation;
  blockReasons: RetailCostBlockReason[];
  quotedAt: Date;
  expiresAt: Date;
  contentHash: string;
  supersedesQuoteId?: string;
  supersedeReason?: RetailQuoteSupersedeReason;
  components: NewRetailCostQuoteComponent[];
}

/** A quote plus the components it is the sum of. */
export interface RetailCostQuoteWithComponents {
  quote: RetailCostQuoteRecord;
  components: RetailCostQuoteComponentRecord[];
}

/**
 * Write one immutable quote and its components, in one transaction.
 *
 * @throws When the parent total is not the exact sum of the components. This is
 *   the cross-row invariant a CHECK cannot express, and the single-writer rule
 *   is what makes asserting it here sufficient — the realdb test proves it by
 *   trying to smuggle an inflated total past this function.
 */
export async function insertRetailCostQuote(
  db: DatabaseOrTransaction,
  input: NewRetailCostQuote,
): Promise<RetailCostQuoteWithComponents> {
  if (input.components.length === 0) {
    throw new Error('insertRetailCostQuote refuses a quote with no cost components');
  }
  const componentSum = input.components.reduce(
    (sum, component) => sum + component.presentmentAmount,
    0,
  );
  if (componentSum !== input.customerTotalAmount) {
    throw new Error(
      `insertRetailCostQuote refuses a customer total of ${String(input.customerTotalAmount)} ` +
        `against components summing to ${String(componentSum)}: the cost-only amount IS the sum ` +
        'of its components, and a difference is exactly the markup that must not exist.',
    );
  }

  return await db.transaction(async (tx) => {
    const [quote] = await tx
      .insert(retailCostQuotes)
      .values({
        policyId: input.policyId,
        policyKey: input.policyKey,
        policyVersion: input.policyVersion,
        supplierId: input.supplierId,
        supplierAccountId: input.supplierAccountId,
        agreementId: input.agreementId,
        procurementOfferId: input.procurementOfferId ?? null,
        canonicalProductId: input.canonicalProductId ?? null,
        canonicalVariantId: input.canonicalVariantId ?? null,
        supplierSku: input.supplierSku,
        quantity: input.quantity,
        destinationCountry: input.destinationCountry ?? null,
        destinationRegion: input.destinationRegion ?? null,
        presentmentCurrency: input.presentmentCurrency,
        customerTotalAmount: input.customerTotalAmount,
        customerTotalCurrency: input.presentmentCurrency,
        subsidyAmount: input.subsidyAmount ?? null,
        subsidyCurrency: input.subsidyAmount === undefined ? null : input.presentmentCurrency,
        subsidySource: input.subsidySource ?? null,
        subsidyBudgetRef: input.subsidyBudgetRef ?? null,
        buyerPayableAmount: input.buyerPayableAmount,
        buyerPayableCurrency: input.presentmentCurrency,
        completeness: input.completeness,
        presentation: input.presentation,
        blockReasons: [...input.blockReasons].sort(),
        quotedAt: input.quotedAt,
        expiresAt: input.expiresAt,
        contentHash: input.contentHash,
        supersedesQuoteId: input.supersedesQuoteId ?? null,
        supersedeReason: input.supersedeReason ?? null,
      })
      .returning();
    if (!quote) throw new Error('insertRetailCostQuote returned no quote row');

    const components = await tx
      .insert(retailCostQuoteComponents)
      .values(
        input.components.map((component, index) => ({
          quoteId: quote.id,
          kind: component.kind,
          sourceRef: component.sourceRef,
          sourceAmount: component.sourceAmount,
          sourceCurrency: component.sourceCurrency,
          presentmentAmount: component.presentmentAmount,
          presentmentCurrency: component.presentmentCurrency,
          fxRateFrom: component.fxSnapshot?.from ?? null,
          fxRateTo: component.fxSnapshot?.to ?? null,
          fxRateRate: component.fxSnapshot?.rate ?? null,
          fxRateProvider: component.fxSnapshot?.provider ?? null,
          fxRateAsOf: component.fxSnapshot?.asOf ?? null,
          fxBasis: component.fxBasis ?? null,
          confidence: component.confidence,
          observedAt: component.observedAt,
          supplierQuoteRef: component.supplierQuoteRef ?? null,
          sourceObservationRef: component.sourceObservationRef ?? null,
          evidenceRef: component.evidenceRef ?? null,
          description: component.description ?? null,
          position: index,
        })),
      )
      .returning();

    return { quote, components };
  });
}

/** One quote by id, or `undefined`. */
export async function findRetailCostQuoteById(
  db: DatabaseOrTransaction,
  quoteId: string,
): Promise<RetailCostQuoteWithComponents | undefined> {
  const [quote] = await db
    .select()
    .from(retailCostQuotes)
    .where(eq(retailCostQuotes.id, quoteId))
    .limit(1);
  if (!quote) return undefined;
  const components = await db
    .select()
    .from(retailCostQuoteComponents)
    .where(eq(retailCostQuoteComponents.quoteId, quoteId))
    .orderBy(retailCostQuoteComponents.position);
  return { quote, components };
}

/**
 * The chargeable quote for one variant into one market, newest first — the
 * read #123's checkout and #129's offer surface both make.
 *
 * Expiry is filtered HERE against the caller's clock rather than read off a
 * status column, so a quote that ran out a second ago is simply not returned.
 */
export async function findChargeableRetailCostQuote(
  db: DatabaseOrTransaction,
  input: { canonicalVariantId: string; destinationCountry: string; at?: Date },
): Promise<RetailCostQuoteRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .select()
    .from(retailCostQuotes)
    .where(
      and(
        eq(retailCostQuotes.canonicalVariantId, input.canonicalVariantId),
        eq(retailCostQuotes.destinationCountry, input.destinationCountry.toUpperCase()),
        eq(retailCostQuotes.completeness, 'complete'),
        // `gt`, never a raw `sql` template — see the note in
        // `retailPricingPolicyRepository.findActiveRetailPricingPolicy`.
        gt(retailCostQuotes.expiresAt, at),
      ),
    )
    .orderBy(desc(retailCostQuotes.createdAt))
    .limit(1);
  return row;
}

/** What a checkout lock is taken from. */
export interface NewRetailCostQuoteAcceptance {
  quoteId: string;
  checkoutGroupId: string;
  acceptedTotalAmount: number;
  acceptedTotalCurrency: CurrencyCode;
  quoteContentHash: string;
  acceptedAt: Date;
  /** Exactly one of these two — the CHECK refuses zero and refuses both. */
  acceptedByOxyUserId?: string;
  acceptedGuestSessionId?: string;
  supersedesAcceptanceId?: string;
}

/** The claim's answer: the surviving lock, and whether this call took it. */
export interface AcceptRetailCostQuoteResult {
  acceptance: RetailCostQuoteAcceptanceRecord;
  created: boolean;
}

/**
 * Take the checkout lock, or converge on the one an earlier attempt already
 * took. A retry of the SAME quote in the SAME checkout group returns the
 * existing row, so the locked total is read rather than re-priced.
 */
export async function acceptRetailCostQuote(
  db: DatabaseOrTransaction,
  input: NewRetailCostQuoteAcceptance,
): Promise<AcceptRetailCostQuoteResult> {
  const [claimed] = await db
    .insert(retailCostQuoteAcceptances)
    .values({
      quoteId: input.quoteId,
      checkoutGroupId: input.checkoutGroupId,
      acceptedTotalAmount: input.acceptedTotalAmount,
      acceptedTotalCurrency: input.acceptedTotalCurrency,
      quoteContentHash: input.quoteContentHash,
      acceptedAt: input.acceptedAt,
      acceptedByOxyUserId: input.acceptedByOxyUserId ?? null,
      acceptedGuestSessionId: input.acceptedGuestSessionId ?? null,
      supersedesAcceptanceId: input.supersedesAcceptanceId ?? null,
    })
    .onConflictDoNothing({
      target: [retailCostQuoteAcceptances.checkoutGroupId, retailCostQuoteAcceptances.quoteId],
    })
    .returning();
  if (claimed) return { acceptance: claimed, created: true };

  const survivor = await findRetailCostQuoteAcceptance(db, {
    checkoutGroupId: input.checkoutGroupId,
    quoteId: input.quoteId,
  });
  if (!survivor) {
    // The winner's transaction aborted after blocking ours — genuinely rare,
    // and retrying the claim is the correct answer, not an error.
    return await acceptRetailCostQuote(db, input);
  }
  return { acceptance: survivor, created: false };
}

/** The convergence read behind {@link acceptRetailCostQuote}. */
export async function findRetailCostQuoteAcceptance(
  db: DatabaseOrTransaction,
  input: { checkoutGroupId: string; quoteId: string },
): Promise<RetailCostQuoteAcceptanceRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailCostQuoteAcceptances)
    .where(
      and(
        eq(retailCostQuoteAcceptances.checkoutGroupId, input.checkoutGroupId),
        eq(retailCostQuoteAcceptances.quoteId, input.quoteId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Every lock taken in one checkout group, oldest first. A group has more than
 * one only when the buyer explicitly re-accepted a revised total, and the chain
 * of `supersedes_acceptance_id` is what says which is current.
 */
export async function listRetailCostQuoteAcceptancesForGroup(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
): Promise<RetailCostQuoteAcceptanceRecord[]> {
  return await db
    .select()
    .from(retailCostQuoteAcceptances)
    .where(eq(retailCostQuoteAcceptances.checkoutGroupId, checkoutGroupId))
    .orderBy(retailCostQuoteAcceptances.acceptedAt, retailCostQuoteAcceptances.id);
}

/** Every lock frozen onto one order — the #128 reconciliation read. */
export async function listRetailCostQuoteAcceptancesForOrder(
  db: DatabaseOrTransaction,
  orderId: string,
): Promise<RetailCostQuoteAcceptanceRecord[]> {
  return await db
    .select()
    .from(retailCostQuoteAcceptances)
    .where(eq(retailCostQuoteAcceptances.orderId, orderId))
    .orderBy(retailCostQuoteAcceptances.acceptedAt, retailCostQuoteAcceptances.id);
}

/**
 * Freeze the accepted quote onto the retail order — the ONE permitted mutation
 * in this domain (see the module docblock).
 *
 * A CAS on `order_id IS NULL`: `undefined` means the lock was already attached,
 * to this order or another, and the caller must read rather than re-point.
 */
export async function linkRetailAcceptanceToOrder(
  db: DatabaseOrTransaction,
  input: { acceptanceId: string; orderId: string },
): Promise<RetailCostQuoteAcceptanceRecord | undefined> {
  const [row] = await db
    .update(retailCostQuoteAcceptances)
    .set({ orderId: input.orderId })
    .where(
      and(
        eq(retailCostQuoteAcceptances.id, input.acceptanceId),
        isNull(retailCostQuoteAcceptances.orderId),
      ),
    )
    .returning();
  return row;
}
