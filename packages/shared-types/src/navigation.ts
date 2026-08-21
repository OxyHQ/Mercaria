/**
 * Navigation trees and the merchandising separation (#367 step 7, ADR 0007 D3).
 *
 * A navigation tree is what a shopper walks: a header menu, a homepage's
 * sections, a category rail, a campaign strip. It is scoped to one
 * `(market, locale)`, it is published as a whole, and every node in it points at
 * exactly ONE thing.
 *
 * ## Navigation is not taxonomy, and it is not merchandising either
 *
 * ADR 0007 D3 states both halves. `collections`, `collection_rules` and
 * `listing_collections` stay exactly as they are and stay merchandising — a
 * navigation node may POINT at a collection, and pointing at it gives it no
 * category semantics and turns a membership into no product fact. And nothing
 * in this domain may write to `categories`: a menu is an arrangement of the
 * catalogue, never a second authority over what the catalogue MEANS. The first
 * is a property of the pointer being a foreign key to a row this domain never
 * writes; the second is `navigation-isolation.test.ts`.
 *
 * ## A node that means two things has no shape
 *
 * {@link NavigationTarget} is a discriminated union on a STRING `kind` with no
 * common id field — the `CommerceActor` / `OrderBuyer` / `CommercialPresentation`
 * device, for the same reason and with one extra: at the row, seven
 * biconditional CHECKs force every non-selected pointer NULL, so "a node that is
 * both a category and a campaign" is unrepresentable in the database as well as
 * in the type. A `kind` field rather than a boolean-shaped discriminant because
 * the backend compiles with `strict: false`, where TypeScript does not narrow a
 * union on the truthiness of a boolean literal (the #68 and #110 finding).
 *
 * ## Identity and presentation are BOTH returned, never presentation alone
 *
 * {@link NavigationNodeView} requires `id`, `key`, a target carrying the target's
 * own stable ids/keys, AND a {@link NavigationPresentation}. ADR 0007 D1 is that
 * a label is presentation and never identity; a payload carrying only labels
 * would force a client to match on display text, which is the failure the whole
 * epic exists to remove. The presentation states which locale actually answered
 * and what the translation's status is, so a fallback is debuggable and a raw
 * key is never rendered (D4).
 */

import type { ConditionGroup } from './condition';
import type { CurrencyCode } from './money';
import type { OfferAvailability, OfferKind } from './offer';

/* -------------------------------------------------------------------------- */
/*  Closed value sets                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Where a tree is rendered.
 *
 * The surface is part of the tree's own identity rather than a node property:
 * "which header menu does market ES, locale es-ES get" has to have exactly one
 * answer at any instant, and that is enforced as a window-overlap refusal per
 * `(market, locale, surface)`.
 */
export type NavigationSurface =
  | 'header_menu'
  | 'footer_menu'
  | 'homepage_sections'
  | 'category_rail'
  | 'campaign_banner';

/** {@link NavigationSurface} — the tuple the column, its CHECK and zod all read. */
export const NAVIGATION_SURFACES: readonly NavigationSurface[] = [
  'header_menu',
  'footer_menu',
  'homepage_sections',
  'category_rail',
  'campaign_banner',
];

/**
 * A tree's publication state.
 *
 * Three states and no `scheduled`: a scheduled tree IS a published one whose
 * `effectiveFrom` has not arrived, and a fourth state would be a second answer
 * to "is this live" beside the window it is derived from. `draft` is what
 * preview reads; `archived` is a version that has been superseded or withdrawn.
 */
export type NavigationTreeLifecycle = 'draft' | 'published' | 'archived';

/** {@link NavigationTreeLifecycle}. */
export const NAVIGATION_TREE_LIFECYCLES: readonly NavigationTreeLifecycle[] = [
  'draft',
  'published',
  'archived',
];

