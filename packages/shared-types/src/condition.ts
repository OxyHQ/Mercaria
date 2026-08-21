/**
 * The item-condition taxonomy — issue #90.
 *
 * The binary `new | used` this replaces could not say what a buyer actually
 * needs to know, and its failure mode was silent: two listings with the same
 * label described a sealed retail box and a cracked phone that will not charge.
 *
 * ## The four things this module makes structural rather than conventional
 *
 * 1. **Stored KEYS are stable; display copy is not.** Every tuple here is a
 *    machine name a Postgres CHECK is rendered from (the `ALL_CURRENCY_CODES`
 *    device). Labels and plain-language explanations live in `@mercaria/ui` and
 *    may change at any time — the #94 registry's rule, one domain over.
 * 2. **An inference may never assert a claim-bearing condition.** A coarse
 *    input — the legacy binary field, a low-confidence external label — can
 *    only produce a member of {@link UNREFINED_CONDITION_KEYS}, and
 *    `used_like_new` is deliberately not one of them. The CHECK on
 *    `listings.condition_assertion` is rendered from that same tuple, so
 *    migration rule 2 is a constraint rather than a comment in a backfill.
 * 3. **A catalogue image can never be condition evidence.** The photo
 *    provenance set has only seller-owned members;
 *    {@link FORBIDDEN_CONDITION_PHOTO_PROVENANCES} names what is deliberately
 *    absent so a scanned gate can assert the two are disjoint, and a database
 *    trigger refuses a file id that a canonical image already claims.
 * 4. **A condition never carries a quality guarantee.** Nothing here maps a key
 *    to a score, a rank or a warranty; the evidence policy says only what the
 *    SELLER must disclose (#90 policy rule 7).
 *
 * Category-specific condition facts — battery health, activation-lock state,
 * garment alterations — are NOT modelled here. They are attributes of a
 * category and belong to #94's versioned registry
 * (`services/attributes/`, `docs/attributes.md`); adding a top-level column for
 * one would create a second, unversioned vocabulary beside it.
 * {@link CONDITION_REGISTRY_DELEGATED_FACT_KEYS} names the ones #90 identified
 * so the delegation is legible rather than an omission.
 */

import { wordTokens } from './text-fold';

/**
 * The nine stable condition keys (#90 base taxonomy).
 *
 * The ORDER is the sale-quality order a UI presents them in and is part of the
 * contract — {@link compareConditionQuality} reads it — but it is deliberately
 * NOT a score: nothing multiplies, ranks or prices against a position here.
 * Ranking is #74's, and `condition-isolation.test.ts` fails the build if a
 * ranking module reaches this domain.
 */
export type ItemConditionKey =
  /** Unused, unopened, in its original packaging as the manufacturer shipped it. */
  | 'new'
  /** Never used, but the packaging was opened — a returned or display unit. */
  | 'open_box'
  /** Restored and re-certified by the manufacturer or its authorised programme. */
  | 'refurbished_manufacturer'
  /** Restored by the seller or a third party, who must be named. */
  | 'refurbished_seller'
  /** Used, with no visible wear at normal viewing distance. */
  | 'used_like_new'
  /** Used, with light wear that does not affect function. */
  | 'used_good'
  /** Used, with obvious wear or a disclosed minor fault. */
  | 'used_fair'
  /** Used, heavily worn or with a disclosed fault that affects use. */
  | 'used_poor'
  /** Sold as non-functional, for repair, salvage or components. */
  | 'for_parts';

/**
 * Every condition key, as the runtime tuple the Postgres CHECK is rendered from.
 *
 * The `ALL_LISTING_STATUSES` reasoning verbatim: a schema that declares its own
 * `readonly ItemConditionKey[]` accepts a hand-written SUBSET, so a key added to
 * the union leaves `tsc` silent while the CHECK never learns about it and the
 * first write of the new value fails at runtime with a 23514.
 */
export const ITEM_CONDITION_KEYS: readonly ItemConditionKey[] = [
  'new',
  'open_box',
  'refurbished_manufacturer',
  'refurbished_seller',
  'used_like_new',
  'used_good',
  'used_fair',
  'used_poor',
  'for_parts',
];

