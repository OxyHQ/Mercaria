/**
 * The merchant page (#73 merchant requirements 1–11, storefront rules 1–6,
 * relationship display 1–3, trust and privacy 1–5).
 *
 * ## It reads eleven things and owns none of them
 *
 * The identity and its tombstone policy are #54's, the claim verdict is #83's,
 * the relationships are #55's, the native-store link is #54's, the offers are
 * #57's, their freshness is #68's, the rating is #76's and the products are
 * #56's. This module composes them into one response and adds exactly three
 * derivations nobody else makes: the public STANDING, the two-directional
 * CHANNEL split, and the three-state BRAND standing. All three are pure
 * functions over facts fetched here, computed per request and stored nowhere —
 * the `deriveNativeCheckoutEligibility` divergence from the one-stored-verdict
 * rule, taken because their inputs sit on tables this domain does not own and a
 * stored copy could outlive a revoked claim, a lapsed relationship or a
 * moderation restriction.
 *
 * ## The two channel lists are the marketplace guarantee
 *
 * ADR 0002 D8 makes an offer a marketplace offer by comparing its seller of
 * record against the operator of the channel it sits on. A page with one
 * channel list has to pick which side of that comparison it means, and either
 * choice is wrong for half of the merchants: a first-party retailer's country
 * sites are channels it OPERATES, and a marketplace seller's channels are ones
 * somebody else operates. So there are two lists, each entry carries its
 * operator, and `operatedByThisMerchant` is the comparison already made.
 *
 * ## What the page cannot say
 *
 * `MERCHANT_PAGE_FORBIDDEN_FIELDS` names claim evidence, operator notes, an
 * address inferred from payment onboarding, an unpublished physical location
 * and every native-store internal. None of them has a field, and
 * `merchant-page-isolation.test.ts` walks a REAL emitted page for each name as
 * well as scanning the source — because a static scan cannot see a key a
 * spread put there.
 */

