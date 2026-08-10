/**
 * What a catalogue page may CLAIM about itself — indexability, structured data
 * and breadcrumbs (#72 SEO rules 1–5, family "use a family page only when…").
 *
 * Every function here is PURE, over facts the page already shows. That is the
 * whole design: #72 SEO rule 2 asks for structured data "only when visible facts
 * support it", and the way to keep that true is to derive the JSON-LD from the
 * SAME projection the reader sees rather than from a second read of the same
 * tables. A withheld logo is absent from both; a description nobody may display
 * is asserted in neither.
 *
 * ## Thin is not broken
 *
 * A brand with an identity and no products, and a family with one member, both
 * ANSWER — an old link must resolve and the identity is real — and both report
 * `thin`. #75 owns the sitemap and this domain builds none; what it publishes
 * is the verdict a sitemap builder needs, so "only public, non-thin pages" is a
 * decision somebody can implement rather than a sentence in an issue.
 *
 * ## A tombstone is not indexable and is not thin either
 *
 * A merged entity redirects, so its page is a hop rather than a destination.
 * `merged` is its own verdict because a sitemap must exclude it and a client
 * must rewrite its URL, and neither of those is what `thin` asks for.
 */

import type {
  BrandPage,
  CatalogBreadcrumb,
  CatalogPageIndexability,
  CatalogPageAsset,
  CatalogPageText,
  CatalogStructuredData,
} from '@mercaria/shared-types';

/**
 * How many live products a brand page needs before it says more than a search
 * result would.
 *
 * ONE, deliberately, and the reason it is not higher: a brand page's value is
 * not only its grid — its verified official channels are a fact nothing else in
 * Mercaria publishes, and a brand with one product and an official store is a
 * page worth indexing. The FAMILY threshold is higher for the opposite reason;
 * see {@link FAMILY_PUBLISHABLE_MIN_PRODUCTS}.
 */
export const BRAND_INDEXABLE_MIN_PRODUCTS = 1;

/**
 * How many live products a family needs before it earns a page.
 *
 * TWO. A family is a grouping of generations or editions, so a family with one
 * member says exactly what that product's own page says, with an extra URL for
 * a crawler to spend its budget on and an extra hop for a shopper. That is the
 * "use a family page only when the canonical model marks it public and useful"
 * rule, stated as a number rather than left to a reviewer's judgement.
 */
export const FAMILY_PUBLISHABLE_MIN_PRODUCTS = 2;

/**
 * Whether a brand page may be indexed.
 *
 * ORDER is load-bearing and is the `deriveRetailCompleteness` severity rule
 * applied to a page: a tombstone beats a rights refusal beats thinness. A
 * merged brand that also has no display right is a redirect first — telling a
 * crawler "we may not show this" about a page that should have pointed
 * somewhere else is the less useful of the two true statements.
 */
export function brandIndexability(input: {
  merged: boolean;
  mayIndex: boolean;
  productCount: number;
}): CatalogPageIndexability {
  if (input.merged) return 'merged';
  if (!input.mayIndex) return 'no_index_right';
  if (input.productCount < BRAND_INDEXABLE_MIN_PRODUCTS) return 'thin';
  return 'indexable';
}

/** Whether a family page may be indexed. Same ordering, higher floor. */
export function familyIndexability(input: {
  merged: boolean;
  mayIndex: boolean;
  productCount: number;
}): CatalogPageIndexability {
  if (input.merged) return 'merged';
  if (!input.mayIndex) return 'no_index_right';
  if (input.productCount < FAMILY_PUBLISHABLE_MIN_PRODUCTS) return 'thin';
  return 'indexable';
}

/**
 * The structured data a brand page may emit (#72 SEO rule 2).
 *
 * Derived from the PROJECTION rather than from the row, which is what makes
 * "only when visible facts support it" mechanical: a withheld logo is not in
 * the `displayable` branch of {@link CatalogPageAsset}, so it cannot reach the
 * JSON-LD, and neither can a description nobody may show.
 *
 * The `organization` shape is emitted only from a VERIFIED ownership
 * relationship. Schema.org's `Organization` is a claim about a legal entity,
 * and the one thing #55 exists to prevent is Mercaria asserting one from a name
 * that matched.
 *
 * A page that may not be indexed emits NOTHING. Structured data is an assertion
 * addressed to a crawler, so emitting it on a page marked `noindex` is a
 * contradiction, and on a `no_index_right` page it would be publishing exactly
 * the facts a source refused.
 */
export function brandStructuredData(input: {
  page: Pick<BrandPage, 'name' | 'description' | 'logo' | 'websiteUrl' | 'owningOrganization'>;
  canonicalUrl: string;
  indexability: CatalogPageIndexability;
}): CatalogStructuredData {
  if (input.indexability !== 'indexable') return { kind: 'none' };

  const logoFileId = displayableFileId(input.page.logo);
  const description = displayableText(input.page.description);
  const owner = input.page.owningOrganization;

  if (owner !== undefined) {
    return {
      kind: 'organization',
      name: owner.name,
      url: input.canonicalUrl,
      brandName: input.page.name,
      ...(logoFileId === undefined ? {} : { logoFileId }),
    };
  }

  return {
    kind: 'brand',
    name: input.page.name,
    url: input.canonicalUrl,
    ...(logoFileId === undefined ? {} : { logoFileId }),
    ...(description === undefined ? {} : { description }),
    // `sameAs` carries the brand's OWN website and nothing else. An observed
    // domain is a fact about where the brand's products were seen, not a claim
    // that the brand owns it (#53 records them as facts, explicitly not as
    // ownership proof), and `sameAs` is exactly such a claim.
    ...(input.page.websiteUrl === undefined ? {} : { sameAs: [input.page.websiteUrl] }),
  };
}

/** The file id an asset shows, or `undefined` when it shows none. */
function displayableFileId(asset: CatalogPageAsset): string | undefined {
  return asset.state === 'displayable' ? asset.fileId : undefined;
}

/** The text a field shows, or `undefined` when it shows none. */
function displayableText(field: CatalogPageText): string | undefined {
  return field.state === 'displayable' ? field.text : undefined;
}

/**
 * The breadcrumb trail a brand page carries (#72 SEO rule 3).
 *
 * A brand is a ROOT of navigation rather than a child of a category: a brand
 * sells across categories, and picking the biggest one as its parent would put
 * Apple under "Phones" and tell a crawler its laptops are a subsection of that.
 * So the brand's trail is one hop, and a FAMILY's is two — the family genuinely
 * belongs to its brand, structurally (`canonical_product_families.brand_id`).
 */
export function brandBreadcrumbs(brand: {
  id: string;
  slug: string;
  name: string;
}): CatalogBreadcrumb[] {
  return [{ kind: 'brand', id: brand.id, slug: brand.slug, name: brand.name }];
}

/** Brand → family, when the family has a brand; otherwise just the family. */
export function familyBreadcrumbs(
  family: { id: string; slug: string; name: string },
  brand: { id: string; slug: string; name: string } | undefined,
): CatalogBreadcrumb[] {
  const trail: CatalogBreadcrumb[] = [];
  if (brand !== undefined) {
    trail.push({ kind: 'brand', id: brand.id, slug: brand.slug, name: brand.name });
  }
  trail.push({
    kind: 'product_family',
    id: family.id,
    slug: family.slug,
    name: family.name,
  });
  return trail;
}
