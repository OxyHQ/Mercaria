/**
 * The rendered document (#75 §"Rendered metadata") — the seven things a
 * server-readable `<head>` owes a crawler, composed from ONE visible-fact
 * value.
 *
 * ## Nothing here reads the database
 *
 * `seo.service.ts` resolves the entity and projects it into
 * {@link SeoVisibleFacts}; this module turns that into a document. The split is
 * what makes the parity tests possible at all — a composer that could reach a
 * repository would be able to emit a fact the page never showed, and no test
 * over the output could tell.
 *
 * ## Structured data is emitted only for an INDEXABLE document
 *
 * Structured data is an indexing signal. Attaching one to a page the policy has
 * withdrawn asks for exactly the outcome the policy exists to prevent, so the
 * graph is empty whenever `indexable` is false — asserted by
 * `seo-document.test.ts` rather than left to whoever adds the next page type.
 *
 * ## Locale alternates are EMPTY, and that is a statement
 *
 * Mercaria publishes one locale and has no localized route: there is no second
 * URL an `hreflang` could point at. #75 rendered-metadata rule 3 asks for
 * alternates "when real localized content exists", and emitting a self-
 * referential alternate for a locale nobody translated is the failure mode that
 * rule is written against. The field and the policy input exist so the question
 * is asked; the answer today is "none".
 */

import type {
  PublicRouteId,
  SeoDocument,
  SeoIndexability,
  SeoJsonLdNode,
  SeoLocaleAlternate,
  SeoSharingMetadata,
  SeoVisibleFacts,
} from '@mercaria/shared-types';
import { robotsDirectiveFor } from './indexability.js';
import {
  breadcrumbNode,
  organizationNode,
  productNode,
  webSiteNode,
} from './structured-data.js';

/** The brand name every title and sharing card is suffixed with. */
export const SITE_NAME = 'Mercaria';

/**
 * The longest `<title>` Mercaria composes, in characters.
 *
 * Search engines truncate around here; composing a longer one and letting the
 * result be cut mid-word is a worse outcome than choosing where the cut goes.
 */
export const MAX_TITLE_CHARACTERS = 70;

/** The longest meta description, in characters. */
export const MAX_DESCRIPTION_CHARACTERS = 160;

/**
 * Truncate on a word boundary, appending an ellipsis only when something was
 * actually removed.
 */
function clamp(text: string, limit: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= limit) return normalized;
  const cut = normalized.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The `<title>`.
 *
 * `Name — Mercaria`, and the suffix is dropped rather than the name when the
 * two together exceed the limit: a shopper scanning results needs to know what
 * the page is about, and every result on the domain says Mercaria anyway.
 */
export function composeTitle(entityName: string): string {
  const name = entityName.replace(/\s+/gu, ' ').trim();
  if (name === '') return SITE_NAME;
  const suffixed = `${name} — ${SITE_NAME}`;
  return suffixed.length <= MAX_TITLE_CHARACTERS ? suffixed : clamp(name, MAX_TITLE_CHARACTERS);
}

/** The meta description, or `undefined` when the page has nothing to summarise. */
export function composeDescription(facts: SeoVisibleFacts): string | undefined {
  const description = (facts.description ?? '').trim();
  if (description === '') return undefined;
  return clamp(description, MAX_DESCRIPTION_CHARACTERS);
}

/** Which sharing `og:type` a route carries. */
function sharingTypeFor(routeId: PublicRouteId): SeoSharingMetadata['type'] {
  return routeId === 'canonical_product' || routeId === 'legacy_listing' ? 'product' : 'website';
}

/** Builds the entity-specific schema.org node(s) for one route, given its facts. */
type StructuredDataBuilder = (facts: SeoVisibleFacts, canonicalUrl: string, origin: string) => SeoJsonLdNode;

