import type { ConnectorProviderId, PinnableConnectorField } from "@mercaria/shared-types";

/**
 * Merchant-facing copy for connector provenance and field pins (#416/#419/#420).
 *
 * Same split as every taxonomy in this package: the KEYS are
 * `@mercaria/shared-types` tuples that columns and a wire contract carry, and
 * the sentences are here so a wording change touches no stored value. Both maps
 * are exhaustive over their union by TYPE, so a member added to
 * `PINNABLE_CONNECTOR_FIELDS` fails this package's typecheck rather than
 * rendering a blank row on a merchant's product screen — and a key from
 * `UNPINNED_CONNECTOR_KEYS` cannot be added to the pin map at all, because it is
 * not in the union `Record` keys it.
 *
 * ## Why the pin copy is worded the way it is
 *
 * It speaks in the channel switch's own vocabulary — *"Keep my local edits"*,
 * *"a field you edited in Mercaria is never overwritten by a later sync"* — and
 * never in the column's (`overriddenFields`). The merchant made a decision by
 * editing a field; the column name is an implementation detail of the decision.
 *
 * There is a sentence per POLICY STATE, including one for "this viewer cannot
 * read the channel's setting". A pin is only honoured while the connection's
 * `conflictPolicy` is `respect_overrides`, so a surface that asserted "later
 * syncs will not overwrite these" under `connector_wins` would generate exactly
 * the false bug report — in the opposite direction — that showing the pins at
 * all exists to prevent.
 */

/** Human-friendly labels for each connector platform (exhaustive over the union). */
export const CONNECTOR_PROVIDER_LABELS: Record<ConnectorProviderId, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  etsy: "Etsy",
  prestashop: "PrestaShop",
  magento: "Magento",
};

/**
 * What a merchant calls each pinnable field.
 *
 * These are the words the product form uses, not the DTO's: `images` is the
 * gallery a merchant reordered, `handle` is the URL they can see, and `seo`
 * covers both columns because the connector writes them together.
 */
export const CONNECTOR_PIN_LABELS: Record<PinnableConnectorField, string> = {
  title: "Title",
  description: "Description",
  images: "Images",
  vendor: "Vendor",
  productType: "Product type",
  handle: "URL handle",
  seo: "SEO title and description",
};

/** Heading for the pinned-field notice — the switch's phrase, verbatim. */
export const CONNECTOR_PIN_TITLE = "Fields you edited in Mercaria";

/**
 * Whether the pins on a listing are currently in force.
 *
 * `unknown` is a real answer rather than a loading placeholder: the channel's
 * settings are behind `channels:write`, so a staff member looking at a product
 * genuinely cannot be told, and saying so is better than picking whichever of
 * the other two reads better.
 */
export type ConnectorPinEffect = "honoured" | "channel_wins" | "unknown";

/** What the pins mean right now, one sentence per state. */
export const CONNECTOR_PIN_EFFECT_TEXT: Record<ConnectorPinEffect, string> = {
  honoured:
    "A later sync never overwrites them, so an edit you make to one of these on the platform will not appear here.",
  channel_wins:
    "This channel's “Keep my local edits” setting is off, so the next sync overwrites them with the platform's values.",
  unknown:
    "Whether a later sync overwrites them is the channel's “Keep my local edits” setting.",
};

/**
 * The one escape that exists today, named honestly.
 *
 * There is no per-field release: turning the channel switch off makes EVERY pin
 * on EVERY product of that connection inert at once. Saying so is the point —
 * a merchant told only that a field is pinned would reasonably go looking for a
 * control that is not there.
 */
export const CONNECTOR_PIN_RELEASE_TEXT =
  "To let the platform take these back, turn off “Keep my local edits” on the channel. That applies to every edited field on every product from this channel — there is no per-field release yet.";

/**
 * A key held against sync that this surface has no name for.
 *
 * Reachable because `listings.overriddenFields` is a bare `text[]` no merchant
 * edit is the only writer of. Counted rather than dropped: a hidden pin is the
 * exact defect this notice exists to close, and rendering the raw key would put
 * a column name in front of a merchant.
 */
export function connectorPinUnnamedText(count: number): string {
  return count === 1
    ? "1 more field is held against sync that this screen cannot name."
    : `${count} more fields are held against sync that this screen cannot name.`;
}
