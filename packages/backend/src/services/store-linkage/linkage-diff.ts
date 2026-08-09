/**
 * The DIFF a store owner sees before linking (#84 existing-store rule 2), and
 * the list of what linkage will not touch — both as pure functions.
 *
 * ## Three sides, and only one of them is adoptable
 *
 * The issue asks for a diff between the NATIVE PROFILE, the CANONICAL MERCHANT
 * and the SOURCE FACTS, and it matters that they are not three columns of one
 * table:
 *
 *  - the native profile is the store owner's own words and stays authoritative
 *    unless they choose otherwise, field by field;
 *  - the canonical merchant is the graph's identity record, and is the ONLY
 *    side a field may be adopted from — `STORE_LINKAGE_PROFILE_SOURCES` has one
 *    member for exactly this reason;
 *  - the source facts are VERIFIED observations (a proven domain, a verified
 *    channel) shown as context. They are deliberately not adoptable into any
 *    field, which is the structural form of issue store-creation rule 4: an
 *    unverified external profile has no path into a merchant-managed field, so
 *    "do not copy them silently" is not a rule anybody has to remember.
 *
 * ## `unchanged` is part of the payload, not documentation
 *
 * A merchant deciding whether to link should be able to read what linkage will
 * leave alone from the same response that shows them what it will change,
 * rather than taking it on trust from a changelog. {@link LINKAGE_UNCHANGED} is
 * that list, and `store-linkage-isolation.test.ts` checks that the linkage path
 * imports nothing that could touch any of it.
 */

import {
  STORE_LINKAGE_PROFILE_FIELDS,
  type StoreLinkageDiff,
  type StoreLinkageDiffField,
  type StoreLinkageImpact,
  type StoreLinkageProfileField,
  type StoreLinkageSourceFact,
} from '@mercaria/shared-types';

/** The native store profile, projected to the fields a diff can be about. */
export interface DiffStoreProfile {
  id: string;
  name: string;
  description: string | null;
}

/** The canonical merchant, same projection. */
export interface DiffMerchantProfile {
  id: string;
  name: string;
  description: string | null;
}

/**
 * What linkage does not touch, named one by one (issue existing-store rules 4
 * and 7, revocation rule 3).
 *
 * Spelled out rather than summarised as "operational data", because the value of
 * the promise is in its specificity: a merchant reading "your orders do not
 * move" has been told something checkable, and a merchant reading "we only
 * change identity" has not.
 */
export const LINKAGE_UNCHANGED: readonly string[] = [
  'store handle and its /m/<handle> route',
  'the store follow target',
  'store members and their permissions',
  'store policies, notification and tax settings',
  'collections',
  'inventory and locations',
  'customers',
  'placed orders and their history',
  'reports',
  'the store default currency',
];

/**
 * The two-sided comparison for one adoptable field.
 *
 * `adoptable` is false when the canonical side has nothing to give: an empty
 * merchant description is an absence, and offering to adopt it would be offering
 * to clear the store's own — a destructive act wearing an identity act's
 * clothes.
 */
function diffField(
  field: StoreLinkageProfileField,
  storeValue: string | null,
  merchantValue: string | null,
): StoreLinkageDiffField {
  const normalizedMerchant = merchantValue?.trim() ?? '';
  const normalizedStore = storeValue?.trim() ?? '';
  return {
    field,
    storeValue,
    merchantValue,
    differs: normalizedStore !== normalizedMerchant,
    adoptable: normalizedMerchant !== '' && normalizedStore !== normalizedMerchant,
  };
}

/**
 * Build the diff. Pure: everything it reads is a parameter, so it can be tested
 * without a database and cannot acquire a side effect by accident.
 */
export function buildLinkageDiff(input: {
  store: DiffStoreProfile;
  merchant: DiffMerchantProfile;
  /** Hostnames the merchant holds VERIFIED. Observations are not shown. */
  verifiedDomains: readonly string[];
  storefronts: readonly { id: string; name: string; domain: string | null }[];
  impact: StoreLinkageImpact;
}): StoreLinkageDiff {
  const values: Record<StoreLinkageProfileField, [string | null, string | null]> = {
    name: [input.store.name, input.merchant.name],
    description: [input.store.description, input.merchant.description],
  };

  const sourceFacts: StoreLinkageSourceFact[] = [
    ...input.verifiedDomains.map(
      (domain): StoreLinkageSourceFact => ({
        kind: 'verified_domain',
        ref: domain,
        detail: null,
      }),
    ),
    ...input.storefronts.map(
      (storefront): StoreLinkageSourceFact => ({
        kind: 'storefront',
        ref: storefront.id,
        detail: storefront.domain,
      }),
    ),
  ];

  return {
    storeId: input.store.id,
    merchantId: input.merchant.id,
    // Iterating the TUPLE rather than the record's keys is what makes adding a
    // field to `STORE_LINKAGE_PROFILE_FIELDS` a compile error here (the record
    // would no longer be total) instead of a field silently missing from every
    // diff.
    fields: STORE_LINKAGE_PROFILE_FIELDS.map((field) => {
      const [storeValue, merchantValue] = values[field];
      return diffField(field, storeValue, merchantValue);
    }),
    sourceFacts,
    unchanged: LINKAGE_UNCHANGED,
    impact: input.impact,
  };
}

/**
 * The store-column patch for the fields an owner chose to adopt.
 *
 * Returns the patch AND the previous values, because the two are one decision:
 * the adoption row records what it overwrote, and a caller that computed the
 * patch without the before-state would have to read the store twice and could
 * read a different version the second time.
 *
 * A field the owner selected that is not `adoptable` is DROPPED rather than
 * applied — the diff is the authority on what may be taken, and a client
 * replaying a stale selection must not be able to clear a store's description
 * with it.
 */
export function planProfileAdoption(input: {
  diff: StoreLinkageDiff;
  selected: readonly StoreLinkageProfileField[];
}): { field: StoreLinkageProfileField; previousValue: string | null; adoptedValue: string }[] {
  const chosen = new Set(input.selected);
  const plan: {
    field: StoreLinkageProfileField;
    previousValue: string | null;
    adoptedValue: string;
  }[] = [];

  for (const field of input.diff.fields) {
    if (!chosen.has(field.field) || !field.adoptable) continue;
    const adoptedValue = field.merchantValue?.trim();
    // `adoptable` already implies a non-empty merchant value; the guard is what
    // narrows the type without a non-null assertion, and it costs nothing.
    if (adoptedValue === undefined || adoptedValue === '') continue;
    plan.push({ field: field.field, previousValue: field.storeValue, adoptedValue });
  }

  return plan;
}
