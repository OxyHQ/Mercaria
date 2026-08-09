/**
 * Composing the condition a client sees (#90), including the v1 compatibility
 * projection.
 *
 * Pure: rows in, DTO out, no database and no clock. Everything the shape needs
 * is either stored or derived from the shared tuples, so a projection cannot
 * disagree with the CHECK that admitted the row.
 *
 * ## Why the legacy field is computed here and not stored
 *
 * `Listing.condition` is a `LegacyBinaryCondition` derived from
 * `itemCondition.key` on every read. Two columns holding one fact can disagree,
 * and the place that must not happen is a v1 client's filter — a listing stored
 * as `for_parts` whose cached binary copy still said `new` would appear in a
 * "brand new" list on an app nobody can update. Deriving it makes that
 * unrepresentable, and costs one map lookup.
 */

import { CONDITION_KEY_GROUP, legacyBinaryConditionFor } from '@mercaria/shared-types';
import type {
  ConditionDetailDTO,
  ConditionPhotoDTO,
  ItemConditionDTO,
  ItemConditionKey,
  LegacyBinaryCondition,
} from '@mercaria/shared-types';
import { UNREFINED_CONDITION_ASSERTIONS } from '@mercaria/shared-types';
import type {
  ConditionDetailRecord,
  ConditionPhotoRecord,
} from '../../db/condition/conditionRepository.js';
import type { ListingRecord } from '../../db/catalog/listingRepository.js';

/**
 * A listing's condition as stored, narrowed to what the projection reads.
 *
 * The `condition` column is typed with the TRANSITIONAL value set while the
 * two-phase migration is in flight, so this takes the key as an
 * `ItemConditionKey` and the caller does the narrowing once — see
 * {@link narrowStoredCondition}.
 */
export interface StoredCondition {
  key: ItemConditionKey;
  assertion: ListingRecord['conditionAssertion'];
  sourceLabel: string | null;
  acknowledgedAt: Date | null;
}

/**
 * Narrow a stored condition value to a taxonomy key.
 *
 * The column's TypeScript type carries the transitional `'used'` until migration
 * #90's `post` migration narrows the CHECK and the tuple loses it. Every row is
 * backfilled by the `pre` half, so a `'used'` here can only mean a write from
 * the previous image during the rollout window — and the honest reading of it is the same one the
 * backfill applied, from the same shared map, rather than a cast.
 *
 * This function is the ONLY place that translation happens, and it disappears
 * with the transitional tuple.
 */
export function narrowStoredCondition(stored: ItemConditionKey | 'used'): ItemConditionKey {
  // A union parameter rather than `string` plus a cast: the legacy value is the
  // ONE extra inhabitant this can see, saying so lets the compiler narrow the
  // return, and the day the union loses `'used'` every caller keeps compiling
  // while this function becomes the identity it should be.
  return stored === 'used' ? 'used_good' : stored;
}

/** One structured detail, projected. */
export function projectConditionDetail(row: ConditionDetailRecord): ConditionDetailDTO {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.severity ? { severity: row.severity } : {}),
    ...(row.note ? { note: row.note } : {}),
  };
}

/**
 * One evidence photo, projected.
 *
 * `uploadedByOxyUserId` is deliberately NOT carried. The ownership fact is what
 * the gate reads server-side; a public DTO naming which account uploaded a photo
 * on a store listing would disclose staff membership, and on a P2P listing it is
 * the seller, who is already named.
 */
export function projectConditionPhoto(row: ConditionPhotoRecord): ConditionPhotoDTO {
  return {
    id: row.id,
    fileId: row.fileId,
    provenance: row.provenance,
    moderationState: row.moderationState,
    uploadedAt: row.uploadedAt.toISOString(),
    showsDefect: row.showsDefect,
    ...(row.conditionDetailId ? { conditionDetailId: row.conditionDetailId } : {}),
  };
}

/**
 * The authoritative condition DTO.
 *
 * `refined` is DERIVED from the assertion rather than stored beside it — the
 * one-verdict rule. It is what a "describe your item properly" prompt reads
 * (#90 migration rule 4), and a stored flag would go stale the moment a seller
 * refined the listing without whatever job maintained it noticing.
 */
export function projectItemCondition(
  stored: StoredCondition,
  details: readonly ConditionDetailRecord[],
  photos: readonly ConditionPhotoRecord[],
): ItemConditionDTO {
  return {
    key: stored.key,
    group: CONDITION_KEY_GROUP[stored.key],
    assertion: stored.assertion,
    refined: !UNREFINED_CONDITION_ASSERTIONS.includes(stored.assertion),
    ...(stored.sourceLabel ? { sourceLabel: stored.sourceLabel } : {}),
    ...(stored.acknowledgedAt ? { acknowledgedAt: stored.acknowledgedAt.toISOString() } : {}),
    details: details.map(projectConditionDetail),
    photos: photos.map(projectConditionPhoto),
  };
}

/**
 * The v1 binary field — the compatibility projection (#90 propagation rule 8).
 *
 * A one-line wrapper over the shared derivation, and it exists so every call
 * site in this backend reads the same name and a grep for the contract finds
 * them all when `LEGACY_CONDITION_CONTRACT.retiresWhen` is finally met.
 */
export function projectLegacyCondition(key: ItemConditionKey): LegacyBinaryCondition {
  return legacyBinaryConditionFor(key);
}

/**
 * The condition notes an order line snapshots, flattened from the disclosures.
 *
 * One string rather than a copy of the detail rows, because an order line is a
 * RECEIPT: it needs to say what the buyer was told, in a form a refund screen
 * and a dispute pack can both render, and a normalized child table of a
 * historical snapshot would need its own immutability rules to be worth having.
 *
 * `undefined` when there is nothing disclosed, so the column stays NULL and the
 * `order_items_condition_notes_check` CHECK sees an absence rather than `''`.
 */
export function flattenConditionNotes(
  details: readonly ConditionDetailRecord[],
): string | undefined {
  const lines = details
    .map((detail) => {
      const severity = detail.severity ? ` (${detail.severity})` : '';
      const note = detail.note ? `: ${detail.note}` : '';
      return `${detail.kind}${severity}${note}`;
    })
    .filter((line) => line.length > 0);

  return lines.length > 0 ? lines.join('; ') : undefined;
}
