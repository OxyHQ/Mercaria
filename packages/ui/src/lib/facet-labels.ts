/**
 * The reader-facing copy for the facet rail's STABLE KEYS — as translation keys.
 *
 * ## What this file exists to stop
 *
 * `services/facets/labels.ts` resolves every facet string it holds copy for and
 * reports the rest through `stableKeyLabel`, which returns
 * `{ text: <the machine key>, source: 'stable_key' }`. Its docblock says why
 * plainly: Mercaria holds no localization row for a commerce dimension, there is
 * no `commerce_dimension` entity for a translator to put "Precio" on, and
 * inventing English server-side would look like copy nobody needs to translate.
 * So the server hands the client a key and says, in the `source` field, that it
 * is a key.
 *
 * **The client owned that copy and did not have it.** Every commerce dimension
 * and the taxonomy refinement arrive `stable_key`, so a rail rendering
 * `label.text` directly showed a shopper `offer_price`, `availability`,
 * `condition`, `market`, `offer_channel` and `category` as filter titles, with
 * raw bucket keys beneath them — in every locale, English included. That is
 * epic #367's "public clients never display raw internal keys as normal UX"
 * failing in the one place a `FacetLabel.source` was designed to prevent it.
 *
 * This module is the missing half. It is the `lib/condition.ts` pattern exactly:
 * module-scope data holds KEYS, the sentences live in
 * `packages/ui/src/i18n/locales/*.json` under the reserved `ui` namespace, and
 * the render site resolves them.
 *
 * ## Why the maps are `Record` over a closed union
 *
 * `Readonly<Record<FacetStableTitle, string>>` makes a dimension added to
 * `FACET_COMMERCE_DIMENSIONS` a COMPILE ERROR here rather than a raw key in a
 * shopper's filter rail. `bun run --filter @mercaria/ui typecheck` runs in CI, so
 * that is a real gate and not a convention — which matters more than usual here,
 * because the failure it prevents is silent: the rail renders, the counts are
 * right, and only the word is wrong.
 *
 * The two vocabularies that are NOT shared-types tuples — the collapsed channel
 * pair and the market sentinel — are produced by SQL in
 * `db/facets/facetRepository.ts` and cannot be reached by `tsc`, so
 * `scripts/validate-facet-label-copy.mjs` reads them out of that producer and
 * fails the build if this file does not cover them. Deriving the expectation
 * from the producer is the point: two hand-written lists agreeing proves only
 * that somebody copied one.
 *
 * ## `market` is deliberately not called "Ships to"
 *
 * The bucket is `coalesce(o.country, '*')` — the country an offer is available
 * in, with NULL meaning everywhere. "Ships to" would be a delivery promise this
 * dimension does not make and Mercaria cannot keep; "Market" is the fact.
 * Region CODES are localized through `formatRegionName`, which is CLDR by way of
 * `Intl.DisplayNames` and already degrades to the bare code where Hermes has no
 * `DisplayNames` at all.
 */

import type {
  ConditionGroup,
  FacetCommerceDimension,
  FacetLabel,
  OfferAvailability,
} from "@mercaria/shared-types";
import { CONDITION_GROUPS, FACET_TAXONOMY_KEY } from "@mercaria/shared-types";
import { conditionGroupLabelKey } from "./condition";
import { formatRegionName } from "./region";

/**
 * Every facet TITLE the server reports as a stable key.
 *
 * The commerce dimensions plus the one taxonomy refinement. Attribute facets are
 * excluded because they never arrive this way: their labels come from
 * `attribute_labels` or the registry base text, which is real copy somebody
 * wrote.
 */
export type FacetStableTitle = FacetCommerceDimension | typeof FACET_TAXONOMY_KEY;

/** The title copy for each stable-key facet. */
export const FACET_TITLE_LABEL_KEYS: Readonly<Record<FacetStableTitle, string>> = {
  offer_price: "ui.facet.title.offer_price",
  availability: "ui.facet.title.availability",
  condition: "ui.facet.title.condition",
  market: "ui.facet.title.market",
  offer_channel: "ui.facet.title.offer_channel",
  category: "ui.facet.title.category",
};

