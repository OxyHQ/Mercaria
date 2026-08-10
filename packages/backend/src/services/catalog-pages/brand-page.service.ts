/**
 * The brand page (#72 brand rules 1–10, acceptances 1, 2, 4, 6 and 7).
 *
 * ## A brand page is not a merchant storefront, and the type says so
 *
 * {@link BrandPage} has no channel of its own, no listing, no inventory and no
 * seller of record. A merchant appears only as the SUBJECT of a verified
 * relationship, in two separate lists, and a retailer selling the brand without
 * one appears in neither — which is the normal state (ADR 0002 D10) and is why
 * the empty lists are rendered as "no verified channels recorded" rather than
 * as a missing section. #73 owns merchant and storefront pages; the two domains
 * meet at a link and nowhere else.
 *
 * ## The offer half can be WITHDRAWN without taking the page down
 *
 * #60 split `CANONICAL_READS` from `CANONICAL_OFFER_COMPARISON` precisely so
 * that "withdrawing price comparison during an incident should not take the
 * brand and product identity pages down with it" — its own words. So the mount
 * is gated by the first lever and the offer summaries by the second, and a page
 * whose offer half was withdrawn says `offerContext: 'withdrawn'` rather than
 * quietly showing a catalogue nobody appears to sell.
 */

import type {
  BrandCategoryEntry,
  BrandFamilyEntry,
  BrandPage,
  CatalogBrowseFilters,
  CatalogOfferContextState,
  CatalogProductBrowsePage,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countCatalogScopeProducts,
  listBrandCategoryRollup,
  listBrandFamilies,
} from '../../db/catalogPages/catalogPageRepository.js';
import { listBrandAliases, listBrandSourceLinks } from '../../db/canonical/brandRepository.js';
import { findSourceRecordsByIds } from '../../db/canonical/provenanceRepository.js';
import { readBrandChannels, readBrandOwningOrganization } from './official-channels.js';
import { brandBreadcrumbs, brandIndexability, brandStructuredData } from './page-policy.js';
import { resolveBrandHandle } from './resolve.js';
import {
  projectAsset,
  projectText,
  resolveEntityFieldRights,
  resolveSourceRecordDisplayRights,
} from './rights.js';
import { browseCatalogProducts } from './product-browse.service.js';

/** How many families and categories a brand page lists before it stops. */
const BRAND_FAMILY_LIMIT = 50;
const BRAND_CATEGORY_LIMIT = 25;

export interface BrandPageRequest {
  readonly handle: string;
  /** ISO 3166-1 alpha-2. Absent means "any scope" for the channel lists. */
  readonly market?: string;
  readonly offerContext: CatalogOfferContextState;
  readonly now?: Date;
}

/** The composed brand page, or `undefined` when nothing resolves. */
export async function readBrandPage(
  request: BrandPageRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<BrandPage | undefined> {
  const now = request.now ?? new Date();
  const resolved = await resolveBrandHandle(db, request.handle);
  if (resolved === undefined) return undefined;
  const brand = resolved.row;

  const [aliases, sourceLinks, counts, families, categories, channels, owner] = await Promise.all([
    listBrandAliases(db, brand.id),
    listBrandSourceLinks(db, brand.id, 'active'),
    countCatalogScopeProducts(db, { kind: 'brand', brandId: brand.id }),
    listBrandFamilies(db, brand.id, BRAND_FAMILY_LIMIT),
    listBrandCategoryRollup(db, brand.id, BRAND_CATEGORY_LIMIT),
    readBrandChannels(db, {
      brandId: brand.id,
      ...(request.market === undefined ? {} : { market: request.market }),
      now,
    }),
    readBrandOwningOrganization(db, {
      brandId: brand.id,
      ...(request.market === undefined ? {} : { market: request.market }),
      now,
    }),
  ]);

  const records = await findSourceRecordsByIds(
    db,
    sourceLinks.map((link) => link.sourceRecordId),
  );
  const latest = records.reduce<(typeof records)[number] | undefined>(
    (best, record) => (!best || record.observedAt > best.observedAt ? record : best),
    undefined,
  );

  const descriptionRights = await resolveEntityFieldRights(db, {
    field: 'description',
    pinnedFields: brand.pinnedFields,
    latestSourceRecordId: latest === undefined ? null : latest.id,
  });
  const logoRights = await resolveSourceRecordDisplayRights(db, brand.logoSourceRecordId);

  const canonicalPath = `/brands/${brand.slug}`;
  const indexability = brandIndexability({
    merged: brand.mergedIntoId !== null,
    // The INDEX right of whichever source last described the brand. A source
    // that permits display but refuses indexing is a real contract shape (#62
    // models them separately), and honouring only the display half would put a
    // page a partner asked us not to publish into a crawler's hands.
    mayIndex: descriptionRights.mayIndex,
    productCount: counts.total,
  });

  const page: BrandPage = {
    brandId: brand.id,
    slug: brand.slug,
    name: brand.name,
    description: projectText(brand.description, descriptionRights),
    logo: projectAsset(brand.logoFileId, logoRights),
    ...(brand.websiteUrl === null ? {} : { websiteUrl: brand.websiteUrl }),
    aliases: aliases.map((alias) => alias.alias),
    ...(owner === undefined ? {} : { owningOrganization: owner }),
    channels,
    families: families.map(
      (family): BrandFamilyEntry => ({
        familyId: family.familyId,
        slug: family.slug,
        name: family.name,
        productCount: family.productCount,
      }),
    ),
    categories: categories.map(
      (category): BrandCategoryEntry => ({
        categoryId: category.categoryId,
        slug: category.slug,
        name: category.name,
        productCount: category.productCount,
      }),
    ),
    productCount: counts.total,
    breadcrumbs: brandBreadcrumbs(brand),
    indexability,
    structuredData: { kind: 'none' },
    canonicalPath,
    ...(resolved.redirect === undefined ? {} : { redirect: resolved.redirect }),
  };

  // Composed from the PAGE rather than from the row, which is what makes "only
  // when visible facts support it" mechanical — see `page-policy.ts`.
  return {
    ...page,
    structuredData: brandStructuredData({ page, canonicalUrl: canonicalPath, indexability }),
  };
}

/** One page of the brand's products (#72 brand rule 4, product-browse rules). */
export async function readBrandProducts(
  request: {
    handle: string;
    filters: CatalogBrowseFilters;
    limit?: number;
    cursor?: string;
    offerContext: CatalogOfferContextState;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<CatalogProductBrowsePage | undefined> {
  const resolved = await resolveBrandHandle(db, request.handle);
  if (resolved === undefined) return undefined;
  return browseCatalogProducts(
    {
      scope: { kind: 'brand', brandId: resolved.row.id },
      filters: request.filters,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      offerContext: request.offerContext,
      ...(request.now === undefined ? {} : { now: request.now }),
    },
    db,
  );
}
