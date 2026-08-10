/**
 * The indexability policy (#75 §"Indexability policy") — one deterministic
 * function over nine stated inputs, and the ONLY place a page becomes
 * crawlable.
 *
 * ## What this policy does NOT decide
 *
 * Whether a page's canonical URL is its own address. A legacy listing that maps
 * confidently to a canonical product is indexable AND points `rel=canonical` at
 * the product: that is how the consolidation works, and adding `noindex` beside
 * a cross-page canonical is the contradiction search engines resolve by
 * ignoring one of them. It is excluded from sitemaps instead, which is a
 * different statement and the correct one.
 *
 * ## Deterministic means every input is supplied
 *
 * {@link SeoIndexabilityFacts} has no optional field. A caller that has not
 * decided whether the locale is complete cannot omit the answer and get a soft
 * yes — `tsc` refuses. That is the whole difference between a policy and a pile
 * of `if`s: the EIGHT questions #75 asks — plus the rollout lever and the
 * route's availability, which are Mercaria's own and make nine — are asked
 * every time, for every page, in the same order.
 *
 * ## Every input is a STRING discriminant
 *
 * This backend compiles with `strictNullChecks` off, where TypeScript does not
 * narrow a union on a boolean-literal discriminant (`AGENTS.md`). A `boolean`
 * field would also lose the third value several of these genuinely have —
 * "there is no current offer", "there was never an offer" and "this page is not
 * about offers" lead to three different verdicts.
 *
 * ## The reason is OPERATOR-facing, and only operator-facing
 *
 * A crawler is told `noindex` and nothing else, because a refusal that spans
 * several conditions gets one answer or a client can vary one input at a time
 * and read the switchboard out of the catalogue.
 *
 * The reason therefore needs a consumer, or it is weight rather than
 * documentation: `GET /internal/seo/diagnose`, behind the catalogue operator
 * allow-list, serves it, and `GET /internal/seo/sitemaps/:collection/:page`
 * tallies it. Both read the SAME calls the public paths project it away from —
 * `diagnoseSeoUrl` and `classifySitemapRows` — so an operator's answer and a
 * crawler's `noindex` come from one computation.
 * `internal-seo-routes.test.ts` asserts the router this paragraph promises is
 * the router the app mounts.
 *
 * ## Membership in a sitemap is the SAME call
 *
 * `sitemap.ts` runs this function over each candidate row rather than
 * re-implementing the predicate in SQL. Two implementations of "is this page
 * indexable" would eventually disagree, and the visible symptom — a sitemap
 * full of `noindex` URLs — is one nobody sees without a crawler telling them.
 */

import type {
  SeoIndexability,
  SeoNonIndexableReason,
  SeoRouteAvailability,
  SeoVisibleFacts,
} from '@mercaria/shared-types';

/**
 * Whether this page's identity is the canonical one, a merge tombstone, or a
 * duplicate of another page (#75 policy rules 1 and 5).
 */
export type SeoIdentityQuality = 'canonical' | 'merged' | 'duplicate';

/** Moderation and lifecycle suppression (#75 policy rule 6). */
export type SeoModerationState = 'clear' | 'suppressed';

/** Whether every contributing catalogue source grants `index` (#75 policy rule 4). */
export type SeoSourceIndexRight = 'granted' | 'withheld';

/** Whether the page carries enough for a search result to be worth clicking. */
export type SeoContentSufficiency = 'sufficient' | 'thin';

/**
 * What the page can say about acquiring the thing (#75 policy rule 3).
 *
 * `not_applicable` is a real member, not a fudge: a brand page is not about
 * offers, and judging it by an offer count would delist every brand whose
 * products are momentarily out of stock. Its content is judged by
 * {@link SeoContentSufficiency} instead.
 */
export type SeoOfferInformation = 'current' | 'historical' | 'none' | 'not_applicable';

/** Whether the requested locale has real localized content (#75 policy rule 7). */
export type SeoLocaleCompleteness = 'complete' | 'incomplete';

/**
 * Filter-page uniqueness and demand (#75 policy rule 8).
 *
 * `not_a_filter_page` is what every live route supplies today, because Mercaria
 * ships no filtered browse page yet. The member exists so the question is asked
 * rather than assumed, and so the day a browse page lands there is one place to
 * answer it.
 */
export type SeoFilterUniqueness = 'not_a_filter_page' | 'unique' | 'not_unique';

/** Everything the policy considers. Nine fields, none optional. */
export interface SeoIndexabilityFacts {
  /** Does a storefront screen render this route at all. */
  readonly routeAvailability: SeoRouteAvailability;
  /** Has the rollout lever authorised indexing FOR THIS ENTITY. */
  readonly indexingPermitted: boolean;
  readonly identity: SeoIdentityQuality;
  readonly moderation: SeoModerationState;
  readonly sourceIndexRight: SeoSourceIndexRight;
  readonly content: SeoContentSufficiency;
  readonly offerInformation: SeoOfferInformation;
  readonly locale: SeoLocaleCompleteness;
  readonly filterUniqueness: SeoFilterUniqueness;
}

