/**
 * Suggesting a mapping, and never applying one (#63 Mapping UX 2).
 *
 * ## A suggestion is DATA and there is no code path that applies it
 *
 * `suggestFeedFieldMappings` returns a list and writes nothing — it takes no
 * database handle, no version id and no writer. The only way a mapping reaches
 * a version is a caller POSTing it, which is a person pressing a button. "Do not
 * apply mappings silently" is therefore the absence of a function rather than a
 * flag somebody could flip, and the preview surface renders suggestions beside
 * the merchant's own columns for them to accept one at a time.
 *
 * ## Google Merchant conventions are ALIASES, not a protocol
 *
 * Issue §"Supported inputs" 7 asks for "common Google Merchant-style field
 * conventions where they can be mapped without claiming full protocol
 * compatibility", and an alias table is exactly that distinction made real: a
 * column called `image_link` is SUGGESTED as `image` and nothing about the feed
 * is treated as a Merchant Center data source. Mercaria validates none of that
 * specification's own rules, emits none of its error codes and claims none of
 * its guarantees.
 *
 * The four bases are recorded on each suggestion so the UI can order them by
 * how much they are worth: an exact role name is a merchant who already speaks
 * Mercaria's vocabulary; a namespace-stripped match is a Google XML feed; a
 * normalized-header match is `Sale Price` meeting `sale_price`.
 */

import type {
  FeedFieldRole,
  FeedMappingSuggestion,
  FeedMappingSuggestionBasis,
} from '@mercaria/shared-types';
import { FEED_FIELD_ROLES } from '@mercaria/shared-types';

/**
 * The Google Merchant column names Mercaria recognises, and the role each
 * suggests.
 *
 * Deliberately NOT exhaustive over that specification: a name is here when its
 * meaning maps onto a Mercaria role without interpretation. `product_type`,
 * `google_product_category`, `custom_label_0` and their relatives are absent
 * because mapping them onto `category` would be a decision about taxonomy that
 * #56's registry owns.
 */
const GOOGLE_ALIASES: Readonly<Record<string, FeedFieldRole>> = {
  title: 'title',
  description: 'description',
  link: 'destination_url',
  ads_redirect: 'affiliate_url',
  image_link: 'image',
  additional_image_link: 'additional_images',
  availability: 'availability',
  price: 'price',
  sale_price: 'sale_price',
  brand: 'brand',
  gtin: 'gtin',
  mpn: 'mpn',
  condition: 'condition',
  product_type: 'category',
  quantity: 'available_quantity',
  shipping_label: 'region',
  content_language: 'language',
  target_country: 'country',
  material: 'option_value_1',
  color: 'option_value_1',
  size: 'option_value_2',
  pattern: 'option_value_3',
};

/** Common non-Google spellings that mean exactly one Mercaria role. */
const COMMON_ALIASES: Readonly<Record<string, FeedFieldRole>> = {
  name: 'title',
  product_name: 'title',
  manufacturer: 'brand',
  ean: 'ean',
  upc: 'upc',
  isbn: 'isbn',
  sku: 'sku',
  merchant_sku: 'sku',
  model: 'model',
  category: 'category',
  in_stock: 'availability',
  stock_quantity: 'available_quantity',
  search_price: 'price',
  store_price: 'sale_price',
  currency: 'price_currency',
  delivery_cost: 'delivery_cost',
  aw_deep_link: 'affiliate_url',
  merchant_image_url: 'image',
  last_updated: 'source_updated_at',
};

/**
 * Suggest a role for each of a feed's own columns.
 *
 * At most one suggestion per ROLE, first match wins in the header's own order —
 * two columns both suggesting `price` would give a merchant a choice with no
 * basis for making it, and the second is offered as an unsuggested column they
 * can map deliberately.
 */
export function suggestFeedFieldMappings(
  headers: readonly string[],
): readonly FeedMappingSuggestion[] {
  const suggestions: FeedMappingSuggestion[] = [];
  const claimed = new Set<FeedFieldRole>();

  for (const header of headers) {
    const match = suggestOne(header);
    if (match === null || claimed.has(match.role)) continue;
    claimed.add(match.role);
    suggestions.push({ role: match.role, sourceField: header, basis: match.basis });
  }
  return suggestions;
}

function suggestOne(
  header: string,
): { role: FeedFieldRole; basis: FeedMappingSuggestionBasis } | null {
  const trimmed = header.trim();
  if (trimmed === '') return null;

  const asRole = trimmed.toLowerCase();
  if ((FEED_FIELD_ROLES as readonly string[]).includes(asRole)) {
    return { role: asRole as FeedFieldRole, basis: 'exact_role_name' };
  }

  // `g:price` and `g_price` are the same column with the namespace still
  // attached — a Google XML feed read by a merchant who pasted the raw name.
  const colon = trimmed.lastIndexOf(':');
  if (colon !== -1) {
    const local = trimmed.slice(colon + 1).toLowerCase();
    const aliased = GOOGLE_ALIASES[local] ?? COMMON_ALIASES[local];
    if (aliased !== undefined) return { role: aliased, basis: 'namespace_stripped' };
  }

  const google = GOOGLE_ALIASES[asRole];
  if (google !== undefined) return { role: google, basis: 'google_merchant_alias' };

  const normalized = asRole.replace(/[\s-]+/gu, '_').replace(/[^a-z0-9_]/gu, '');
  const common = COMMON_ALIASES[normalized] ?? GOOGLE_ALIASES[normalized];
  if (common !== undefined) return { role: common, basis: 'normalized_header' };
  if ((FEED_FIELD_ROLES as readonly string[]).includes(normalized)) {
    return { role: normalized as FeedFieldRole, basis: 'normalized_header' };
  }
  return null;
}