/**
 * The coarse SEGMENT a condition belongs to (#90 acceptance 2, propagation 4
 * and 5).
 *
 * Filtering, price history and price alerts operate on the GROUP rather than the
 * key, because "the cheapest one" across a refurbished unit and a for-parts
 * shell is not a comparison anybody asked for. Five groups rather than the
 * issue's four named ones: `open_box` is neither new nor used, and folding it
 * into either would make one of the two filters lie.
 */
export type ConditionGroup = 'new' | 'open_box' | 'refurbished' | 'used' | 'for_parts';

export const CONDITION_GROUPS: readonly ConditionGroup[] = [
  'new',
  'open_box',
  'refurbished',
  'used',
  'for_parts',
];

/**
 * Key → group, total by construction.
 *
 * A `Record` rather than a function with a `switch` and a default: a key added
 * to the union without a group is a compile error here, whereas a `default`
 * branch would silently absorb it into whatever group the author chose.
 */
export const CONDITION_KEY_GROUP: Readonly<Record<ItemConditionKey, ConditionGroup>> = {
  new: 'new',
  open_box: 'open_box',
  refurbished_manufacturer: 'refurbished',
  refurbished_seller: 'refurbished',
  used_like_new: 'used',
  used_good: 'used',
  used_fair: 'used',
  used_poor: 'used',
  for_parts: 'for_parts',
};

/** The segment a condition key belongs to. */
export function conditionGroupFor(key: ItemConditionKey): ConditionGroup {
  return CONDITION_KEY_GROUP[key];
}

/** Every key in one group, in taxonomy order. */
export function conditionKeysInGroup(group: ConditionGroup): readonly ItemConditionKey[] {
  return ITEM_CONDITION_KEYS.filter((key) => CONDITION_KEY_GROUP[key] === group);
}

/**
 * Order two keys by sale quality, using their position in the taxonomy tuple.
 *
 * Negative when `a` is the better-condition item. This exists so a UI can sort a
 * condition picker and a comparison can label a segment; it is NOT a ranking
 * input, and it deliberately returns an ordering rather than a score so nothing
 * can multiply it by a fee, a bid or a margin.
 */
export function compareConditionQuality(a: ItemConditionKey, b: ItemConditionKey): number {
  return ITEM_CONDITION_KEYS.indexOf(a) - ITEM_CONDITION_KEYS.indexOf(b);
}

// ---------------------------------------------------------------------------
// The offer-side vocabulary: the taxonomy plus an honest `unknown`
// ---------------------------------------------------------------------------

/**
 * What an OFFER may say about condition — every taxonomy key plus `unknown`
 * (ADR 0002 D18).
 *
 * `unknown` exists only here and never on a native listing: a seller always
 * knows what they are selling, while most external feeds publish no condition at
 * all and inventing `new` for them is how a comparison surface starts telling
 * buyers a refurbished unit is sealed.
 */
export type OfferConditionKey = ItemConditionKey | 'unknown';

export const OFFER_CONDITION_KEYS: readonly OfferConditionKey[] = [
  ...ITEM_CONDITION_KEYS,
  'unknown',
];

/** Whether an offer's condition is a real answer rather than an absence. */
export function isKnownOfferCondition(value: OfferConditionKey): value is ItemConditionKey {
  return value !== 'unknown';
}

// ---------------------------------------------------------------------------
// How a stored condition came to be asserted
// ---------------------------------------------------------------------------

/**
 * Who or what put this condition on the row.
 *
 * Not provenance trivia: it is what the "unrefined" CHECK keys off, and what
 * lets a dashboard ask a seller to refine a listing the migration guessed at
 * without also nagging one they chose deliberately.
 */
export type ConditionAssertion =
  /** A human seller chose it from the full taxonomy on a Mercaria surface. */
  | 'seller_declared'
  /** An external source's own label was mapped onto the taxonomy. */
  | 'source_declared'
  /** A catalogue operator corrected it, with a reason and an audit row. */
  | 'operator_corrected'
  /** The deterministic migration off the legacy binary field (#90 migration 1–2). */
  | 'migrated_binary'
  /** A client still speaking the v1 binary contract wrote it (see `LEGACY_CONDITION_CONTRACT`). */
  | 'legacy_client_binary';

