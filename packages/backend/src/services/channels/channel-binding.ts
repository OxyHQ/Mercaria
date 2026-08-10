/**
 * Binding a channel to the verified merchant and the exact storefront
 * (#87 reconcile 1).
 *
 * ## What "bound" means, and what it deliberately does not
 *
 * A merchant connects Shopify. Mercaria may already hold their catalogue as
 * EXTERNAL offers, crawled or fed months earlier, attached to a storefront under
 * a merchant nobody had claimed. Reconciling the two means knowing which
 * merchant and which storefront — and getting either wrong attaches one shop's
 * catalogue to another shop's identity, which is a false merge with a
 * commercial consequence.
 *
 * So the binding is a CONJUNCTION of facts other domains own, read live:
 *
 * 1. #84's `native_store_links` says which merchant this Mercaria store IS.
 * 2. #83's verified claim is what made that link legitimate in the first place.
 * 3. The channel's own shop domain picks the exact storefront under that
 *    merchant.
 *
 * ## It cannot fail open, and it establishes NOTHING
 *
 * Every way the conjunction breaks answers a named {@link ChannelBindingGap} and
 * no merchant, which is the `unknown`-is-never-a-soft-yes rule applied to an
 * identity: an unbound channel reconciles against nothing rather than against a
 * guess. And a successful binding CREATES no row — no claim, no link, no
 * relationship, no storefront. #87 reconcile 8 ("never infer official-brand
 * status from a connected catalog") is that absence, and
 * `channel-isolation.test.ts` fails the build if this domain learns to reach
 * the relationship layer at all.
 *
 * The domain match is `merchant_domains`' own label-wise containment through
 * #83's `domainIsCoveredBy`, so `notapple.com` is never covered by `apple.com`.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { ChannelBindingGap } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { findActiveLinkByStore } from '../../db/commerce-graph/nativeStoreLinkRepository.js';
import { merchants, storefronts } from '../../db/schema/merchants.js';
import { domainIsCoveredBy } from '../merchant-claims/claim-scope.js';

/**
 * What a channel is bound to, or why it is not.
 *
 * The MERCHANT and the STOREFRONT bind independently, and the type says so: a
 * merchant may be bound while the exact channel is not. Collapsing them would
 * make the commonest partial state — a claimed merchant whose Shopify subdomain
 * Mercaria has never crawled — read as "we could not identify you", when the
 * true statement is "we identified you and have nothing indexed for that shop
 * yet". Those route differently: the first is a claim to complete, the second is
 * nothing at all to do.
 */
export type ChannelBinding =
  | {
      readonly bound: true;
      readonly merchantId: string;
      readonly storefrontId?: string;
      /** Why the exact storefront was not resolved, when it was not. */
      readonly gap?: Extract<ChannelBindingGap, 'storefront_not_matched' | 'channel_has_no_domain'>;
    }
  | {
      readonly bound: false;
      readonly gap: Extract<ChannelBindingGap, 'store_not_linked' | 'merchant_not_claimed'>;
    };

/**
 * Resolve the merchant and storefront a connection's shop belongs to.
 *
 * `shopDomain` absent reports `channel_has_no_domain` and still BINDS the
 * merchant: a product feed and the native catalogue legitimately have no host,
 * and a merchant-grain reconciliation is exactly right for them.
 */
export async function resolveChannelBinding(input: {
  storeId: string;
  shopDomain?: string | null;
}): Promise<ChannelBinding> {
  const link = await findActiveLinkByStore(getDb(), input.storeId);
  if (!link) {
    // Not linked to a merchant (#84). This domain deliberately does not ask #83
    // whether a claim is in flight — #84's active link is the one stored verdict
    // about which merchant a store IS, and a second question here could only
    // disagree with it.
    return { bound: false, gap: 'store_not_linked' };
  }

  // #87 reconcile 1 says the VERIFIED merchant. A link survives its claim being
  // revoked only until #83's revocation sweep runs, so the claim state is read
  // live rather than trusted from the link's existence — binding a catalogue to
  // a merchant somebody has stopped being the operator of is the false
  // attribution this whole module exists to avoid.
  const [merchant] = await getDb()
    .select({ claimState: merchants.claimState })
    .from(merchants)
    .where(eq(merchants.id, link.merchantId))
    .limit(1);
  if (!merchant || merchant.claimState !== 'claimed') {
    return { bound: false, gap: 'merchant_not_claimed' };
  }

  const host = normalizeHost(input.shopDomain);
  if (host === undefined) {
    return { bound: true, merchantId: link.merchantId, gap: 'channel_has_no_domain' };
  }

  const candidates = await getDb()
    .select({ id: storefronts.id, domain: storefronts.domain })
    .from(storefronts)
    .where(and(eq(storefronts.merchantId, link.merchantId), isNull(storefronts.mergedIntoId)));

  const exact = candidates.find((candidate) => candidate.domain === host);
  if (exact) {
    return { bound: true, merchantId: link.merchantId, storefrontId: exact.id };
  }

  // A shop on a platform subdomain (`acme.myshopify.com`) against a storefront
  // recorded under the merchant's own domain, or the reverse. Label-wise
  // containment in BOTH directions, through #83's function rather than a second
  // spelling of it — an `endsWith` written here would admit `notacme.com`.
  const contained = candidates.find(
    (candidate) =>
      candidate.domain !== null &&
      (domainIsCoveredBy(host, candidate.domain) || domainIsCoveredBy(candidate.domain, host)),
  );
  if (contained) {
    return { bound: true, merchantId: link.merchantId, storefrontId: contained.id };
  }

  return { bound: true, merchantId: link.merchantId, gap: 'storefront_not_matched' };
}

/**
 * The host a channel's stored `shop_domain` names, lowercased.
 *
 * WooCommerce stores a full origin (`https://shop.example`) and Shopify stores a
 * bare host (`acme.myshopify.com`), so both shapes are accepted and reduced to
 * the same thing. An unparseable value answers `undefined` rather than throwing:
 * a stored domain nobody can read is a reason not to bind, not a reason to fail
 * a merchant's channel page.
 */
function normalizeHost(value: string | null | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (!raw.includes('://')) {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
