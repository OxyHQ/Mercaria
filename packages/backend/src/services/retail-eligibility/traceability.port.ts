/**
 * The NARROW seam onto product traceability facts (#121 "Product identity and
 * traceability" 6–8).
 *
 * ## Why a port and not a table
 *
 * Country of origin, the manufacturer's identity, the responsible economic
 * operator and whether a batch or serial can be tracked are FACTS ABOUT A
 * PRODUCT. #56 owns canonical products and their identifiers; #94 owns the
 * versioned attribute registry those facts are recorded in. Copying them into a
 * `retail_traceability` table would create a second answer to a question the
 * canonical graph already owns — the trap `CONVENTIONS.md` records against
 * every projection that becomes a cache.
 *
 * So this domain REQUIRES the facts (`require_country_of_origin`,
 * `require_responsible_operator` on a policy version; `requires_batch_traceability`
 * on a category rule) and READS them through this one function. The identifier
 * and brand halves are NOT here — those are `product_identifiers` and
 * `canonical_products.brand_id`, which this domain queries directly because
 * they are plain columns with no vocabulary to agree on.
 *
 * ## The default reports NO DATA, and that BLOCKS
 *
 * `services/attributes/offer-facts.port.ts` (#94) is the precedent, and so is
 * its reasoning: until a provider is registered the port answers that it knows
 * nothing, and a hard requirement over nothing EXCLUDES rather than being
 * satisfied from silence. A deployment that has not wired the attribute
 * provider therefore cannot publish a `mercaria_retail` offer under a policy
 * version that requires these facts — and turning the requirement off is a
 * deliberate, audited property of a NEW policy version, not something a missing
 * import decides quietly.
 *
 * #122 (supplier product data) is the owner that registers the real provider.
 */

import { log } from '../../lib/logger.js';

/** What one product's traceability record says. Every field may be absent. */
export interface RetailTraceabilityFacts {
  /** ISO-3166-1 alpha-2, upper-cased. Absent = not recorded. */
  countryOfOrigin?: string;
  /** The manufacturer's or brand owner's name, as the product declares it. */
  manufacturerIdentity?: string;
  /** The responsible economic operator's contact, where the market requires one. */
  responsibleOperator?: string;
  /** Whether a batch, lot or serial can be tracked through fulfilment. */
  batchTraceabilitySupported?: boolean;
}

/** What the port is asked about. */
export interface RetailTraceabilityQuery {
  canonicalProductId: string | null;
  canonicalVariantId: string | null;
  supplierId: string;
  supplierSku: string;
}

/** A provider answers traceability questions for one product. */
export type RetailTraceabilityProvider = (
  query: RetailTraceabilityQuery,
) => Promise<RetailTraceabilityFacts>;

/**
 * The default: no data. NOT an empty object standing for "nothing applies" —
 * an empty object IS "nothing is known", and every requirement over it fails.
 */
const NO_TRACEABILITY_DATA: RetailTraceabilityProvider = async () => ({});

let provider: RetailTraceabilityProvider = NO_TRACEABILITY_DATA;

/**
 * Register the real provider (#122). Idempotent by overwrite, because a process
 * has exactly one product-data source and re-registering it during a test is
 * ordinary.
 */
export function registerRetailTraceabilityProvider(next: RetailTraceabilityProvider): void {
  provider = next;
}

/** Restore the no-data default — the state a fresh process boots in. */
export function resetRetailTraceabilityProvider(): void {
  provider = NO_TRACEABILITY_DATA;
}

/**
 * Ask the registered provider.
 *
 * A provider failure becomes NO DATA rather than an exception, and is logged.
 * That is fail-closed here and not a swallowed error: no data blocks every
 * requirement over it, so a broken provider makes offers ineligible rather than
 * making a checkout 500 — and the log line is what tells an operator why the
 * catalogue went dark.
 */
export async function readRetailTraceability(
  query: RetailTraceabilityQuery,
): Promise<RetailTraceabilityFacts> {
  try {
    return await provider(query);
  } catch (error) {
    log.general.error(
      {
        err: error,
        canonicalVariantId: query.canonicalVariantId,
        supplierId: query.supplierId,
      },
      '[RetailEligibility] the traceability provider failed; treating every fact as unknown',
    );
    return {};
  }
}
