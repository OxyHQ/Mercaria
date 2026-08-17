import type { ConnectorProviderId, PinnableConnectorField } from "@mercaria/shared-types";

/**
 * Merchant-facing copy for connector provenance and field pins
 * (#416/#419/#420) — as TRANSLATION KEYS.
 *
 * Same split as every taxonomy in this package: the KEYS are
 * `@mercaria/shared-types` tuples that columns and a wire contract carry, and
 * the sentences are in `packages/ui/src/i18n/locales/*.json` since #437, so a
 * wording change touches no stored value and one sentence is translated once
 * for all three apps. Both maps are exhaustive over their union by TYPE, so a
 * member added to `PINNABLE_CONNECTOR_FIELDS` fails this package's typecheck
 * rather than rendering a blank row on a merchant's product screen — and a key
 * from `UNPINNED_CONNECTOR_KEYS` cannot be added to the pin map at all, because
 * it is not in the union `Record` keys it.
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
 *
 * ## The sentence that must not promise a restore now lives in the BUNDLE
 *
 * `CONNECTOR_PIN_RELEASE_KEY`'s text deliberately does NOT say "restore":
 * turning the switch off makes the pins inert without deleting them, so the
 * platform overwrites those fields at its next sync and nothing anywhere holds
 * the values they had before the merchant edited them. That property used to be
 * asserted against THIS FILE by `connector-pin-visibility.test.ts`. Since the
 * sentence moved, so did the assertion — it now reads
 * `ui/src/i18n/locales/en.json`, with a vacuity floor, because a file holding
 * only key strings satisfies "contains no forbidden word" perfectly and would
 * have gone on passing while guarding nothing.
 */

/**
 * Each connector platform's name.
 *
 * These are BRAND names and most locales will render them identically. They are
 * still keys, for the reason every brand name in this repository is one: some
 * scripts transliterate, and the decision then sits in the bundle where a
 * translator can see it rather than being unavailable to them.
 */
export const CONNECTOR_PROVIDER_LABEL_KEYS: Record<ConnectorProviderId, string> = {
  shopify: "ui.connector.provider.shopify",
  woocommerce: "ui.connector.provider.woocommerce",
  etsy: "ui.connector.provider.etsy",
  prestashop: "ui.connector.provider.prestashop",
  magento: "ui.connector.provider.magento",
};

/** "Synced from %{provider}" — the whole sentence, never a `${}` around a name. */
export const CONNECTOR_SYNCED_FROM_KEY = "ui.connector.syncedFrom";

/**
 * What a merchant calls each pinnable field.
 *
 * These are the words the product form uses, not the DTO's: `images` is the
 * gallery a merchant reordered, `handle` is the URL they can see, and `seo`
 * covers both columns because the connector writes them together.
 */
export const CONNECTOR_PIN_LABEL_KEYS: Record<PinnableConnectorField, string> = {
  title: "ui.connector.pinField.title",
  description: "ui.connector.pinField.description",
  images: "ui.connector.pinField.images",
  vendor: "ui.connector.pinField.vendor",
  productType: "ui.connector.pinField.productType",
  handle: "ui.connector.pinField.handle",
  seo: "ui.connector.pinField.seo",
};

/** Heading for the pinned-field notice — the switch's phrase, verbatim. */
export const CONNECTOR_PIN_TITLE_KEY = "ui.connector.pinTitle";

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
export const CONNECTOR_PIN_EFFECT_KEYS: Record<ConnectorPinEffect, string> = {
  honoured: "ui.connector.pinEffect.honoured",
  channel_wins: "ui.connector.pinEffect.channelWins",
  unknown: "ui.connector.pinEffect.unknown",
};

/**
 * The CONNECTION-WIDE escape, named honestly.
 *
 * It said "there is no per-field release yet" until #427 built one, which is
 * exactly the kind of sentence that outlives its truth: nothing about a copy
 * constant fails when the claim inside it stops holding. What is left is the
 * fact that survives — the switch is the blunt instrument, and it reaches every
 * edited field on every product of the connection at once, where the per-field
 * release beside each pin above reaches one.
 *
 * See the module note for where the "must not promise a restore" assertion went.
 */
export const CONNECTOR_PIN_RELEASE_KEY = "ui.connector.pinRelease";

/**
 * A key held against sync that this surface has no name for.
 *
 * Reachable because `listings.overriddenFields` is a bare `text[]` no merchant
 * edit is the only writer of. Counted rather than dropped: a hidden pin is the
 * exact defect this notice exists to close, and rendering the raw key would put
 * a column name in front of a merchant.
 *
 * A pluralised KEY, not a function that builds one of two sentences. The old
 * version chose between two English literals on `count === 1`, which is a
 * plural rule only English and a handful of others have — and, worse, was copy
 * no extraction scan could find, because neither sentence was a map entry.
 */
export const CONNECTOR_PIN_UNNAMED_KEY = "ui.connector.pinUnnamed";