export const CONDITION_ASSERTIONS: readonly ConditionAssertion[] = [
  'seller_declared',
  'source_declared',
  'operator_corrected',
  'migrated_binary',
  'legacy_client_binary',
];

/**
 * The assertions that carry NO refined statement about the item.
 *
 * Both members mean the same thing: something coarse produced this value and
 * nobody has looked at the nine keys since. They stay two values rather than one
 * because a backfill and a live v1 client are different facts about different
 * systems — one is finished and the other tells you a client version is still in
 * the field.
 */
export const UNREFINED_CONDITION_ASSERTIONS: readonly ConditionAssertion[] = [
  'migrated_binary',
  'legacy_client_binary',
];

/**
 * The ONLY keys an unrefined assertion may carry — #90 migration rule 2, and the
 * single most important constraint in this file.
 *
 * `used_like_new` is deliberately absent, and so is every refurbished and
 * open-box key: each of those is a CLAIM about an item nobody has re-examined.
 * A legacy `used` therefore lands on `used_good`, the generic middle of the used
 * group, and can only move upward when a human declares it.
 *
 * The CHECK on `listings` is rendered from this tuple, so the rule survives a
 * service bug, a `psql` session and a future backfill — it is not something the
 * migration has to remember.
 */
export const UNREFINED_CONDITION_KEYS: readonly ItemConditionKey[] = ['new', 'used_good'];

/** Whether this key may be asserted without a human or a source having declared it. */
export function isUnrefinedConditionKey(key: ItemConditionKey): boolean {
  return UNREFINED_CONDITION_KEYS.includes(key);
}

// ---------------------------------------------------------------------------
// The v1 binary contract — a VERSIONED wire contract, not a compatibility shim
// ---------------------------------------------------------------------------

/** The legacy field's two values. */
export type LegacyBinaryCondition = 'new' | 'used';

export const LEGACY_BINARY_CONDITIONS: readonly LegacyBinaryCondition[] = ['new', 'used'];

/**
 * The v1 spelling of a condition, on the way IN.
 *
 * `new` is lossless. `used` is not — it names a group, not a key — so it lands
 * on the conservative generic member and the row records
 * `legacy_client_binary`, which is exactly what the migration records for the
 * same input. Two paths producing one coarse value must produce the SAME coarse
 * value, or a listing's condition would depend on which client created it.
 */
export const LEGACY_BINARY_CONDITION_TARGET: Readonly<
  Record<LegacyBinaryCondition, ItemConditionKey>
> = {
  new: 'new',
  used: 'used_good',
};

/**
 * The v1 spelling of a condition, on the way OUT — the compatibility PROJECTION
 * (#90 propagation rule 8).
 *
 * Derived on every read and stored nowhere, so it can never disagree with the
 * key it projects. Everything outside the `new` group reads `used`, which is the
 * honest coarsening: a v1 client has no way to render `for_parts` and telling it
 * `new` would put a salvage shell in a "brand new" filter.
 */
export function legacyBinaryConditionFor(key: ItemConditionKey): LegacyBinaryCondition {
  return CONDITION_KEY_GROUP[key] === 'new' ? 'new' : 'used';
}

/**
 * The versioned contract the legacy binary field is served under.
 *
 * This is the one compatibility surface #90 adds, and it exists for the reason
 * `checkout`'s `addressId` does: a shipped mobile build cannot be recalled. It
 * is a CONTRACT with a stated retirement condition, not a deprecated alias —
 * nothing here is marked `@deprecated`, and the projection is computed rather
 * than stored so there is no second value to keep in step.
 *
 * `retiresWhen` is prose on purpose. The condition is observable (no supported
 * client version still sends or reads the binary field) and the decision to act
 * on it is a release decision, not something a constant can make.
 */
export const LEGACY_CONDITION_CONTRACT = {
  version: 'v1',
  field: 'condition',
  supersededBy: 'itemCondition',
  retiresWhen:
    'no supported client version still sends or reads the binary `condition` field; ' +
    'until then a v1 write records `legacy_client_binary` and a v1 read gets the derived projection',
} as const;