/**
 * The availability buckets, which are `offers.availability` verbatim.
 *
 * `unknown` reads "Not stated" rather than "Unavailable". They are different
 * facts — one is a shop saying it has none, the other is Mercaria not having
 * been told — and the rail's own `missingDataPolicy` already treats them
 * differently, so collapsing them in the copy would contradict the filter's
 * behaviour.
 */
export const FACET_AVAILABILITY_LABEL_KEYS: Readonly<Record<OfferAvailability, string>> = {
  in_stock: "ui.facet.availability.in_stock",
  out_of_stock: "ui.facet.availability.out_of_stock",
  preorder: "ui.facet.availability.preorder",
  unavailable: "ui.facet.availability.unavailable",
  unknown: "ui.facet.availability.unknown",
};

/**
 * The channel buckets, collapsed by `countOfferChannelBuckets` to two.
 *
 * A local union rather than a shared-types tuple because the collapse lives in
 * that repository's SQL and nothing in shared-types names it. The completeness
 * gate therefore reads the SQL rather than this file — see the header.
 */
export type FacetChannelBucket = "native" | "external";

/** The channel copy. */
export const FACET_CHANNEL_LABEL_KEYS: Readonly<Record<FacetChannelBucket, string>> = {
  native: "ui.facet.channel.native",
  external: "ui.facet.channel.external",
};

/** The market sentinel: a NULL country, which means every market rather than none. */
export const FACET_MARKET_ANY_BUCKET = "*";

/** The copy for {@link FACET_MARKET_ANY_BUCKET}. */
export const FACET_MARKET_ANY_LABEL_KEY = "ui.facet.market.any";

/** Whether a string names a facet whose title this module holds copy for. */
export function isFacetStableTitle(key: string): key is FacetStableTitle {
  return Object.prototype.hasOwnProperty.call(FACET_TITLE_LABEL_KEYS, key);
}

/**
 * The translation key for a stable-key facet title, or `null`.
 *
 * `null` rather than a thrown error or an invented string: a facet this module
 * has no copy for is a fact the caller has to decide about, and the caller has
 * the server's own text to fall back to. Throwing would take a whole filter rail
 * down over one unrecognised dimension.
 */
export function facetTitleLabelKey(facetKey: string): string | null {
  return isFacetStableTitle(facetKey) ? FACET_TITLE_LABEL_KEYS[facetKey] : null;
}

/**
 * A stable BUCKET key's reader-facing text, resolved against the facet it sits
 * under.
 *
 * The facet key is required because the bucket vocabularies overlap in shape and
 * not in meaning — `unknown` is an availability state and `new` is a condition
 * group, and neither is readable without knowing which dimension asked. Returns
 * `null` when this module holds no copy, so the caller keeps its own fallback.
 *
 * `market` is the one dimension whose buckets are open-ended: they are region
 * codes, so they go through CLDR rather than through a key map, and only the
 * NULL sentinel needs copy of its own.
 */
export function facetStableBucketText(
  facetKey: string,
  bucketKey: string,
  translate: (key: string) => string,
  locale: string,
): string | null {
  if (facetKey === "availability") {
    return Object.prototype.hasOwnProperty.call(FACET_AVAILABILITY_LABEL_KEYS, bucketKey)
      ? translate(FACET_AVAILABILITY_LABEL_KEYS[bucketKey as OfferAvailability])
      : null;
  }
  if (facetKey === "offer_channel") {
    return Object.prototype.hasOwnProperty.call(FACET_CHANNEL_LABEL_KEYS, bucketKey)
      ? translate(FACET_CHANNEL_LABEL_KEYS[bucketKey as FacetChannelBucket])
      : null;
  }
  if (facetKey === "condition") {
    // #90's SEGMENT grain, which is what `facet.service.ts` reports through
    // `CONDITION_KEY_GROUP`. The copy already exists for all twelve locales, so
    // this dimension needs no key of its own here.
    return isConditionGroup(bucketKey) ? translate(conditionGroupLabelKey(bucketKey)) : null;
  }
  if (facetKey === "market") {
    if (bucketKey === FACET_MARKET_ANY_BUCKET) return translate(FACET_MARKET_ANY_LABEL_KEY);
    const region = formatRegionName(bucketKey, locale);
    return region.trim().length > 0 ? region : null;
  }
  return null;
}