/** The one indexable verdict, allocated once — nothing reads a field off it. */
const INDEXABLE: SeoIndexability = Object.freeze({ outcome: 'indexable' });

function refuse(reason: SeoNonIndexableReason): SeoIndexability {
  return { outcome: 'refused', reason };
}

/**
 * The verdict.
 *
 * The order below is load-bearing and matches `SEO_NON_INDEXABLE_REASONS`: the
 * mechanical refusals come first (a page nobody can reach is not a thin page,
 * it is not a page), then identity, then rights, then content. An operator
 * reading `thin_content` therefore knows the page is live, canonical, clear of
 * moderation and permitted by its sources — which is what makes the reason
 * actionable rather than merely true.
 */
export function decideIndexability(facts: SeoIndexabilityFacts): SeoIndexability {
  if (!facts.indexingPermitted) return refuse('indexing_disabled');
  if (facts.routeAvailability !== 'live') return refuse('route_not_live');
  if (facts.identity !== 'canonical') return refuse('merged_or_duplicate');
  if (facts.moderation !== 'clear') return refuse('suppressed');
  if (facts.sourceIndexRight !== 'granted') return refuse('source_withholds_index_right');
  if (facts.content !== 'sufficient') return refuse('thin_content');
  if (facts.offerInformation === 'none') return refuse('no_offer_information');
  if (facts.locale !== 'complete') return refuse('locale_incomplete');
  if (facts.filterUniqueness === 'not_unique') return refuse('filter_combination_not_unique');
  return INDEXABLE;
}

/**
 * The `robots` directive string for a verdict.
 *
 * `follow` in BOTH branches, deliberately. A non-indexable page is still a
 * navigation surface — a merged product's tombstone leads to its winner, a
 * legacy listing leads to its canonical product — and `nofollow` would cut
 * those paths for no benefit. `noindex` withdraws the page; it is not a
 * quarantine.
 *
 * `max-image-preview:large` is added for indexable pages only, because the
 * preview it authorises is only ever shown for an indexed one.
 */
export function robotsDirectiveFor(verdict: SeoIndexability): string {
  return verdict.outcome === 'indexable'
    ? 'index,follow,max-image-preview:large'
    : 'noindex,follow';
}

/**
 * The shortest description Mercaria will treat as content rather than as a
 * label, in characters.
 *
 * A number rather than a judgement so it can be argued with. Below it a
 * description is a product title repeated, which is what a thin programmatic
 * page looks like from the outside.
 */
export const MIN_DESCRIPTION_CHARACTERS = 60;

/**
 * How many products a brand, family or merchant page needs before it is worth
 * a search result of its own.
 *
 * One is not enough: a brand page listing one product duplicates that
 * product's page, which is #75 policy rule 8's concern arriving through a
 * different door.
 */
export const MIN_CATALOGUE_ENTRIES = 2;

/**
 * Is what the page DISPLAYS enough to justify a result?
 *
 * Reads {@link SeoVisibleFacts} and nothing else — the same value the metadata
 * and the JSON-LD are built from — so "sufficient content" is a statement about
 * what a visitor actually sees, not about what a row happens to hold.
 *
 * The rule: a name, plus either a real description or an image with something
 * that identifies the thing. A page with a name and nothing else is a stub, and
 * a catalogue full of stubs is exactly the "thin, misleading programmatic
 * pages" the issue opens by refusing to generate.
 */
export function assessVisibleContent(facts: SeoVisibleFacts): SeoContentSufficiency {
  if (facts.entityName.trim() === '') return 'thin';

  const hasDescription = (facts.description ?? '').trim().length >= MIN_DESCRIPTION_CHARACTERS;
  if (hasDescription) return 'sufficient';

  const hasImage = facts.imageUrls.length > 0;
  const hasIdentifier = facts.gtins.length > 0 || (facts.mpn ?? '').trim() !== '';
  return hasImage && hasIdentifier ? 'sufficient' : 'thin';
}

/**
 * Is a listing page's catalogue big enough to be its own result?
 *
 * Separate from {@link assessVisibleContent} because a brand page's content IS
 * its product list: it has no description of its own worth indexing and its
 * image is a logo.
 */
export function assessCatalogueContent(
  entityName: string,
  entryCount: number,
): SeoContentSufficiency {
  if (entityName.trim() === '') return 'thin';
  return entryCount >= MIN_CATALOGUE_ENTRIES ? 'sufficient' : 'thin';
}