// ---------------------------------------------------------------------------
// Evidence policy — a TABLE, not a switch
// ---------------------------------------------------------------------------

/**
 * What a seller must supply before a listing in this condition may be published.
 *
 * The `claim-methods.ts` device from #83: every per-key property lives in one
 * table and the services read it, so nothing in the evidence path ever asks
 * "is the condition `used_good`". Adding a key to the taxonomy without a policy
 * row is a compile error.
 */
export interface ConditionEvidencePolicy {
  readonly key: ItemConditionKey;
  readonly group: ConditionGroup;
  /**
   * Whether the seller must attach photographs of THIS unit (#90 evidence 1).
   *
   * True for every key but `new`, and the boundary is not "used": an open-box or
   * refurbished unit is also one specific physical object whose state a buyer
   * cannot infer from the catalogue, which is precisely what a stock photo
   * cannot answer.
   */
  readonly requiresItemPhotos: boolean;
  /** How many seller-owned photos the listing needs. Zero when none are required. */
  readonly minimumItemPhotos: number;
  /**
   * Whether the seller must explicitly acknowledge defects and missing parts
   * (#90 policy rule 2) — an affirmative act, never a default.
   */
  readonly requiresDefectAcknowledgement: boolean;
  /** Whether the party who refurbished the item must be named (#90 evidence 7). */
  readonly requiresRefurbisherAttribution: boolean;
}

/** The evidence contract, one row per key. */
export const CONDITION_EVIDENCE_POLICIES: Readonly<
  Record<ItemConditionKey, ConditionEvidencePolicy>
> = {
  new: {
    key: 'new',
    group: 'new',
    requiresItemPhotos: false,
    minimumItemPhotos: 0,
    requiresDefectAcknowledgement: false,
    requiresRefurbisherAttribution: false,
  },
  open_box: {
    key: 'open_box',
    group: 'open_box',
    requiresItemPhotos: true,
    minimumItemPhotos: 1,
    requiresDefectAcknowledgement: true,
    requiresRefurbisherAttribution: false,
  },
  refurbished_manufacturer: {
    key: 'refurbished_manufacturer',
    group: 'refurbished',
    requiresItemPhotos: true,
    minimumItemPhotos: 1,
    requiresDefectAcknowledgement: true,
    requiresRefurbisherAttribution: true,
  },
  refurbished_seller: {
    key: 'refurbished_seller',
    group: 'refurbished',
    requiresItemPhotos: true,
    minimumItemPhotos: 2,
    requiresDefectAcknowledgement: true,
    requiresRefurbisherAttribution: true,
  },
  used_like_new: {
    key: 'used_like_new',
    group: 'used',
    requiresItemPhotos: true,
    minimumItemPhotos: 2,
    requiresDefectAcknowledgement: true,
    requiresRefurbisherAttribution: false,
  },
  used_good: {
    key: 'used_good',
    group: 'used',
    requiresItemPhotos: true,
    minimumItemPhotos: 2,
    requiresDefectAcknowledgement: true,
    requiresRefurbisherAttribution: false,
  },
  used_fair: {
    key: 'used_fair',
    group: 'used',
    requiresItemPhotos: true,
    minimumItemPhotos: 2,
    requiresDefectAcknowledgement: true,
    requiresRefurbisherAttribution: false,
  },
  used_poor: {
    key: 'used_poor',
    group: 'used',
    requiresItemPhotos: true,
    minimumItemPhotos: 2,
    requiresDefectAcknowledgement: true,
    requiresRefurbisherAttribution: false,
  },
  for_parts: {
    key: 'for_parts',
    group: 'for_parts',
    requiresItemPhotos: true,
    minimumItemPhotos: 2,
    requiresDefectAcknowledgement: true,
    requiresRefurbisherAttribution: false,
  },
};

/** The evidence contract for one key. */
export function conditionEvidencePolicy(key: ItemConditionKey): ConditionEvidencePolicy {
  return CONDITION_EVIDENCE_POLICIES[key];
}

// ---------------------------------------------------------------------------
// Structured condition details
// ---------------------------------------------------------------------------