/**
 * A facet TITLE as a reader should see it.
 *
 * The `source` check is the whole point and it belongs here rather than at the
 * render site: `stable_key` is the ONE source whose `text` is not copy, and a
 * component deciding that for itself is a decision that has to be re-made
 * correctly in every rail anybody writes next. `localization`,
 * `registry_base` and `attribute_label` all carry text somebody wrote, so they
 * pass through untouched — including a `registry_base` string in the wrong
 * language, which is real copy in a fallback and not this function's problem.
 *
 * The fallback when this module holds no copy is the server's own `text`. That
 * is the raw key for a `stable_key` label, which is the pre-existing behaviour
 * — so a dimension nobody added copy for is no WORSE than before, and
 * `validate:facet-label-copy` is what stops it reaching that state.
 */
export function facetTitleText(
  facetKey: string,
  label: FacetLabel,
  translate: (key: string) => string,
): string {
  if (label.source !== "stable_key") return label.text;
  const copyKey = facetTitleLabelKey(facetKey);
  return copyKey === null ? label.text : translate(copyKey);
}

/**
 * A facet GROUP heading as a reader should see it.
 *
 * A group name comes from the attribute registry, so today it always arrives
 * `localization` or `registry_base` and this is a pass-through. It exists as its
 * own function rather than sharing {@link facetTitleText} because the group is
 * NOT the facet: passing the facet's key to the title map would resolve a
 * `stable_key` group heading to the facet's own title and render "Price" as the
 * name of the group containing it — wrong in a way nobody would question.
 *
 * There is no group-key vocabulary to hold copy for, so a `stable_key` group
 * returns its key. If the service ever starts reporting one, this is the
 * function that gains the map, and the gate is what makes that visible rather
 * than letting a raw key appear under a heading nobody reads closely.
 */
export function facetGroupText(label: FacetLabel): string {
  return label.text;
}

/**
 * A facet BUCKET as a reader should see it.
 *
 * Same shape as {@link facetTitleText}, and the same reason. A taxonomy bucket
 * is a category NAME resolved through the localization family, so it arrives
 * `localization` or `registry_base` and returns immediately — only the commerce
 * dimensions reach the key maps.
 */
export function facetBucketText(
  facetKey: string,
  bucketKey: string,
  label: FacetLabel,
  translate: (key: string) => string,
  locale: string,
): string {
  if (label.source !== "stable_key") return label.text;
  return facetStableBucketText(facetKey, bucketKey, translate, locale) ?? label.text;
}

/**
 * A selection the current results can no longer offer, as a reader should see it.
 *
 * There is no `FacetLabel` at all here: the server echoed a stable VALUE for a
 * facet it did not offer, so there is nothing to check a `source` on and the raw
 * key is all that ever reached the screen. The remedy for "no results" is to
 * remove one of these chips, and a shopper cannot recognise which filter to drop
 * when it is spelled `out_of_stock`.
 *
 * Falls back to the key. That is deliberate and is the honest end of the chain:
 * an attribute value Mercaria holds no copy for has no better spelling
 * available, and inventing one here would be the server-side mistake
 * `stableKeyLabel` exists to avoid, moved to the client.
 */
export function facetStrandedValueText(
  facetKey: string,
  value: string,
  translate: (key: string) => string,
  locale: string,
): string {
  return facetStableBucketText(facetKey, value, translate, locale) ?? value;
}

/**
 * A membership test over #90's condition groups.
 *
 * The set is built FROM `CONDITION_GROUPS` rather than re-spelled here, so a
 * group added to the taxonomy is admitted without an edit to this file — and
 * `conditionGroupLabelKey`'s own `Record<ConditionGroup, string>` is what fails
 * the typecheck if that new group has no copy. A hand-written copy of the tuple
 * would go stale silently in the one direction that matters: a new group would
 * fail this test, return `null`, and fall back to rendering its raw key.
 */
const CONDITION_GROUP_SET: ReadonlySet<string> = new Set<string>(CONDITION_GROUPS);

function isConditionGroup(value: string): value is ConditionGroup {
  return CONDITION_GROUP_SET.has(value);
}
