/**
 * What a proof actually proves — issue #83's scope rules, as a pure function.
 *
 * This is the file the scope rules live in, and it is pure on purpose: every
 * one of them is a statement about the RELATION between an evidence subject
 * and a requested scope entry, so none of them needs a database to be true, to
 * be tested, or to be read by somebody checking whether they hold.
 *
 * The rules, and how each is expressed below:
 *
 *  1. **Domain control proves THAT domain.** A domain proof covers the proven
 *     host and its subdomains, and nothing else — `apple.com` does not cover
 *     `apple-store-madrid.example`, and crucially `apple-store-madrid.example`
 *     does not cover `apple.com`. The containment test is label-wise
 *     (`endsWith('.' + proven)`), never a substring: `notapple.com` ends with
 *     `apple.com` as a STRING and is a different registrable domain.
 *  2. **A platform account proof covers that shop, not every brand it sells.**
 *     A connection proof matches storefronts by `(provider, externalShopId)`
 *     or by the connection's own shop domain — an identity, not a similarity.
 *  4. **A claim may cover one storefront while others stay unclaimed.** The
 *     result partitions the requested set into `verified` and `out_of_scope`
 *     rather than collapsing to a single yes/no, so a merchant with three
 *     channels can prove one of them and see exactly which.
 *
 * Rule 3 (claiming grants no official/authorized status) is not expressible
 * here because there is nothing here that could express it: no relationship
 * vocabulary exists in this module, and `relationship-isolation.test.ts` fails
 * the build if one appears.
 */

import type { MerchantClaimScopeKind, MerchantClaimScopeState } from '@mercaria/shared-types';

/** What a completed proof established, in the vocabulary scope resolution reads. */
export type ClaimProofSubject =
  | {
      kind: 'domain';
      /** Normalized lowercase hostname, exactly as `merchant_domains.domain` holds it. */
      domain: string;
    }
  | {
      kind: 'platform_connection';
      /** The connector provider id (`shopify`, `woocommerce`, …). */
      provider: string;
      /** The platform's own shop id, when the connection carries one. */
      externalShopId: string | null;
      /** The connection's shop host, normalized, when it carries one. */
      shopDomain: string | null;
    };

/** The storefront facts scope resolution needs. A projection, not the row. */
export interface ScopeStorefrontFacts {
  id: string;
  merchantId: string;
  provider: string | null;
  externalShopId: string | null;
  /** Normalized lowercase hostname, or null when the channel is not domain-addressed. */
  domain: string | null;
}

/** One requested scope entry, as stored. */
export interface RequestedScopeEntry {
  kind: MerchantClaimScopeKind;
  ref: string;
}

/** The verdict for one requested entry. */
export interface ResolvedScopeEntry extends RequestedScopeEntry {
  state: Extract<MerchantClaimScopeState, 'verified' | 'out_of_scope'>;
}

/**
 * Whether `candidate` is the proven host or a subdomain of it.
 *
 * Label-wise, not textual: the `'.' + proven` suffix is what makes
 * `notapple.com` fail against `apple.com` while `store.apple.com` passes. Both
 * inputs are expected already normalized (lowercase, no scheme, no port) —
 * `merchant.service.normalizeDomain` is the one normalizer, and the database
 * CHECK on every domain column holds the same form.
 */
export function domainIsCoveredBy(candidate: string, proven: string): boolean {
  return candidate === proven || candidate.endsWith(`.${proven}`);
}

/**
 * Resolve every requested scope entry against one proof.
 *
 * `merchant` entries are verified by ANY successful proof — the proof is what
 * makes the claimant the merchant's operator, and the merchant is the claim's
 * subject by construction. `domain` and `storefront` entries are verified only
 * when the proof actually reaches them.
 *
 * A requested storefront that belongs to a DIFFERENT merchant is
 * `out_of_scope` even if the proof would otherwise cover it: a claim is about
 * one merchant, and a proof of a shared domain must not sweep up somebody
 * else's channel.
 */
export function resolveProvenScope(params: {
  merchantId: string;
  requested: readonly RequestedScopeEntry[];
  proof: ClaimProofSubject;
  /** Every storefront named by a requested `storefront` entry, in any order. */
  storefronts: readonly ScopeStorefrontFacts[];
}): ResolvedScopeEntry[] {
  const byId = new Map(params.storefronts.map((row) => [row.id, row]));

  return params.requested.map((entry): ResolvedScopeEntry => {
    if (entry.kind === 'merchant') {
      return {
        ...entry,
        state: entry.ref === params.merchantId ? 'verified' : 'out_of_scope',
      };
    }

    if (entry.kind === 'domain') {
      const covered =
        params.proof.kind === 'domain'
          ? domainIsCoveredBy(entry.ref, params.proof.domain)
          : // A platform connection proves a domain only when the platform
            // itself reports one for that shop — never by inference from the
            // shop's name.
            params.proof.shopDomain !== null &&
            domainIsCoveredBy(entry.ref, params.proof.shopDomain);
      return { ...entry, state: covered ? 'verified' : 'out_of_scope' };
    }

    const storefront = byId.get(entry.ref);
    if (!storefront || storefront.merchantId !== params.merchantId) {
      return { ...entry, state: 'out_of_scope' };
    }
    return {
      ...entry,
      state: storefrontIsCovered(storefront, params.proof) ? 'verified' : 'out_of_scope',
    };
  });
}

/**
 * Whether one storefront falls inside a proof.
 *
 * A domain proof reaches a channel addressed by that domain. A connection
 * proof reaches the channel with the SAME source identity — `(provider,
 * externalShopId)`, the convergence key `storefronts` is already unique on —
 * and, failing that, a channel on the shop's own host. Scope rule 2 is exactly
 * this narrowness: the proof says "I run this shop", not "I own these brands".
 */
function storefrontIsCovered(
  storefront: ScopeStorefrontFacts,
  proof: ClaimProofSubject,
): boolean {
  if (proof.kind === 'domain') {
    return storefront.domain !== null && domainIsCoveredBy(storefront.domain, proof.domain);
  }
  if (
    storefront.provider !== null &&
    storefront.provider === proof.provider &&
    storefront.externalShopId !== null &&
    proof.externalShopId !== null &&
    storefront.externalShopId === proof.externalShopId
  ) {
    return true;
  }
  return (
    proof.shopDomain !== null &&
    storefront.domain !== null &&
    domainIsCoveredBy(storefront.domain, proof.shopDomain)
  );
}