/**
 * A structured fact a seller or a source states about the item's condition
 * (#90 condition details 1, 2, 4, 5, 6, 7, 10).
 *
 * Battery health, activation/lock status and garment alterations are absent by
 * design — see {@link CONDITION_REGISTRY_DELEGATED_FACT_KEYS}.
 */
export type ConditionDetailKind =
  /** Scratches, dents, fading — appearance only. */
  | 'cosmetic_wear'
  /** Something does not work as it should, described in the seller's own words. */
  | 'functional_defect'
  /** A cable, remote, manual or part that is not included. */
  | 'missing_accessory'
  /** Whether the original box and inserts are present. */
  | 'original_packaging'
  /** What was repaired or refurbished, and by whom (#90 evidence 7). */
  | 'repair_or_refurbishment'
  /** A warranty the seller can evidence (#90 condition detail 7). */
  | 'warranty'
  /** Free-text condition notes (#90 condition detail 10). */
  | 'note';

export const CONDITION_DETAIL_KINDS: readonly ConditionDetailKind[] = [
  'cosmetic_wear',
  'functional_defect',
  'missing_accessory',
  'original_packaging',
  'repair_or_refurbishment',
  'warranty',
  'note',
];

/**
 * The detail kinds that COUNT as disclosing a defect or a missing part.
 *
 * The acknowledgement gate (#90 policy rule 2) reads this rather than "any
 * detail row": a seller who added only `original_packaging: present` has
 * acknowledged nothing, and letting that satisfy the gate would turn an
 * affirmative disclosure into a checkbox.
 */
export const CONDITION_DISCLOSURE_KINDS: readonly ConditionDetailKind[] = [
  'cosmetic_wear',
  'functional_defect',
  'missing_accessory',
];

/**
 * The detail kinds that MUST carry a written note.
 *
 * "There is a fault" with no description is not a disclosure. `cosmetic_wear`
 * is absent because its severity already says something, and
 * `original_packaging` because its own state does.
 */
export const CONDITION_DETAIL_KINDS_REQUIRING_NOTE: readonly ConditionDetailKind[] = [
  'functional_defect',
  'missing_accessory',
  'repair_or_refurbishment',
  'warranty',
  'note',
];

/** The detail kinds that may carry a severity. */
export const CONDITION_DETAIL_KINDS_WITH_SEVERITY: readonly ConditionDetailKind[] = [
  'cosmetic_wear',
  'functional_defect',
];

/** How bad a wear mark or a fault is, in the seller's own assessment. */
export type ConditionDetailSeverity = 'light' | 'moderate' | 'heavy';

export const CONDITION_DETAIL_SEVERITIES: readonly ConditionDetailSeverity[] = [
  'light',
  'moderate',
  'heavy',
];

/**
 * Category-specific condition facts, delegated to #94's versioned attribute
 * registry rather than modelled here.
 *
 * These are the three the issue names (condition details 3, 8 and 9). They are
 * attribute KEYS, not columns: `battery_health_percentage` means nothing on a
 * sofa, and a nullable top-level column for it would be an unversioned second
 * vocabulary beside a registry that already versions its meanings, freezes them
 * on publication, and records which ruleset read each value.
 *
 * The list is documentation with teeth: `condition-isolation.test.ts` asserts
 * that no condition-domain module defines a column or a tuple member for any of
 * them, so "we delegated this" cannot quietly become "we also did it here".
 */
export const CONDITION_REGISTRY_DELEGATED_FACT_KEYS: readonly string[] = [
  'battery_health',
  'battery_cycle_count',
  'activation_lock_state',
  'carrier_lock_state',
  'garment_alteration_state',
];

// ---------------------------------------------------------------------------
// Photographic evidence
// ---------------------------------------------------------------------------

/**
 * Where a condition photo came from — and every member is seller-owned.
 *
 * That is the whole of #90 acceptance 4 at the type level: there is no value
 * meaning "a catalogue image", so no code path can record one as evidence. The
 * database adds the second half (a trigger refusing a file id a canonical image
 * already claims), because a seller could otherwise upload a row pointing at a
 * stock photograph's file id.
 */
export type ConditionPhotoProvenance =
  /** Taken by the seller for this listing. */
  | 'seller_captured'
  /** Supplied by the seller from their own files, of this specific unit. */
  | 'seller_uploaded';

