/**
 * The dimensions a catalog rollout may be scoped by (#367 Workstream 0,
 * ADR 0007 D12).
 *
 * D12 named `CATALOG_AUTHORING_COHORTS` and nobody built it, so the staged
 * rollout order it decided — internal users → selected stores → selected
 * product types and categories → locales and markets → GA — was **not
 * executable**: the four levers that exist are booleans over a whole
 * deployment, and nothing narrowed one to a store, a market or anything else.
 * This tuple is the vocabulary that makes it executable, and it is a tuple
 * rather than five booleans for the reason every closed set in this repository
 * is one: a sixth dimension has to be added HERE, where the gate that walks it
 * can see it, instead of appearing as a sixth `if` somebody reads past.
 *
 * ## Why these five and not a percentage
 *
 * A hash bucket is the obvious sixth and it is deliberately absent, for the
 * reason `services/seo/rollout.ts` records about `SEO_CANARY_CATEGORY_IDS`: a
 * bucket has to be computed identically everywhere it is consulted, it is not
 * something an operator can reason about during an incident, and "we are
 * authoring Electronics first" is a sentence somebody can check. Every member
 * below is a value that already exists on the request or the row it decides
 * about.
 *
 * ## The dimensions are not interchangeable and none is a synonym of another
 *
 * - `market` is ISO 3166-1 alpha-2 — WHERE a shopper is buying. It is the
 *   dimension `GUEST_CHECKOUT_BLOCKED_MARKETS`, `RETAIL_BLOCKED_MARKETS` and
 *   `EBAY_MARKETS` already use, one domain over.
 * - `locale` is BCP-47 — WHICH LANGUAGE the answer is composed in. A market and
 *   a locale are routinely confused and they cross: `ES`+`ca-ES` and `MX`+`es`
 *   are both real, and a rollout that could only name one of them would either
 *   ship Catalan to Mexico or refuse Spain its second language.
 * - `store` is a native store id — WHOSE catalogue.
 * - `category` is a category id — WHAT KIND of thing, in the taxonomy.
 * - `product_type` is a product-type machine KEY (ADR 0007 D1: a key, never a
 *   label and never an id) — which authoring SCHEMA composes the form.
 *
 * `category` and `product_type` are separate because a category is where a
 * product sits in the tree and a product type is the schema that describes it;
 * ADR 0007 D5 keeps them apart everywhere else and a rollout that merged them
 * would be the first place they were one thing.
 */
export type CatalogRolloutDimension =
  /** ISO 3166-1 alpha-2, upper-cased. */
  | 'market'
  /** A BCP-47 tag, lower-cased. Matched on the subtag boundary — see below. */
  | 'locale'
  /** One native store id. */
  | 'store'
  /** One category id. Exact, never a subtree — see `docs/catalog-rollout-cohorts.md`. */
  | 'category'
  /** One product-type machine key. */
  | 'product_type'
  /**
   * One Oxy user id — ADR 0007 D12's FIRST rollout stage, "internal users".
   *
   * The value is the ACCOUNT, listed in `CATALOG_ROLLOUT_COHORTS` exactly as a
   * store or a category is. There is deliberately no `INTERNAL_USER_*`
   * allow-list behind it and it deliberately does not borrow one of the six
   * operator lists: those answer "may operate payments", "may operate the
   * catalogue" — and **"may reach the payment operator surface" and "should see
   * the new catalogue during stage 1" are different questions**. Keyed on one of
   * those, this cohort would move whenever somebody was granted an unrelated
   * power, silently, in the direction of admitting people. `store:<id>` is not
   * backed by a store allow-list either; every dimension here works by listing
   * its values, and this is consistent with them by construction.
   *
   * **The only dimension that is a claim about the CALLER rather than about the
   * REQUEST**, which is why its subject value has a different source. See
   * `catalogRolloutSubjectFromRequest`.
   */
  | 'internal_user';

/**
 * The six, as data, so a walk can iterate them.
 *
 * Deliberately does NOT include `all`: `all` is a whole-list escape rather than
 * a dimension, it names no subject field, and putting it here would make every
 * per-dimension assertion in the gate have to except it — which is how a member
 * ends up unasserted.
 */
export const CATALOG_ROLLOUT_DIMENSIONS: readonly CatalogRolloutDimension[] = [
  'market',
  'locale',
  'store',
  'category',
  'product_type',
  'internal_user',
];

/**
 * What a request knows about itself, as the rollout gate sees it.
 *
 * Every field is optional because different surfaces legitimately know
 * different things: a menu knows its market and locale and nothing about a
 * store, a draft knows all five. A subject that cannot state a value for any
 * ENABLED dimension is REFUSED rather than admitted — see
 * `catalogRolloutAllowedFor`.
 *
 * The field names are the dimension names with the repository's own spelling
 * for each id, and the gate ASSERTS that correspondence by walking
 * {@link CATALOG_ROLLOUT_DIMENSIONS} — so a sixth dimension with no field here
 * fails the build.
 */
export interface CatalogRolloutSubject {
  readonly market?: string | null;
  readonly locale?: string | null;
  readonly storeId?: string | null;
  readonly categoryId?: string | null;
  readonly productTypeKey?: string | null;
  /**
   * The AUTHENTICATED caller's Oxy user id, or null when the surface has none.
   *
   * Null on `facets`, `navigation` and `taxonomy`, which carry no auth
   * middleware at all — so with `internal_user` enabled those three refuse every
   * request, internal callers included. That is the accurate rendering of
   * "not rolled out": a public, per-(market, locale), ETag-validated surface has
   * no internal-only meaning, and stage 1 means it is not yet public.
   */
  readonly internalUserOxyUserId?: string | null;
}
