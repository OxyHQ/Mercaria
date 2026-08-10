/**
 * The brand page's official channels and its owning organization (#72 brand
 * rules 2, 6 and 7; official-channel rules 1–6; acceptances 1, 3 and 4).
 *
 * ## This module DERIVES no relationship and it never could
 *
 * The two lists come from #55's own public resolver, `listBrandChannels`,
 * verbatim. That resolver filters on `status = 'verified'` AND evaluates the
 * validity window in the statement, so a claim that lapsed an hour ago produces
 * no badge whether or not any sweep has run — and calling it rather than
 * re-deriving is what keeps that guarantee ONE piece of code. There is no name
 * comparison, no logo comparison, no domain comparison and no volume threshold
 * anywhere in this file, and `catalog-page-isolation.test.ts` fails the build
 * if one appears.
 *
 * ## The one thing #55 does not publish, and why it is read HERE
 *
 * `organization_owns_brand` carries `publicBadge: null`, so #55's public
 * resolver — which exists to answer badge questions — does not project it.
 * #72 brand rule 2 needs it: the owning organization may be shown only when a
 * verified relationship supports it. So this module reads the SAME repository
 * function every public relationship read goes through
 * (`findCurrentRelationships`, where the `status = 'verified'` filter and the
 * validity window both live) and adds only a projection. The temporal rule is
 * consumed, not restated; what is new is a DTO with no evidence, no reviewer,
 * no actor and no confidence field for one to ride along in.
 *
 * ## Market scope is reported, never widened
 *
 * A relationship scoped to `{ES}` is not a global claim (#72 official-channel
 * rule 4), so every entry carries its own `territories` and the page states the
 * market it was resolved FOR. An EMPTY array is the `commerce_relationships`
 * semantics for "unrestricted" and is passed through as such — the two are
 * different facts and a client renders them differently.
 */

import type {
  BrandChannelEntry,
  BrandOfficialChannels,
  BrandOwningOrganization,
  PublicCommerceRelationship,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { findCurrentRelationships } from '../../db/commerce-graph/relationshipRepository.js';
import { findMerchantRefs } from '../../db/catalogPages/catalogPageRepository.js';
import { findOrganizationById } from '../../db/canonical/organizationRepository.js';
import { listBrandChannels } from '../commerce-graph/relationship-resolution.js';

/**
 * Both lists, with each merchant's display identity attached.
 *
 * A relationship whose merchant cannot be loaded is DROPPED rather than shown
 * with a placeholder name: an entry a shopper cannot click through to is a
 * badge with nothing behind it, and inventing a label for it would be the page
 * asserting a relationship it cannot show the other end of.
 */
export async function readBrandChannels(
  db: DatabaseOrTransaction,
  input: { brandId: string; market?: string; now: Date },
): Promise<BrandOfficialChannels> {
  const directory = await listBrandChannels({
    brandId: input.brandId,
    ...(input.market === undefined ? {} : { market: input.market }),
    at: input.now,
  });

  const merchantIds = [
    ...new Set(
      [...directory.officialChannels, ...directory.authorizedResellers].map(
        (relationship) => relationship.subjectId,
      ),
    ),
  ];
  const merchants = await findMerchantRefs(db, merchantIds);
  const byId = new Map(merchants.map((merchant) => [merchant.id, merchant]));

  const project = (relationships: readonly PublicCommerceRelationship[]): BrandChannelEntry[] => {
    const entries: BrandChannelEntry[] = [];
    for (const relationship of relationships) {
      const merchant = byId.get(relationship.subjectId);
      if (merchant === undefined) continue;
      if (relationship.badge === null) continue;
      entries.push({
        relationshipId: relationship.id,
        merchantId: merchant.id,
        merchantName: merchant.name,
        merchantSlug: merchant.slug,
        badge: relationship.badge,
        evidence: 'verified_relationship',
        territories: relationship.territories,
        validFrom: relationship.validFrom,
        ...(relationship.validTo === null ? {} : { validTo: relationship.validTo }),
        ...(relationship.storefrontId === null ? {} : { storefrontId: relationship.storefrontId }),
      });
    }
    return entries.sort((left, right) =>
      left.merchantName.localeCompare(right.merchantName, 'en'),
    );
  };

  return {
    market: directory.market,
    officialStores: project(directory.officialChannels),
    authorizedResellers: project(directory.authorizedResellers),
  };
}

/**
 * The verified owner of a brand, or `undefined`.
 *
 * `undefined` is the normal state: most brands in a crawled catalogue have no
 * verified corporate owner recorded, and #55 makes exactly one verified owner
 * per brand possible at a time. When two somehow stand, the FIRST by the
 * repository's own ordering (newest verification) is taken and the rest are
 * ignored — under-claiming rather than listing two legal entities as owners of
 * one brand, the direction #55's own conflict resolution already chose.
 */
export async function readBrandOwningOrganization(
  db: DatabaseOrTransaction,
  input: { brandId: string; market?: string; now: Date },
): Promise<BrandOwningOrganization | undefined> {
  const rows = await findCurrentRelationships(db, {
    kinds: ['organization_owns_brand'],
    brandId: input.brandId,
    ...(input.market === undefined ? {} : { market: input.market.toUpperCase() }),
    at: input.now,
  });

  for (const row of rows) {
    if (row.organizationId === null) continue;
    const organization = await findOrganizationById(db, row.organizationId);
    if (!organization) continue;
    return {
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      relationshipId: row.id,
      evidence: 'verified_relationship',
      validFrom: row.validFrom.toISOString(),
      ...(row.validTo === null ? {} : { validTo: row.validTo.toISOString() }),
    };
  }
  return undefined;
}