export const CONDITION_PHOTO_PROVENANCES: readonly ConditionPhotoProvenance[] = [
  'seller_captured',
  'seller_uploaded',
];

/**
 * Image sources that may NEVER satisfy the item-photo requirement.
 *
 * Deliberately DISJOINT from {@link CONDITION_PHOTO_PROVENANCES} — the
 * retail-pricing markup device. The value of naming them is that a plausible
 * future addition ("we could count the merchant's own product shot") fails a
 * build gate instead of passing review.
 */
export const FORBIDDEN_CONDITION_PHOTO_PROVENANCES = [
  'canonical_product_image',
  'canonical_variant_image',
  'source_feed_image',
  'stock_photo',
  'merchant_marketing_image',
  'manufacturer_render',
] as const;

export type ForbiddenConditionPhotoProvenance =
  (typeof FORBIDDEN_CONDITION_PHOTO_PROVENANCES)[number];

/** Where a condition photo stands with moderation (#90 evidence 3). */
export type ConditionPhotoModerationState = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export const CONDITION_PHOTO_MODERATION_STATES: readonly ConditionPhotoModerationState[] = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
];

/**
 * The moderation states in which a photo still counts as evidence.
 *
 * `pending` counts: a seller must be able to publish before a human has looked,
 * and the enforcement path already delists a listing whose photos are rejected.
 * `rejected` and `withdrawn` do not, so a listing that loses its evidence stops
 * meeting its own condition's requirement rather than keeping a stale pass.
 */
export const EVIDENTIAL_CONDITION_PHOTO_STATES: readonly ConditionPhotoModerationState[] = [
  'pending',
  'approved',
];

// ---------------------------------------------------------------------------
// Mapping an external source's own words
// ---------------------------------------------------------------------------

/**
 * How an offer's condition was arrived at (#90 evidence 5 and 6).
 *
 * The states are what makes "a low-confidence mapping is never upgraded" a
 * database constraint: only `declared` and `mapped` may sit beside a condition
 * other than `unknown`, and `mapped` requires a confidence at or above the
 * floor. There is no state in which a guess carries a taxonomy key.
 */
export type ConditionMappingState =
  /** A first-party declaration — a native listing's own key. No label, no confidence. */
  | 'declared'
  /** An external label resolved to a key at or above {@link CONDITION_MAPPING_CONFIDENCE_FLOOR}. */
  | 'mapped'
  /** A label was seen and nothing matched it. The condition stays `unknown`. */
  | 'unmapped'
  /** A rule matched BELOW the floor. The condition stays `unknown` and a review is owed. */
  | 'review_pending';

export const CONDITION_MAPPING_STATES: readonly ConditionMappingState[] = [
  'declared',
  'mapped',
  'unmapped',
  'review_pending',
];

/**
 * The confidence at or above which a source label may carry a taxonomy key.
 *
 * A single number, read by the mapping service AND rendered into the `offers`
 * CHECK, so the service and the database cannot disagree about where the line
 * is. Changing it is a code change plus a migration, exactly like adding a
 * currency code — which is the point: the floor is a policy decision with a
 * paper trail, not a constant somebody can nudge.
 */
export const CONDITION_MAPPING_CONFIDENCE_FLOOR = 0.75;

/**
 * Normalize an external condition label for lookup.
 *
 * Case-folded, whitespace-collapsed, punctuation-stripped — and NFC-normalized
 * first, so `refurbished` written with a combining accent elsewhere in the same
 * feed collapses onto one key. Deliberately lossy and deliberately dumb: it is a
 * lookup key, and every actual mapping decision is a recorded row a human wrote.
 *
 * ## It tokenizes through {@link wordTokens} (#838)
 *
 * This carried its own `[^\p{Letter}\p{Number}]+` — the #830 class in its long
 * spelling, which is why a census over `\p{L}` did not see it. `\p{Letter}`
 * EXCLUDES combining marks, so Devanagari and Bengali vowel signs became spaces:
 * measured, `साइकिल` (bicycle) and `साइकिलें` (bicycles) both normalized to
 * `"स इक ल"` and an operator's rule for one Hindi wording silently applied to a
 * different Hindi word. That is a wrong condition key on somebody's offer, and
 * it looks exactly like the mapping working.
 *
 * It does NOT fold accents, and that is unchanged: `nestlé` stays `nestlé`. NFC
 * unifies the two spellings of one accented label without deciding that two
 * different labels are one label.
 */