/**
 * What a node points at — ADR 0007 D3's seven, and no eighth.
 *
 * `product_type` is carried as the product type's stable KEY rather than an id,
 * because the versioned `product_type_definitions` table is merge-order step 3
 * and does not exist on this branch's base. A key is the right pointer either
 * way: D1 gives every catalog concept a key precisely so a reference can be made
 * without embedding a uuid, and a node means "the smartphone product type", not
 * "version 4 of it". An unconstrained uuid column would have looked like a
 * foreign key while enforcing nothing.
 */
export type NavigationNodeTargetKind =
  | 'category'
  | 'saved_query'
  | 'product_type'
  | 'brand'
  | 'product_family'
  | 'collection'
  | 'campaign';

/** {@link NavigationNodeTargetKind}. */
export const NAVIGATION_NODE_TARGET_KINDS: readonly NavigationNodeTargetKind[] = [
  'category',
  'saved_query',
  'product_type',
  'brand',
  'product_family',
  'collection',
  'campaign',
];

/**
 * Targets a navigation node may never have, named as VALUES.
 *
 * DISJOINT from {@link NAVIGATION_NODE_TARGET_KINDS} (a test), so a refusal can
 * name the exact prohibition instead of answering "unrecognized value" — the
 * `RetailForbiddenComponentKind` device. Two are load-bearing rather than
 * decorative: `sponsored_placement` is the one somebody would reach for first
 * and it is #74's decision behind a versioned policy, and `category_write` names
 * the thing D3 forbids outright in the vocabulary as well as in the gate.
 */
export type NavigationForbiddenTargetKind =
  | 'sponsored_placement'
  | 'paid_ranking_slot'
  | 'category_write'
  | 'listing'
  | 'offer'
  | 'merchant_price'
  | 'seller_ranking'
  | 'arbitrary_html';

/** {@link NavigationForbiddenTargetKind}. */
export const NAVIGATION_FORBIDDEN_TARGET_KINDS: readonly NavigationForbiddenTargetKind[] = [
  'sponsored_placement',
  'paid_ranking_slot',
  'category_write',
  'listing',
  'offer',
  'merchant_price',
  'seller_ranking',
  'arbitrary_html',
];

/**
 * Whether a node is shown at all, independent of its window.
 *
 * The ONE column of a published tree's node that may still be updated. A change
 * to what shoppers see is normally a new tree version, but an incident lever
 * that requires republishing a whole menu is one nobody can pull at 3am.
 */
export type NavigationNodeVisibility = 'visible' | 'hidden';

/** {@link NavigationNodeVisibility}. */
export const NAVIGATION_NODE_VISIBILITIES: readonly NavigationNodeVisibility[] = [
  'visible',
  'hidden',
];

/**
 * ADR 0007 D4's translation status, for this domain's localization member.
 *
 * `stale` is a first-class state and is NOT blanked: a stale translation is
 * still the best text available and withdrawing it would show raw keys to
 * shoppers.
 *
 * **Coordination (merge-order step 2):** the localization family owns one
 * vocabulary for every catalog entity. When `category_localizations` and its
 * siblings land, this tuple and {@link NAVIGATION_LOCALIZATION_PROVENANCES} are
 * DELETED and the shared ones imported in their place — two lists describing one
 * vocabulary can disagree, and the direction they disagree in is always the
 * permissive one. The column CHECKs re-render from whichever tuple is imported,
 * so the swap is one edit plus one migration.
 */
export type NavigationLocalizationStatus =
  | 'missing'
  | 'machine_translated'
  | 'reviewed'
  | 'approved'
  | 'stale'
  | 'deprecated';

/** {@link NavigationLocalizationStatus}. */
export const NAVIGATION_LOCALIZATION_STATUSES: readonly NavigationLocalizationStatus[] = [
  'missing',
  'machine_translated',
  'reviewed',
  'approved',
  'stale',
  'deprecated',
];

