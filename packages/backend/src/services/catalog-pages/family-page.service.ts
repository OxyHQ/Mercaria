/**
 * The product-family page (#72 family rules 1–7, acceptance 6).
 *
 * A family is brand → family → product, the navigation path a brand page walks
 * (#56's own words). What this page adds over the brand's grid is the three
 * facts that are true of the family and not of any one generation: which
 * attributes every member SHARES, what the whole family currently costs, and
 * the ordering that does or does not imply a chronology.
 *
 * ## `publishable` says what `indexability` cannot
 *
 * A family with one member says exactly what that product's own page says.
 * It still ANSWERS — its identity is real and an old link must resolve — and it
 * reports `publishable: false` plus `indexability: 'thin'`, so a client can
 * choose to redirect to the single product and #75's sitemap can leave it out.
 * Refusing to serve it would break the redirect chain a merge depends on.
 *
 * ## The price range is over the CARDS, not over a second query
 *
 * Each generation contributes its own `summary.lowestPrice`, which #68 derived
 * from the offers a comparison would show. So the range and the grid cannot
 * disagree, and a family whose offers all expired reports NO range rather than
 * a range of zero.
 */

import type {
  CatalogBrowseFilters,
  CatalogFamilySharedAttribute,
  CatalogOfferContextState,
  CatalogProductBrowsePage,
  CurrencyCode,
  ProductFamilyPage,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countCatalogScopeProducts,
  listFamilySharedAttributes,
} from '../../db/catalogPages/catalogPageRepository.js';
import { findBrandById } from '../../db/canonical/brandRepository.js';
import { listProductFamilySourceLinks } from '../../db/canonical/productFamilyRepository.js';
import { findSourceRecordsByIds } from '../../db/canonical/provenanceRepository.js';
import {
  FAMILY_PUBLISHABLE_MIN_PRODUCTS,
  familyBreadcrumbs,
  familyIndexability,
} from './page-policy.js';
import { deriveFamilyPriceRange } from './price-range.js';
import { browseCatalogProducts } from './product-browse.service.js';
import { resolveFamilyHandle } from './resolve.js';
import { projectText, resolveEntityFieldRights } from './rights.js';

/** How many shared attributes a family header lists before it stops. */
const FAMILY_SHARED_ATTRIBUTE_LIMIT = 24;

/**
 * How many generations the price range is derived from.
 *
 * A page-sized window rather than the whole family, because the range is
 * composed from CARDS and a card is what the grid already fetched. A family
 * with more generations than this is one whose exact range nobody is deciding
 * anything from, and the alternative — a second, wider offer read purely for a
 * headline — would be a second derivation of "cheapest" beside the grid's.
 */
const FAMILY_PRICE_RANGE_WINDOW = 48;

export interface FamilyPageRequest {
  readonly handle: string;
  readonly market?: string;
  /** The currency the price range is stated in. Named, never assumed. */
  readonly currency: CurrencyCode;
  readonly offerContext: CatalogOfferContextState;
  readonly now?: Date;
}

/** The composed family page, or `undefined` when nothing resolves. */
export async function readProductFamilyPage(
  request: FamilyPageRequest,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProductFamilyPage | undefined> {
  const now = request.now ?? new Date();
  const resolved = await resolveFamilyHandle(db, request.handle);
  if (resolved === undefined) return undefined;
  const family = resolved.row;

  const counts = await countCatalogScopeProducts(db, { kind: 'family', familyId: family.id });
  const brand = family.brandId === null ? undefined : await findBrandById(db, family.brandId);

  const sourceLinks = await listProductFamilySourceLinks(db, family.id, 'active');
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
    pinnedFields: family.pinnedFields,
    latestSourceRecordId: latest === undefined ? null : latest.id,
  });

  const sharedAttributes = await listFamilySharedAttributes(
    db,
    family.id,
    counts.total,
    FAMILY_SHARED_ATTRIBUTE_LIMIT,
  );

  // The range comes from a page of the family's OWN grid, with no filters: a
  // headline range narrowed by whatever the reader happened to filter on would
  // describe a subset while reading as a fact about the family.
  const priceRange =
    request.offerContext === 'withdrawn'
      ? undefined
      : await deriveFamilyPriceRange(
          (
            await browseCatalogProducts(
              {
                scope: { kind: 'family', familyId: family.id },
                filters: {},
                limit: FAMILY_PRICE_RANGE_WINDOW,
                offerContext: request.offerContext,
                now,
              },
              db,
            )
          ).products,
          request.currency,
        );

  return {
    familyId: family.id,
    slug: family.slug,
    name: family.name,
    description: projectText(family.description, descriptionRights),
    ...(brand === undefined
      ? {}
      : { brand: { brandId: brand.id, slug: brand.slug, name: brand.name } }),
    ...(family.categoryId === null ? {} : { categoryId: family.categoryId }),
    productCount: counts.total,
    publishable: counts.total >= FAMILY_PUBLISHABLE_MIN_PRODUCTS,
    sharedAttributes: sharedAttributes.map(
      (attribute): CatalogFamilySharedAttribute => ({
        key: attribute.key,
        value: attribute.value,
      }),
    ),
    ...(priceRange === undefined ? {} : { priceRange }),
    offerContext: request.offerContext,
    breadcrumbs: familyBreadcrumbs(
      family,
      brand === undefined ? undefined : { id: brand.id, slug: brand.slug, name: brand.name },
    ),
    indexability: familyIndexability({
      merged: family.mergedIntoId !== null,
      mayIndex: descriptionRights.mayIndex,
      productCount: counts.total,
    }),
    canonicalPath: `/families/${family.slug}`,
    ...(resolved.redirect === undefined ? {} : { redirect: resolved.redirect }),
  };
}

/** One page of the family's generations (#72 family rules 2, 5 and 6). */
export async function readProductFamilyProducts(
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
  const resolved = await resolveFamilyHandle(db, request.handle);
  if (resolved === undefined) return undefined;
  return browseCatalogProducts(
    {
      scope: { kind: 'family', familyId: resolved.row.id },
      filters: request.filters,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      offerContext: request.offerContext,
      ...(request.now === undefined ? {} : { now: request.now }),
    },
    db,
  );
}
