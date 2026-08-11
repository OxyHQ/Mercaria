/**
 * What a page may SAY about a Mercaria-retail price (#129 §"Offer detail",
 * ADR 0004 D3/D9.3) — #120's `presentation` and `blockReasons`, rendered.
 *
 * ## It reads a quote and never composes one
 *
 * `composeRetailCostQuote` calls a supplier. A public product page that
 * composed a quote per view would spend a provider call on every browse, burn
 * #122's per-supplier lease against people who are not buying, and hand anyone
 * with a URL a way to drain it. So this reads the newest still-valid quote
 * through `findRetailCostQuoteForPresentation` and answers `unquoted` when
 * there is none. `unquoted` is an honest answer: it says Mercaria is not
 * currently in a position to state a price, which is different from saying the
 * price is blocked and very different from saying it is free.
 *
 * ## The verdict is READ off the row, not re-derived
 *
 * `retail_cost_quotes.presentation` and `.block_reasons` were written by
 * `deriveRetailCompleteness` when the quote was composed, and a CHECK ties the
 * pair to the completeness. Re-deriving them here would be a second answer to a
 * question the row already answers — and it would be derived from inputs this
 * module cannot see (which components were applicable, what the tax
 * determination was), so the two would disagree the moment a policy moved.
 *
 * ## Money exists only where it may be claimed
 *
 * The three quoted branches of {@link RetailOfferPriceStatement} carry an
 * amount exactly where #120 permits one, and `not_purchasable` and `unquoted`
 * have no amount property at all. That is what makes "the UI must not display a
 * total the domain refused to certify" a compile error rather than a review
 * note, and it is the same device as `OfferDelivery`'s unknown branch: a
 * surface that wants to render zero has to write the coercion out loud.
 */

import {
  RETAIL_COST_BLOCK_REASONS,
  type Money,
  type RetailCostBlockReason,
  type RetailOfferPresentation,
  type RetailOfferPriceStatement,
  type RetailPriceFinality,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres';
import {
  findRetailCostQuoteForPresentation,
  type RetailCostQuoteRecord,
} from '../../db/retailPricing/retailCostQuoteRepository';
import { currentRetailPresentation } from './presentation';

/** What one retail offer's price surface is asked. */
export interface ReadRetailOfferPresentationInput {
  canonicalVariantId: string;
  /**
   * ISO-3166-1 alpha-2, where the buyer has told Mercaria one.
   *
   * Absent is a real state and not a defaulted one: with no destination the
   * only quote that may be read is a destination-less one, whose most it can
   * ever support is a starting item cost.
   */
  destinationCountry?: string;
  now?: Date;
  db?: DatabaseOrTransaction;
}

/**
 * Project one stored quote onto what a page may say.
 *
 * The `switch` is over #120's own tuple, so a fourth presentation value added
 * there fails `tsc` here rather than falling through to a default that claimed
 * something.
 */
/**
 * Narrow the stored `text[]` to #120's tuple.
 *
 * `checkEveryElementOf('retail_cost_quotes_block_reasons_check', ...)` already
 * makes every stored element a member, so this filter is TOTAL against any row
 * Postgres accepted — it exists because `$inferSelect` widens an array column
 * to `string[]`, and the alternative to a real predicate is a cast, which would
 * assert the same thing without checking it.
 */
function narrowBlockReasons(stored: readonly string[]): RetailCostBlockReason[] {
  const permitted = new Set<string>(RETAIL_COST_BLOCK_REASONS);
  return stored.filter((reason): reason is RetailCostBlockReason => permitted.has(reason));
}

function priceStatement(quote: RetailCostQuoteRecord): RetailOfferPriceStatement {
  const blockReasons = narrowBlockReasons(quote.blockReasons);
  const quotedAt = quote.quotedAt.toISOString();
  const expiresAt = quote.expiresAt.toISOString();
  switch (quote.presentation) {
    case 'exact_cost_only': {
      // `buyer_payable` and not `customer_total`: a promotion is a Mercaria
      // marketing expense (#120), and the buyer pays the total minus it.
      const buyerPayable: Money = {
        amount: quote.buyerPayableAmount,
        currency: quote.presentmentCurrency,
      };
      return {
        presentation: 'exact_cost_only',
        buyerPayable,
        currency: quote.presentmentCurrency,
        quotedAt,
        expiresAt,
        blockReasons,
      };
    }
    case 'starting_item_cost':
      return {
        presentation: 'starting_item_cost',
        // The SAME figure, named for what it actually is. A quote in
        // `awaiting_destination` has no shipping and no tax component, so the
        // amount it carries is the item cost and calling it a total would be
        // the claim `starting_item_cost` exists to forbid.
        itemCostFrom: { amount: quote.buyerPayableAmount, currency: quote.presentmentCurrency },
        currency: quote.presentmentCurrency,
        quotedAt,
        expiresAt,
        blockReasons,
      };
    case 'not_purchasable':
      return { presentation: 'not_purchasable', quotedAt, expiresAt, blockReasons };
  }
}

/**
 * What a page may say about one retail variant's price, and under whose terms.
 *
 * `priceFinality` is `undetermined` unless a caller supplies #121's own
 * determination. That is the honest default and NOT a placeholder: `final`
 * would be a claim Mercaria has not verified for this route, and
 * `additional_charges_possible` would be a warning nobody established. #121's
 * `RetailTaxDetermination` travels on its eligibility verdict, so a surface
 * that has run the gate passes it through rather than having this module run it
 * a second time — an eligibility read touches eleven tables and would turn a
 * price render into a compliance evaluation.
 */
export async function readRetailOfferPresentation(
  input: ReadRetailOfferPresentationInput & { priceFinality?: RetailPriceFinality },
): Promise<RetailOfferPresentation> {
  const quote = await findRetailCostQuoteForPresentation({
    canonicalVariantId: input.canonicalVariantId,
    ...(input.destinationCountry ? { destinationCountry: input.destinationCountry } : {}),
    ...(input.now ? { at: input.now } : {}),
    ...(input.db ? { db: input.db } : {}),
  });

  const presentation: RetailOfferPresentation = {
    canonicalVariantId: input.canonicalVariantId,
    commercial: currentRetailPresentation(),
    price: quote
      ? priceStatement(quote)
      : {
          presentation: 'unquoted',
          // Which of the two absences it is, said plainly. A buyer who has
          // supplied no destination can act on `destination_not_supplied`; one
          // who has supplied one and still gets nothing cannot, and telling
          // them the same thing would suggest they could.
          reason: input.destinationCountry ? 'no_current_quote' : 'destination_not_supplied',
        },
    priceFinality: input.priceFinality ?? 'undetermined',
  };
  if (input.destinationCountry) {
    presentation.destinationCountry = input.destinationCountry.toUpperCase();
  }
  return presentation;
}