/**
 * ADR 0007 D4's provenance. See {@link NavigationLocalizationStatus}.
 *
 * **`seller` is carried here because this list and `LOCALIZATION_PROVENANCES`
 * are ONE vocabulary, not because a seller writes navigation labels.** Nobody
 * does — Mercaria owns the navigation tree. But per-table meaningfulness has
 * never been this tuple's membership rule: `imported_source` is equally
 * unreachable on a navigation node, and `mercaria` is a refuted authorship
 * claim on `listing_localizations`. A CHECK states what a column MAY hold, not
 * what it does hold.
 *
 * What forces the copy is `catalog-localization.test.ts`' equality assertion,
 * which exists — in its own words — to notice "the day they are not" identical,
 * because two lists describing one vocabulary drift in the permissive
 * direction. Relaxing that guard to a subset test to spare one CHECK on a table
 * nobody writes `seller` to would trade a standing invariant for a migration
 * statement. The swap this file's header describes — deleting both tuples and
 * importing the shared ones — remains the real fix and remains unclaimed.
 */
export type NavigationLocalizationProvenance =
  | 'mercaria'
  | 'official_brand'
  | 'professional'
  | 'community_reviewed'
  | 'machine'
  | 'imported_source'
  | 'seller';

/** {@link NavigationLocalizationProvenance}. */
export const NAVIGATION_LOCALIZATION_PROVENANCES: readonly NavigationLocalizationProvenance[] = [
  'mercaria',
  'official_brand',
  'professional',
  'community_reviewed',
  'machine',
  'imported_source',
  'seller',
];

/**
 * The statuses machine translation may never land on (ADR 0007 D4).
 *
 * Held by a trigger rather than by service discipline, because a service-level
 * check is one forgotten call site away from silently degrading a human's work.
 * The tuple is here so the trigger, the service and the test read one list.
 */
export const NAVIGATION_HUMAN_REVIEWED_STATUSES: readonly NavigationLocalizationStatus[] = [
  'reviewed',
  'approved',
];

/**
 * The deepest a navigation tree may be.
 *
 * Bounds the cycle trigger's walk, bounds the public payload, and is a real
 * product statement: a menu a person can hold in their head is three or four
 * levels, and the failure mode of an unbounded one is a page that renders
 * forever. Refused at the row.
 */
export const NAVIGATION_MAX_DEPTH = 6;

/* -------------------------------------------------------------------------- */
/*  Locale fallback (D4)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * ADR 0007 D4's deterministic fallback chain: exact locale → the language
 * fallback for that locale (`es-MX` → `es`) → the base locale.
 *
 * Pure, ordered, de-duplicated, and stated ONCE so a client debugging a
 * fallback and the server producing it walk the same list. The base locale is a
 * PARAMETER rather than a constant here: which locale a deployment falls back to
 * is the localization family's authority (merge-order step 2), and a default
 * baked into this function would be a second answer to it.
 *
 * Legal and seller-authored text are excluded from cross-market fallback by D4.
 * Nothing in navigation is either — a menu label is Mercaria's own presentation
 * — which is why this chain applies here whole.
 */
export function navigationLocaleFallbackChain(
  requestedLocale: string,
  baseLocale: string,
): readonly string[] {
  const normalize = (value: string): string => value.trim().toLowerCase();
  const requested = normalize(requestedLocale);
  const base = normalize(baseLocale);
  const chain: string[] = [];
  const push = (candidate: string): void => {
    if (candidate.length > 0 && !chain.includes(candidate)) chain.push(candidate);
  };

  push(requested);
  const separator = requested.indexOf('-');
  if (separator > 0) push(requested.slice(0, separator));
  push(base);
  return chain;
}

/* -------------------------------------------------------------------------- */
/*  Public read DTOs                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What a node is CALLED, and what that text actually is.
 *
 * `locale` is the locale that answered, which is not always `requestedLocale` —
 * D4 requires the effective locale and the translation status to travel with the
 * string so an internal client can debug a fallback. `fallbackApplied` is
 * derived from the two rather than stored, so the two cannot disagree.
 */
