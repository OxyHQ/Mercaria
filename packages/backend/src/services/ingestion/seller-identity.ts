/**
 * WHERE the seller of record of one ingested offer comes from — the one seam
 * #65 needed in #62's pipeline, and the narrowest shape that closes it.
 *
 * ## The rule #62 wrote, and the case it was not about
 *
 * #62: *"the merchant comes from the source's own BINDING, never from a payload
 * hint — a source with no merchant produces no offers, which is a state an
 * operator can fix rather than a merchant nobody authorised."* That is exactly
 * right for a retailer feed, where the advertiser IS the merchant, and it is the
 * defence against an arbitrary feed naming a merchant it has no authority over.
 *
 * A MARKETPLACE is the opposite case. Every eBay item is sold by a different
 * account, and binding one merchant to the source would attribute forty thousand
 * sellers' inventory to a single row called "eBay" — which is not a coarser
 * version of the truth but a different and false one, and it makes issue #65
 * acceptance 2 unsatisfiable: two sellers of one product would collapse into one
 * offer on `offers.commercial_key`, which is `(variant, merchant, storefront,
 * condition)`.
 *
 * ## What keeps the prohibition intact
 *
 * The opt-in is `catalog_source_configs.seller_identity`, a column an OPERATOR
 * sets per source. Three consequences, and all three are what make this narrow
 * rather than a hole:
 *
 *  1. An adapter still cannot name a merchant. It supplies `merchantHint` —
 *     which #62 already defines as "the source's own words for who is selling. A
 *     HINT; it resolves nothing" — and this module is the only thing that reads
 *     it for that purpose. A `source_bound` source cannot mint a merchant
 *     however its payloads are shaped.
 *  2. The operator setting the column is asserting one checkable thing: that
 *     this provider publishes a stable per-item seller identity. eBay does —
 *     `seller.username` is eBay's own primary key for an account.
 *  3. The merchant lands in a namespace keyed by `(provider, external seller
 *     id)` that no claimed merchant can occupy, with `claim_state='unclaimed'`,
 *     no relationship and no native-store link.
 *
 * ## A missing hint produces NO OFFER, and that is the same refusal as before
 *
 * #62 answers a source with no merchant by leaving the object `matched` and
 * writing no offer — "the canonical attachment happened and the commercial half
 * did not". A `per_record` source whose record carried no seller gets the same
 * answer for the same reason: there is nobody to attribute the sale to, and
 * falling back to the bound merchant would attribute it to the MARKETPLACE,
 * which is the one wrong answer available.
 */

import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import {
  claimMarketplaceSellerIdentity,
  findMarketplaceSellerIdentity,
  insertMarketplaceSellerMerchant,
  insertMarketplaceSellerSourceLink,
  marketplaceSellerSlugExists,
  touchMarketplaceSellerIdentity,
} from '../../db/ingestion/marketplaceSellerRepository.js';
import type { ResolvedIngestionSource } from './source.service.js';

/** Bound on a slug segment. Long enough for any real handle, short enough to index. */
const MAX_SELLER_SLUG_SEGMENT = 60;

/**
 * A URL-safe slug segment for one marketplace account handle.
 *
 * Deliberately lossy: a handle is not a name, the slug is an address, and two
 * handles that differ only in punctuation are resolved by `ensureUniqueSellerSlug`
 * appending a discriminator rather than by preserving characters a URL cannot
 * carry. A handle that slugs to nothing at all (all punctuation, or a script
 * this fold drops) falls back to `seller`, which the discriminator then makes
 * unique — never to an empty segment, which would produce `ebay--3` and read as
 * a bug.
 */
export function marketplaceSellerSlugSegment(handle: string): string {
  const folded = handle
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SELLER_SLUG_SEGMENT);
  return folded === '' ? 'seller' : folded;
}

/**
 * A slug no merchant holds.
 *
 * `merchants.slug` is unique FOREVER — a merged tombstone keeps its slug so the
 * old URL still resolves — so a collision here is not necessarily another eBay
 * seller; it can be a merchant that no longer exists. Appending a numeric
 * discriminator is the same device `ensureUniqueSlug` uses for operator-created
 * merchants, and the bound exists because an unbounded loop on a hot ingestion
 * path is a stall nobody would attribute to a slug.
 */
async function ensureUniqueSellerSlug(base: string): Promise<string> {
  const db = getDb();
  if (!(await marketplaceSellerSlugExists(db, base))) return base;
  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!(await marketplaceSellerSlugExists(db, candidate))) return candidate;
  }
  throw new Error(`Could not mint a unique merchant slug for '${base}'`);
}

/**
 * The merchant an ingested offer belongs to, or `null` for "write no offer".
 *
 * @returns the bound merchant for a `source_bound` source; the marketplace
 *   seller's merchant for a `per_record` one; `null` when neither is available,
 *   which #62 already handles by leaving the object `matched` with no offer.
 */
export async function resolveOfferMerchantId(input: {
  resolved: ResolvedIngestionSource;
  merchantHint: string | undefined;
  sourceRecordId: string;
  now: Date;
}): Promise<string | null> {
  const config = input.resolved.source.config;
  if (config.sellerIdentity !== 'per_record') return config.merchantId;

  const handle = input.merchantHint?.trim();
  if (handle === undefined || handle.length === 0) {
    // No seller in the record. See the module docblock: the bound merchant is
    // the MARKETPLACE, and attributing a sale to it is the one wrong answer.
    log.general.warn(
      { sourceId: config.sourceId, sourceRecordId: input.sourceRecordId },
      '[Ingestion] a per-record source produced a record with no seller; no offer was written',
    );
    return null;
  }

  const db = getDb();
  const existing = await findMarketplaceSellerIdentity(db, {
    provider: config.provider,
    externalSellerId: handle,
  });
  if (existing !== undefined) {
    await touchMarketplaceSellerIdentity(db, {
      id: existing.id,
      now: input.now,
      displayName: handle,
    });
    return existing.merchantId;
  }

  const slug = await ensureUniqueSellerSlug(
    `${config.provider}-${marketplaceSellerSlugSegment(handle)}`,
  );
  const merchant = await insertMarketplaceSellerMerchant(db, { name: handle, slug });
  const claim = await claimMarketplaceSellerIdentity(db, {
    provider: config.provider,
    externalSellerId: handle,
    merchantId: merchant.id,
    sourceId: config.sourceId,
    sourceRecordId: input.sourceRecordId,
    displayName: handle,
    now: input.now,
  });

  if (claim.created) {
    // Provenance for the MINT, once. See the repository's docblock for why this
    // is not written on every sighting.
    await insertMarketplaceSellerSourceLink(db, {
      merchantId: merchant.id,
      sourceRecordId: input.sourceRecordId,
      provider: config.provider,
    });
  }
  // A lost race leaves `merchant.id` unreferenced. That is a wasted row and not
  // a wrong one — see the repository docblock on why the alternative is worse.
  return claim.row.merchantId;
}