/**
 * Which entity node each route emits — a `Record<PublicRouteId, ...>` rather
 * than a `switch`, for `SECTION_TITLE_KEYS`'s own reason
 * (`packages/frontend/lib/discovery/section-title.ts`): exhaustiveness is then
 * the COMPILER's job, so a route added to the union fails to build here rather
 * than silently falling through to an empty array. A `switch` with no
 * `default` looked closed but wasn't — it type-checks whether or not every
 * case is listed, because this function accumulates into an array and returns
 * unconditionally, so a route the switch never mentioned produced no
 * structured data with no error anywhere. `category_index` shipped exactly
 * that way and nothing caught it.
 *
 * `null` is a DECISION, not an omission: a seller profile is a person Oxy owns
 * the identity of, and publishing a `Person` node for them from a marketplace
 * is a claim Mercaria has no standing to make. A hub page (`category_index`,
 * `deals`) has no entity of its own to describe. Every `null` here is argued
 * where it sits, exactly as `ROUTE_RESOLVERS`' `null` is in `seo.service.ts`.
 */
const STRUCTURED_DATA_BY_ROUTE: Readonly<Record<PublicRouteId, StructuredDataBuilder | null>> =
  Object.freeze({
    home: (_facts, _canonicalUrl, origin) => webSiteNode(SITE_NAME, origin),
    canonical_product: (facts, canonicalUrl) => productNode(facts, canonicalUrl),
    legacy_listing: (facts, canonicalUrl) => productNode(facts, canonicalUrl),
    brand: (facts, canonicalUrl) => organizationNode('Brand', facts, canonicalUrl),
    merchant: (facts, canonicalUrl) => organizationNode('Organization', facts, canonicalUrl),
    native_store: (facts, canonicalUrl) => organizationNode('OnlineStore', facts, canonicalUrl),
    product_family: null,
    seller: null,
    category_browse: null,
    native_store_legacy: null,
    category_index: null,
    deals: null,
  });

/** The structured-data graph for one page. */
function structuredDataFor(
  routeId: PublicRouteId,
  facts: SeoVisibleFacts,
  canonicalUrl: string,
  origin: string,
): readonly SeoJsonLdNode[] {
  const nodes: SeoJsonLdNode[] = [];

  const builder = STRUCTURED_DATA_BY_ROUTE[routeId];
  if (builder !== null) nodes.push(builder(facts, canonicalUrl, origin));

  const breadcrumbs = breadcrumbNode(facts, origin);
  if (breadcrumbs !== undefined) nodes.push(breadcrumbs);
  return nodes;
}

/** Everything the composer needs, and nothing it could read a fact from. */
export interface ComposeDocumentInput {
  readonly routeId: PublicRouteId;
  readonly facts: SeoVisibleFacts;
  readonly canonicalUrl: string;
  readonly origin: string;
  readonly indexability: SeoIndexability;
}

/** Compose one document. Pure. */
export function composeDocument(input: ComposeDocumentInput): SeoDocument {
  const { routeId, facts, canonicalUrl, origin, indexability } = input;
  const indexable = indexability.outcome === 'indexable';
  const title = composeTitle(facts.title);
  const description = composeDescription(facts);
  const imageUrl = facts.imageUrls[0];

  const sharing: SeoSharingMetadata = {
    title,
    ...(description === undefined ? {} : { description }),
    type: sharingTypeFor(routeId),
    url: canonicalUrl,
    ...(imageUrl === undefined ? {} : { imageUrl }),
    siteName: SITE_NAME,
  };

  const localeAlternates: readonly SeoLocaleAlternate[] = [];

  return {
    routeId,
    title,
    ...(description === undefined ? {} : { description }),
    canonicalUrl,
    indexable,
    robots: robotsDirectiveFor(indexability),
    sharing,
    breadcrumbs: facts.breadcrumbs,
    localeAlternates,
    structuredData: indexable ? structuredDataFor(routeId, facts, canonicalUrl, origin) : [],
  };
}