export interface NavigationPresentation {
  readonly label: string;
  readonly description?: string;
  /** For a screen reader, when the visible label is not enough on its own. */
  readonly accessibilityLabel?: string;
  /** The locale that actually answered. */
  readonly locale: string;
  /** The locale the caller asked for. */
  readonly requestedLocale: string;
  readonly status: NavigationLocalizationStatus;
  readonly provenance: NavigationLocalizationProvenance;
  /** `locale !== requestedLocale`. Derived, never stored. */
  readonly fallbackApplied: boolean;
}

/** One attribute filter of a saved query, naming #94's stable attribute key. */
export interface NavigationSavedQueryAttributeFilter {
  /** The attribute definition's stable machine key (ADR 0007 D1), never a name. */
  readonly attributeKey: string;
  readonly values: readonly string[];
}

/** A saved query's price bound. One currency, so the two ends are comparable. */
export interface NavigationSavedQueryPriceFilter {
  readonly currency: CurrencyCode;
  readonly minAmount?: number;
  readonly maxAmount?: number;
}

/**
 * A named, reusable, curated search — the row a `saved_query` node points at.
 *
 * Every field is a real column and there is no free-form filter bag: ADR 0007
 * D14 permits JSONB for a source-shaped payload, an immutable schema snapshot
 * and a bounded rule AST, and a saved query's filters are none of the three.
 *
 * There is deliberately **no sort, intent, weight or policy field**. A saved
 * query says WHAT to search and never HOW to order the results — ordering is
 * #74's, behind its versioned policy, and a curated search carrying its own sort
 * would be a second ordering authority reachable from a menu.
 */
export interface NavigationSavedQueryView {
  readonly id: string;
  /** The stable machine key (D1). */
  readonly key: string;
  readonly queryText?: string;
  readonly categoryId?: string;
  readonly brandIds: readonly string[];
  readonly merchantIds: readonly string[];
  readonly conditionGroups: readonly ConditionGroup[];
  readonly availability: readonly OfferAvailability[];
  readonly offerKinds: readonly OfferKind[];
  /** #70 filter 7 — only official or authorized channels for the brand. */
  readonly officialChannelOnly: boolean;
  /** ISO 3166-1 alpha-2, when the query is pinned to one market. */
  readonly market?: string;
  readonly price?: NavigationSavedQueryPriceFilter;
  readonly attributes: readonly NavigationSavedQueryAttributeFilter[];
}

/**
 * What one node points at.
 *
 * A discriminated union with NO common id field, so every consumer switches on
 * `kind` and a category id can never be read as a collection id.
 */
export type NavigationTarget =
  | { readonly kind: 'category'; readonly categoryId: string; readonly categorySlug: string }
  | { readonly kind: 'saved_query'; readonly savedQuery: NavigationSavedQueryView }
  | { readonly kind: 'product_type'; readonly productTypeKey: string }
  | { readonly kind: 'brand'; readonly brandId: string; readonly brandSlug: string }
  | {
      readonly kind: 'product_family';
      readonly productFamilyId: string;
      readonly productFamilySlug: string;
    }
  | {
      readonly kind: 'collection';
      readonly collectionId: string;
      readonly collectionHandle: string;
    }
  /**
   * An external campaign destination. The absolute URL as an operator entered
   * it, HTTPS-only and never composed here — this domain adds no parameter to
   * anybody's link (the #65/#66 rule: attribution lives in the link, and a
   * rebuilt one is indistinguishable from a working one until a month of revenue
   * is missing).
   */
  | { readonly kind: 'campaign'; readonly url: string };

/**
 * What an AUTHOR says a node points at.
 *
 * A separate union from {@link NavigationTarget} rather than a partial of it,
 * and the difference is the point: an author supplies an id or a key, and the
 * read adds the slug, handle or saved query the row resolved to. One type doing
 * both would have to make the resolved half optional, and an optional slug on a
 * response is a slug a client will read as absent rather than as unresolved.
 *
 * The discriminant is the same `kind`, so the seven pointers of the row, the
 * seven biconditional CHECKs and the seven members here are one list in three
 * places that cannot drift apart without failing to compile.
 */
