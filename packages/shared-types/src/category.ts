/**
 * Category tree DTO for the Mercaria.
 *
 * `CategoryNode` is the recursive, tree-shaped projection returned by
 * `GET /categories` — each node may carry `children`. This is distinct from the
 * flat feed-card shapes (`Category`, `CategoryTile`, `CategoryPill`) in
 * `./product`, which exist purely to drive the home-feed carousels.
 */

/**
 * The v1 category contract: a free-text SLUG where a typed identity belongs.
 *
 * `Listing.category`, `CreateP2PListingInput.category`,
 * `CreateStoreProductInput.category` and `ListingQuery.category` are all a bare
 * `string`, and ADR 0007 D1 is that a slug is presentation and is never
 * identity. They stay because a shipped mobile build cannot be recalled and
 * #367 deliberately did not break them — the same ruling
 * `LEGACY_CONDITION_CONTRACT` records for the binary `condition` field, and the
 * same one `catalog-identity-isolation.test.ts` records for their request
 * halves.
 *
 * **The read is a PROJECTION and nothing on the DTO said so.** The server does
 * not store a `category` string: `catalog-hydration.service.ts` serves the LEAF
 * of `listings.category_slugs`, which the taxonomy repository materializes from
 * the category's own `ancestorSlugs` — so the field is derived on every read
 * from a typed `listings.category_id`, exactly as `condition` is derived from
 * `itemCondition.key`. That was inferable only from the service until this
 * constant existed, which is why it does.
 *
 * `supersededBy` names a field that is NOT on the wire yet, deliberately. The
 * typed identity exists in the database today; publishing it is a contract
 * addition somebody has to decide on, and recording that it is missing is more
 * useful than leaving the successor unnamed.
 */
export const LEGACY_LISTING_CATEGORY_CONTRACT = {
  version: 'v1',
  field: 'category',
  supersededBy: 'categoryId (`listings.category_id`; not published on any DTO yet)',
  retiresWhen:
    'no supported client version still sends or reads the free-text `category` slug, and the ' +
    'typed category identity is on the wire. Until then a v1 write resolves the slug to a ' +
    'category and a v1 read gets the leaf of the materialized slug path. ADR 0007 D13 retires ' +
    '`categories.ancestor_slugs` in a later `post` migration once no reader remains; this field ' +
    'is one of those readers.',
} as const;

/** A node in the category taxonomy tree. */
export interface CategoryNode {
  /** Stable category id. */
  id: string;
  /** Display name (e.g. "Dresses"). */
  name: string;
  /** URL slug (unique across the taxonomy). */
  slug: string;
  /** Parent category id, or `null` for a top-level category. */
  parentId: string | null;
  /** Optional resolvable image URL for the category. */
  imageUrl?: string;
  /** Direct child categories (omitted/empty for leaf nodes). */
  children?: CategoryNode[];
}