export function normalizeSourceConditionLabel(raw: string): string {
  return wordTokens(raw.normalize('NFC').toLowerCase()).join(' ');
}

/**
 * Which providers may own a condition-mapping ruleset (#90, widened by #65).
 *
 * #90 typed `condition_mapping_rulesets.provider` from `CONNECTOR_PROVIDER_IDS`
 * because the only sources with condition wording were the connectors a
 * Mercaria store syncs its own shop from. #62's ingestion framework and #65's
 * eBay adapter added a second kind of source entirely — somebody ELSE's
 * catalogue, read through an adapter — and those publish condition wording too.
 *
 * The tuple is a SUPERSET of `CONNECTOR_PROVIDER_IDS`, which is what makes this
 * a widening rather than a fork: every existing ruleset, rule and offer keeps
 * its provider, `mapSourceCondition` keeps accepting a `ConnectorProviderId`
 * because one is a member, and the CHECK the schema renders from this tuple only
 * ever admits more. A second ruleset table for catalog sources would have been
 * the fork — two places deciding what "Seller refurbished" means, with one
 * confidence floor between them.
 *
 * It is deliberately NOT `string`. The floor, the review queue and the
 * `offers_condition_mapped_shape_check` all key on a provider having exactly one
 * ACTIVE ruleset, and an open set means a typo publishes a ruleset nothing ever
 * reads while every offer stays `unmapped` for a reason nobody can see.
 */
export const CONDITION_MAPPING_PROVIDER_IDS = [
  'shopify',
  'woocommerce',
  'etsy',
  'prestashop',
  'magento',
  'ebay_browse',
] as const;

export type ConditionMappingProviderId = (typeof CONDITION_MAPPING_PROVIDER_IDS)[number];

/** The lifecycle of a per-provider mapping ruleset (#90 migration rule 5). */
export type ConditionMappingRulesetState = 'draft' | 'active' | 'superseded';

export const CONDITION_MAPPING_RULESET_STATES: readonly ConditionMappingRulesetState[] = [
  'draft',
  'active',
  'superseded',
];

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

/** Who changed a listing's condition (#90 evidence rule 8). */
export type ConditionRevisionActor = 'seller' | 'operator' | 'migration' | 'source';

export const CONDITION_REVISION_ACTORS: readonly ConditionRevisionActor[] = [
  'seller',
  'operator',
  'migration',
  'source',
];

/**
 * The actors that are a PERSON and must therefore be identified.
 *
 * The CHECK is rendered from this: a `seller` or `operator` revision with no
 * Oxy account id is unrepresentable, and a `migration` or `source` one with one
 * is too — a backfill has no user to blame and recording one would be a lie in
 * an audit table.
 */
export const IDENTIFIED_CONDITION_REVISION_ACTORS: readonly ConditionRevisionActor[] = [
  'seller',
  'operator',
];

// ---------------------------------------------------------------------------
// Category restrictions
// ---------------------------------------------------------------------------

/**
 * Why a category forbids a condition (#90 policy rule 5).
 *
 * Rows name what is FORBIDDEN; absence means allowed. Default-allow is the
 * honest direction: the taxonomy is universal and a restriction is a statement
 * somebody made about a specific category, so a category with no rows means
 * "nobody has restricted this", which is true, rather than "everything is
 * forbidden until an operator enumerates nine permissions".
 */
export type ConditionRestrictionReason = 'safety' | 'legal' | 'policy';

export const CONDITION_RESTRICTION_REASONS: readonly ConditionRestrictionReason[] = [
  'safety',
  'legal',
  'policy',
];

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One structured condition detail, as a client sees it. */
export interface ConditionDetailDTO {
  id: string;
  kind: ConditionDetailKind;
  severity?: ConditionDetailSeverity;
  note?: string;
}