export type NavigationTargetInput =
  | { readonly kind: 'category'; readonly categoryId: string }
  | { readonly kind: 'saved_query'; readonly savedQueryId: string }
  | { readonly kind: 'product_type'; readonly productTypeKey: string }
  | { readonly kind: 'brand'; readonly brandId: string }
  | { readonly kind: 'product_family'; readonly productFamilyId: string }
  | { readonly kind: 'collection'; readonly collectionId: string }
  | { readonly kind: 'campaign'; readonly url: string };

/**
 * One node of a published tree.
 *
 * Identity (`id`, `key`, the target's own ids/keys) and presentation are BOTH
 * required — see the module docblock.
 */
export interface NavigationNodeView {
  readonly id: string;
  /** Stable within its tree (D1); what a client keys behaviour on. */
  readonly key: string;
  readonly position: number;
  readonly target: NavigationTarget;
  readonly presentation: NavigationPresentation;
  readonly children: readonly NavigationNodeView[];
}

/** A published tree, resolved for one `(market, locale)` at one instant. */
export interface NavigationTreeView {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly market: string;
  readonly locale: string;
  readonly surface: NavigationSurface;
  readonly publishedAt?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string;
  readonly nodes: readonly NavigationNodeView[];
}

/**
 * The public read's body.
 *
 * `etag` is in the body as well as the header deliberately: a client that caches
 * the payload in storage needs the validator beside it, and a header is gone by
 * then. It is the SAME string, derived from the same hash.
 */
export interface NavigationResponse {
  readonly market: string;
  readonly requestedLocale: string;
  readonly trees: readonly NavigationTreeView[];
  readonly etag: string;
  /**
   * How many nodes the projection withheld.
   *
   * A COUNT and never the list: "which entries are missing and why" is an
   * operator's question and it is answered by the preview, which is gated. A
   * public payload naming them would publish, to everybody, that a particular
   * collection is unpublished or a particular category has been withdrawn.
   */
  readonly withheldNodeCount: number;
}

/* -------------------------------------------------------------------------- */
/*  Preview (operator)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Why a node did not appear.
 *
 * A closed vocabulary rather than a sentence, because the two an operator most
 * needs to tell apart look identical on the page: a node the AUTHOR hid, and a
 * node whose destination has been withdrawn by somebody in another domain.
 *
 * `parent_withheld` is its own member for the same reason: a whole branch
 * disappearing because one ancestor was withheld is not five independent
 * problems, and reporting it as five sends somebody to fix four nodes that were
 * never wrong.
 */
export type NavigationWithholdReason =
  | 'node_hidden'
  | 'outside_visibility_window'
  | 'target_missing'
  | 'target_not_publicly_visible'
  | 'no_label_in_fallback_chain'
  | 'parent_withheld';

/** {@link NavigationWithholdReason}. */
export const NAVIGATION_WITHHOLD_REASONS: readonly NavigationWithholdReason[] = [
  'node_hidden',
  'outside_visibility_window',
  'target_missing',
  'target_not_publicly_visible',
  'no_label_in_fallback_chain',
  'parent_withheld',
];

/** One withheld node, as the preview reports it. */
export interface NavigationWithheldNode {
  /** The node's stable key — never its label, which may be what is missing. */
  readonly nodeKey: string;
  readonly reason: NavigationWithholdReason;
}

/**
 * What an operator sees before anybody else does.
 *
 * The SAME projection the public read runs, so a preview cannot show a menu that
 * publishing would not produce — plus the reasons, which the public read does
 * not carry.
 */
export interface NavigationPreviewResponse {
  readonly tree: NavigationTreeView;
  readonly lifecycle: NavigationTreeLifecycle;
  /** The operator-facing name of this version. Never served publicly. */
  readonly internalLabel: string;
  readonly withheld: readonly NavigationWithheldNode[];
  readonly etag: string;
}