import type {
  Merchant,
  MerchantBrandStanding,
  MerchantOrganizationUsefulness,
  MerchantPage,
  MerchantPageAlias,
  MerchantPageChannel,
  MerchantPageContact,
  MerchantPageOrganization,
  MerchantPageStanding,
  PublicCommerceRelationship,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { notFound, validationError } from '../../lib/errors/error-codes.js';
import { listMerchantAliases } from '../../db/commerce-graph/merchantRepository.js';
import { findActiveLinkByMerchant } from '../../db/commerce-graph/nativeStoreLinkRepository.js';
import {
  findStorefrontsByIds,
  findStorefrontsByMerchant,
  type StorefrontRow,
} from '../../db/commerce-graph/storefrontRepository.js';
import { findCurrentRelationships } from '../../db/commerce-graph/relationshipRepository.js';
import { loadBrandRefs } from '../../db/search/searchCandidateRepository.js';
import {
  countMerchantBrandOffers,
  countMerchantChannelOffers,
  countMerchantOfferCensus,
  findLinkedStoreIdentity,
  findMerchantNames,
} from '../../db/merchantPages/merchantCatalogRepository.js';
import { getMerchantPublic, getNativeCheckoutEligibility } from '../commerce-graph/merchant.service.js';
import { toStorefrontDTO } from '../commerce-graph/storefront.service.js';
import { listMerchantBrandRelationships } from '../commerce-graph/relationship-resolution.js';
import { getClaimEligibility } from '../merchant-claims/merchant-claim.service.js';
import { getPublicOrganization } from '../canonical/organization.service.js';
import { getScopedAggregate } from '../reviews/review-aggregate.service.js';
import { summariseMerchantOfferMix } from './offer-mix.js';
import { deriveMerchantPublicStanding } from './standing.js';
import { toMerchantPageNativeStore } from './native-store.js';
import { resolveChannelOutbound } from './outbound.js';

/**
 * How many brands a merchant page enumerates.
 *
 * A bound rather than every brand in the catalogue, because the question a
 * merchant page answers is "which brands is this shop mainly about" and a
 * thousand-brand list is not an answer anybody reads. The verified badges are
 * merged in whether or not they clear the bound, so a relationship somebody
 * approved is never dropped for being long-tail.
 */
const BRAND_STANDING_LIMIT = 24;

/** Map an alias row onto its public shape. Provenance and actors stay internal. */
function toAlias(row: { alias: string; kind: string; language: string | null }): MerchantPageAlias {
  return { alias: row.alias, kind: row.kind, language: row.language };
}

/**
 * Build one channel entry.
 *
 * `operatorName` is the operating merchant's display name when it is somebody
 * OTHER than the merchant whose page this is — because that is the case the
 * name is needed for ("on Amazon"), and because printing a merchant's own name
 * back at it inside its own channel list is noise. `null` means "the operator
 * is this merchant", which `operatedByThisMerchant` already states.
 */
function toChannel(input: {
  row: StorefrontRow;
  pageMerchantId: string;
  operatorName: string | null;
  currentOfferCount: number;
}): MerchantPageChannel {
  const operatedByThisMerchant = input.row.merchantId === input.pageMerchantId;
  return {
    storefront: toStorefrontDTO(input.row),
    operatorMerchantId: input.row.merchantId,
    operatorName: operatedByThisMerchant ? null : input.operatorName,
    operatedByThisMerchant,
    currentOfferCount: input.currentOfferCount,
    outbound: resolveChannelOutbound(input.row.id),
  };
}

/** A channel a public page may show — suppressed and merged rows are neither. */
function isPubliclyVisible(row: StorefrontRow): boolean {
  return row.status !== 'suppressed' && row.status !== 'merged';
}

/**
 * The operating legal entity, when a verified claim covers this instant AND it
 * tells a reader something (#73 merchant requirement 3).
 *
 * #55 restricts its own public relationship reads to the two BADGE kinds, so
 * this read goes to the repository directly for `organization_operates_merchant`
 * — a different question from a badge, and one requirement 3 asks by name. What
 * is published is the ORGANIZATION's own public identity plus the instant the
 * claim was verified; the relationship row, its evidence, its reviewer and its
 * confidence are not published in any form, which is #55's rule holding rather
 * than being worked around.
 */
async function resolveOrganization(
  merchant: Merchant,
  at: Date,
): Promise<{
  organization?: MerchantPageOrganization;
  usefulness?: MerchantOrganizationUsefulness;
}> {
  const rows = await findCurrentRelationships(getDb(), {
    kinds: ['organization_operates_merchant'],
    merchantId: merchant.id,
    at,
  });
  const row = rows[0];
  if (row === undefined || row.organizationId === null || row.verifiedAt === null) return {};

  const organization = await getPublicOrganization(row.organizationId);
  if (organization === undefined) return {};

  // "Only when verified AND USEFUL". An operator whose name is the merchant's
  // own name repeats the headline and tells a reader nothing, so it is withheld
  // WITH ITS REASON — "there is no verified operator" and "there is one and we
  // judged it redundant" are different facts and only the first is a gap.
  if (organization.name.trim().toLowerCase() === merchant.name.trim().toLowerCase()) {
    return { usefulness: 'same_name_as_merchant' };
  }

  return {
    organization: {
      organizationId: organization.id,
      slug: organization.slug,
      name: organization.name,
      legalName: organization.legalName ?? null,
      countryCode: organization.countryCode ?? null,
      verifiedAt: row.verifiedAt.toISOString(),
    },
    usefulness: 'useful',
  };
}

/**
 * The three brand states (#73 relationship display 1–3).
 *
 * Built from the union of two sets that answer different questions: the brands
 * #55 has VERIFIED something about, and the brands this merchant's current
 * offers actually cover. Neither alone is enough — a verified badge for a brand
 * the merchant has stopped stocking still belongs on the page, and the third
 * state exists only for brands with no relationship row at all, which by
 * construction cannot be enumerated from the relationship table.
 */
async function resolveBrandStandings(
  merchantId: string,
  at: Date,
): Promise<MerchantBrandStanding[]> {
  const db = getDb();
  const [verified, counted] = await Promise.all([
    listMerchantBrandRelationships({ merchantId, at }),
    countMerchantBrandOffers(db, { merchantId, limit: BRAND_STANDING_LIMIT, now: at }),
  ]);

  const countByBrand = new Map(counted.map((row) => [row.brandId, row.currentOfferCount]));
  const relationshipByBrand = new Map<string, PublicCommerceRelationship>();
  for (const relationship of verified) {
    // The subject of both badge kinds is the merchant and the object is the
    // brand (#55's kind registry), so `objectId` is the brand id. The direct
    // channel wins a tie, which is the resolver's own precedence: calling a
    // brand's own store an authorized reseller understates a true relationship,
    // while the reverse asserts one that does not exist.
    const existing = relationshipByBrand.get(relationship.objectId);
    if (existing === undefined || relationship.badge === 'official_store') {
      relationshipByBrand.set(relationship.objectId, relationship);
    }
  }

  const brandIds = [...new Set([...relationshipByBrand.keys(), ...countByBrand.keys()])];
  const brands = await loadBrandRefs(db, brandIds);

  return brands
    .map((brand): MerchantBrandStanding => {
      const relationship = relationshipByBrand.get(brand.id);
      const badge = relationship?.badge ?? null;
      return {
        brandId: brand.id,
        brandSlug: brand.slug,
        brandName: brand.name,
        standing:
          badge === 'official_store'
            ? 'official_store'
            : badge === 'authorized_reseller'
              ? 'authorized_reseller'
              : 'no_verified_relationship',
        badge,
        ...(relationship === undefined ? {} : { relationship }),
        currentOfferCount: countByBrand.get(brand.id) ?? 0,
      };
    })
    .sort(
      (a, b) =>
        b.currentOfferCount - a.currentOfferCount || a.brandName.localeCompare(b.brandName),
    );
}

/**
 * What the page may say about reaching this merchant (#73 merchant requirement
 * 10, trust rules 2 and 3).
 *
 * A verified native store means its operator manages policies and support
 * inside Mercaria, and the page hands over the handle so a buyer reaches them
 * through the store APIs that own them. Otherwise the most Mercaria holds is a
 * public URL on a VERIFIED channel — the retailer's own site, which they
 * published. With neither, the page says nothing, because everything else
 * Mercaria could reach for is either a payment-onboarding record or a warehouse
 * address, and neither is a shop somebody chose to publish.
 */
function resolveContact(input: {
  nativeStoreHandle?: string;
  channels: readonly MerchantPageChannel[];
}): MerchantPageContact {
  if (input.nativeStoreHandle !== undefined) {
    return { source: 'native_store', nativeStoreHandle: input.nativeStoreHandle };
  }
  const verified = input.channels.find(
    (channel) =>
      channel.operatedByThisMerchant &&
      channel.storefront.verificationState === 'verified' &&
      channel.storefront.publicUrl !== null,
  );
  const publicUrl = verified?.storefront.publicUrl;
  if (publicUrl === undefined || publicUrl === null) return { source: 'none' };
  return { source: 'verified_channel', publicUrl };
}

/**
 * The whole page.
 *
 * `getMerchantPublic` resolves the id-or-slug, follows a merge tombstone and
 * refuses a suppressed row — #54's policy, called rather than re-implemented,
 * so an old merchant URL keeps answering with its winner here exactly as it
 * does on the identity route.
 */
export async function getMerchantPage(idOrSlug: string, now: Date = new Date()): Promise<MerchantPage> {
  const profile = await getMerchantPublic(idOrSlug);
  const merchant: Merchant = profile.merchant;
  const db = getDb();

  const [
    aliasRows,
    eligibility,
    nativeCheckout,
    organizationResult,
    operatedRows,
    sellingCounts,
    census,
    brandStandings,
    reviews,
    activeLink,
  ] = await Promise.all([
    listMerchantAliases(db, merchant.id),
    getClaimEligibility(merchant.id),
    getNativeCheckoutEligibility(merchant.id),
    resolveOrganization(merchant, now),
    findStorefrontsByMerchant(db, merchant.id),
    countMerchantChannelOffers(db, { merchantId: merchant.id, now }),
    countMerchantOfferCensus(db, { merchantId: merchant.id, scope: { kind: 'merchant' }, now }),
    resolveBrandStandings(merchant.id, now),
    getScopedAggregate('merchant', merchant.id),
    findActiveLinkByMerchant(db, merchant.id),
  ]);

  const countByStorefront = new Map(
    sellingCounts.map((row) => [row.storefrontId, row.currentOfferCount]),
  );

  const operatedChannels = operatedRows.filter(isPubliclyVisible).map((row) =>
    toChannel({
      row,
      pageMerchantId: merchant.id,
      operatorName: null,
      currentOfferCount: countByStorefront.get(row.id) ?? 0,
    }),
  );

  // The channels this merchant SELLS THROUGH but does not operate — read
  // separately because `findStorefrontsByMerchant` answers the other question.
  const operatedIds = new Set(operatedRows.map((row) => row.id));
  const foreignChannelIds = sellingCounts
    .map((row) => row.storefrontId)
    .filter((id) => !operatedIds.has(id));
  const foreignRows = (await findStorefrontsByIds(db, foreignChannelIds)).filter(isPubliclyVisible);
  const operatorNames = new Map(
    (await findMerchantNames(db, [...new Set(foreignRows.map((row) => row.merchantId))])).map(
      (row) => [row.id, row.name],
    ),
  );
  const sellingChannels = [
    ...operatedChannels.filter((channel) => channel.currentOfferCount > 0),
    ...foreignRows.map((row) =>
      toChannel({
        row,
        pageMerchantId: merchant.id,
        operatorName: operatorNames.get(row.merchantId) ?? null,
        currentOfferCount: countByStorefront.get(row.id) ?? 0,
      }),
    ),
  ];

  const store =
    activeLink === undefined ? undefined : await findLinkedStoreIdentity(db, activeLink.storeId);
  const nativeStore =
    activeLink === undefined || store === undefined
      ? undefined
      : toMerchantPageNativeStore({
          storeId: store.id,
          handle: store.handle,
          name: store.name,
          linkedAt: activeLink.verifiedAt,
        });

  const standing: MerchantPageStanding = {
    standing: deriveMerchantPublicStanding({
      claimState: merchant.claimState,
      claimInProgress: eligibility.claimInProgress,
      nativeCheckout,
    }),
    claimState: merchant.claimState,
    nativeCheckout,
    eligibility,
  };

  return {
    merchant,
    ...(profile.redirectedFrom === undefined ? {} : { redirectedFrom: profile.redirectedFrom }),
    aliases: aliasRows.map(toAlias),
    standing,
    ...(organizationResult.organization === undefined
      ? {}
      : { organization: organizationResult.organization }),
    ...(organizationResult.usefulness === undefined
      ? {}
      : { organizationUsefulness: organizationResult.usefulness }),
    operatedChannels,
    sellingChannels,
    ...(nativeStore === undefined ? {} : { nativeStore }),
    verifiedDomains: profile.verifiedDomains,
    reviews,
    brandStandings,
    offerMix: summariseMerchantOfferMix(census),
    contact: resolveContact({
      ...(nativeStore === undefined ? {} : { nativeStoreHandle: nativeStore.handle }),
      channels: operatedChannels,
    }),
  };
}

/**
 * Resolve a browse scope from a merchant page's own request parameters.
 *
 * `channel_all_sellers` is refused for a channel this merchant does not
 * operate, and the refusal names the rule: somebody else's channel is somebody
 * else's page, and serving its whole catalogue here would make one merchant's
 * route a viewer for another's inventory. A channel this merchant merely SELLS
 * through is fine under `merchant_on_channel`, which is the marketplace-seller
 * case and stays narrowed to this merchant's own offers.
 */
export async function resolveCatalogScope(input: {
  merchantId: string;
  storefrontId?: string;
  allSellers: boolean;
}): Promise<
  | { readonly kind: 'merchant' }
  | { readonly kind: 'merchant_on_channel'; readonly storefrontId: string }
  | { readonly kind: 'channel_all_sellers'; readonly storefrontId: string }
> {
  if (input.storefrontId === undefined) return { kind: 'merchant' };

  const [row] = await findStorefrontsByIds(getDb(), [input.storefrontId]);
  if (row === undefined || !isPubliclyVisible(row)) {
    throw notFound('Storefront not found');
  }
  if (!input.allSellers) return { kind: 'merchant_on_channel', storefrontId: input.storefrontId };
  if (row.merchantId !== input.merchantId) {
    throw validationError(
      'Every seller on a channel can only be browsed from the page of the merchant that ' +
        'operates it. This merchant sells through that channel; it does not run it.',
    );
  }
  return { kind: 'channel_all_sellers', storefrontId: input.storefrontId };
}