/** One piece of photographic evidence, as a client sees it. */
export interface ConditionPhotoDTO {
  id: string;
  /** An Oxy media file id, resolved through the media chokepoint like every other. */
  fileId: string;
  provenance: ConditionPhotoProvenance;
  moderationState: ConditionPhotoModerationState;
  /** ISO-8601 upload time (#90 evidence rule 3). */
  uploadedAt: string;
  /** Whether the seller flagged this photo as showing a defect (#90 evidence rule 4). */
  showsDefect: boolean;
  /** The detail this photo evidences, when the seller named one. */
  conditionDetailId?: string;
}

/**
 * A listing's condition, as every read surface sees it.
 *
 * `group` is derived and carried anyway: a client filtering or labelling a
 * segment must not have to ship its own copy of the key→group map, and the map
 * changing is a display decision the server should own.
 */
export interface ItemConditionDTO {
  key: ItemConditionKey;
  group: ConditionGroup;
  assertion: ConditionAssertion;
  /**
   * Whether a human has chosen this from the full taxonomy — derived from
   * `assertion`, and the flag a "refine your listing" prompt reads (#90
   * migration rule 4).
   */
  refined: boolean;
  /** The source's own words, when the key came from an external label (#90 evidence 5). */
  sourceLabel?: string;
  /** ISO-8601 time the seller acknowledged the disclosed defects. */
  acknowledgedAt?: string;
  details: ConditionDetailDTO[];
  photos: ConditionPhotoDTO[];
}

/**
 * An offer's condition, as a comparison surface sees it.
 *
 * `key` may be `unknown`, and `group` is then absent rather than guessed — the
 * `OfferDelivery` discriminated-union reasoning, applied to a segment: a
 * comparison that grouped unknown offers with new ones would be a silent
 * coercion, and there is no property here to perform it with.
 */
export interface OfferConditionDTO {
  key: OfferConditionKey;
  group?: ConditionGroup;
  mappingState: ConditionMappingState;
  /** The source's own words, preserved verbatim (#90 evidence rule 5). */
  sourceLabel?: string;
  /** Which ruleset version read the label, so a correction is traceable. */
  mappingRulesetVersion?: number;
}

/**
 * A purchased line's condition, as the immutable order snapshot holds it
 * (#90 propagation rule 2, migration rule 3).
 *
 * A DISCRIMINATED UNION, and `recorded: false` has no `key` property at all.
 * Orders placed before #90 carry no condition, and the only safe answer for them
 * is "not recorded at purchase" — reading the listing's CURRENT condition would
 * rewrite what a buyer was shown, which is exactly what an order snapshot exists
 * to prevent. The union means a refund or dispute surface cannot fall into that
 * by forgetting a check: `snapshot.key` does not type-check on the absent
 * branch.
 */
export type OrderItemConditionSnapshot =
  | { recorded: false }
  | {
      recorded: true;
      key: ItemConditionKey;
      group: ConditionGroup;
      assertion: ConditionAssertion;
      /** The condition notes as they stood at purchase. */
      notes?: string;
    };

/**
 * Read an order line's condition snapshot — the SAFE READ PROJECTION #90
 * migration rule 3 asks for, and the only one there is.
 *
 * The line's own columns are the sole input. There is deliberately no parameter
 * through which a caller could pass the listing's current condition as a
 * fallback: an order placed before #90 has no condition, "not recorded" is the
 * true answer, and a projection that reached for today's value would rewrite
 * what a buyer was shown at exactly the moment somebody is disputing it.
 *
 * `group` is re-derived rather than snapshotted. The KEY is the stored fact and
 * is immutable; how keys are bucketed for display is a presentation decision
 * that should improve for old orders too, and storing a second copy would let
 * the two disagree.
 */
export function deriveOrderItemCondition(input: {
  conditionKey?: ItemConditionKey | null;
  conditionAssertion?: ConditionAssertion | null;
  conditionNotes?: string | null;
}): OrderItemConditionSnapshot {
  if (!input.conditionKey || !input.conditionAssertion) {
    return { recorded: false };
  }

  return {
    recorded: true,
    key: input.conditionKey,
    group: CONDITION_KEY_GROUP[input.conditionKey],
    assertion: input.conditionAssertion,
    ...(input.conditionNotes ? { notes: input.conditionNotes } : {}),
  };
}
