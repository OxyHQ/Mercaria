/**
 * The retail cost quote's content hash (ADR 0004 D4 step 1 / D10) — PURE.
 *
 * The charged amount is a pure function of the frozen snapshot, so the snapshot
 * needs an identity that a later read can verify. This is that identity: a
 * sha-256 over a canonical serialization of everything the quote asserts.
 *
 * ## Determinism is the whole contract, and it is the moderation-envelope rule
 *
 * Nothing here may vary between two hashings of one quote. So: components are
 * sorted by `(kind, sourceRef, position)` rather than trusted in arrival order;
 * every number is serialized as a string, never a float literal whose printing
 * could differ; the clock is never read; and there is no field the caller can
 * omit into a different digest — an absent optional serializes as the empty
 * string, which is a value, not a hole.
 *
 * The failure this prevents is the same one `services/moderation`'s envelope
 * builder prevents, one domain over: a hash that drifts turns a legitimate
 * revalidation into a permanent mismatch, silently, days later.
 *
 * ## What the hash covers, and why the id does not
 *
 * It covers the ECONOMIC content — supplier, offer, variant, quantity,
 * destination, every component with its source, currency, rate and confidence,
 * the totals, the subsidy, the validity window and the policy version. It does
 * NOT cover the row's own id: two quotes with byte-identical economics and
 * different ids ARE the same offer, and an acceptance restating the hash must
 * be able to say so.
 */

import { createHash } from 'node:crypto';
import type {
  CurrencyCode,
  Money,
  RetailCostComponent,
  RetailPromotionSubsidy,
  RetailQuoteDestination,
} from '@mercaria/shared-types';

/** Everything a quote's identity is composed from. */
export interface RetailQuoteHashInput {
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
  destination?: RetailQuoteDestination;
  presentmentCurrency: CurrencyCode;
  components: readonly RetailCostComponent[];
  customerTotal: Money;
  buyerPayable: Money;
  subsidy?: RetailPromotionSubsidy;
  quotedAt: Date;
  expiresAt: Date;
}

/** The field separator. A control character, so no value can contain one. */
const FIELD = '\u001f';

/** The record separator between components. */
const RECORD = '\u001e';

/** An absent optional is the EMPTY STRING — a value, never a skipped field. */
function opt(value: string | undefined): string {
  return value ?? '';
}

/**
 * One component, canonically. `rate` goes through `toPrecision(17)` rather than
 * the default `String(...)`: an IEEE-754 double round-trips exactly at 17
 * significant digits, so two runs holding the same rate always print the same
 * characters, whereas the default shortest-representation printing is stable
 * today and is not something to bet a permanent mismatch on.
 */
function serializeComponent(component: RetailCostComponent): string {
  return [
    component.kind,
    component.sourceRef,
    String(component.sourceAmount.amount),
    component.sourceAmount.currency,
    String(component.presentmentAmount.amount),
    component.presentmentAmount.currency,
    opt(component.fxSnapshot?.from),
    opt(component.fxSnapshot?.to),
    component.fxSnapshot ? component.fxSnapshot.rate.toPrecision(17) : '',
    opt(component.fxSnapshot?.provider),
    opt(component.fxSnapshot?.asOf),
    opt(component.fxBasis),
    component.confidence,
    component.observedAt,
    opt(component.supplierQuoteRef),
    opt(component.sourceObservationRef),
    opt(component.evidenceRef),
  ].join(FIELD);
}

/**
 * The canonical serialization. Exported so a mismatch can be DIAGNOSED — an
 * operator comparing two quotes needs to see which field moved, and a hash
 * alone never tells anyone that.
 */
export function serializeRetailQuote(input: RetailQuoteHashInput): string {
  const components = input.components
    .map(serializeComponent)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return [
    'mercaria.retail.cost-quote.v1',
    input.policyKey,
    String(input.policyVersion),
    input.supplierId,
    input.supplierAccountId,
    input.agreementId,
    opt(input.procurementOfferId),
    opt(input.canonicalProductId),
    opt(input.canonicalVariantId),
    input.supplierSku,
    String(input.quantity),
    opt(input.destination?.country),
    opt(input.destination?.region),
    input.presentmentCurrency,
    String(input.customerTotal.amount),
    input.customerTotal.currency,
    String(input.buyerPayable.amount),
    input.buyerPayable.currency,
    input.subsidy ? String(input.subsidy.amount.amount) : '',
    opt(input.subsidy?.amount.currency),
    opt(input.subsidy?.source),
    opt(input.subsidy?.budgetRef),
    input.quotedAt.toISOString(),
    input.expiresAt.toISOString(),
    components.join(RECORD),
  ].join(FIELD);
}

/** The sha-256 hex digest of {@link serializeRetailQuote}. */
export function hashRetailQuote(input: RetailQuoteHashInput): string {
  return createHash('sha256').update(serializeRetailQuote(input), 'utf8').digest('hex');
}
