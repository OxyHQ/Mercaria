/**
 * Which merchant edits PIN a field against a connector re-sync (#416).
 *
 * `listings.overriddenFields` has always been read — four production sites
 * consult it to decide whether a connector may overwrite a merchant's work —
 * and was never written with anything but `[]`. So the dashboard's
 * "Keep my local edits" switch had both positions behaving identically: the set
 * it selects between was empty either way. This module is the write side.
 *
 * ## The vocabulary is the READ side's, not a new one
 *
 * {@link PINNABLE_CONNECTOR_FIELDS} is exactly the set of keys the connector's
 * field merge consults on the path `updateListing` feeds — `toUpdatePatch` in
 * `connector-sync.service` (the pull) and `toIngestPatch` in
 * `channel-ingest.service` (the push-in twin). A pin naming a key nothing reads
 * would be a merchant control with no effect, which is the defect this fixes
 * rather than a second instance of it; `catalog-field-pins.test.ts` scans both
 * read sites and fails the build on either direction of drift.
 *
 * {@link UNPINNED_CONNECTOR_KEYS} names the three keys the read side ALSO
 * consults and that a merchant edit deliberately does not write. They are listed
 * rather than omitted because the gate asserts the two sets partition the read
 * vocabulary EXACTLY: a key that is in neither fails the build, so a fifth read
 * site added later cannot quietly land on the permissive side.
 *
 * ## A pin is a CHANGE, never a mention
 *
 * The dashboard's product screen sends `{title, description, status}` on every
 * save whether or not any of them moved, so pinning on a field's PRESENCE in the
 * patch would pin the title and description of every imported product the first
 * time a merchant touched its status — indistinguishable from "pin everything",
 * and arrived at by a merchant who changed one dropdown. {@link pinnedByEdit}
 * therefore compares against the stored value, which is also what the switch's
 * own copy promises: "a field you edited in Mercaria".
 *
 * NULL and empty string are the same value here. A merchant clearing a vendor
 * the platform never sent has changed nothing a reader could see, and treating
 * that as an edit would pin a field over a no-op.
 */

import type { UpdateListingInput } from '@mercaria/shared-types';

/**
 * The connector-managed fields a merchant edit pins.
 *
 * These are `overriddenFields` KEYS, not `UpdateListingInput` keys — the two
 * differ for images (`imageFileIds` on the wire, `images` in the pin set)
 * because the pin vocabulary belongs to the reader.
 */
export const PINNABLE_CONNECTOR_FIELDS = [
  'title',
  'description',
  'images',
  'vendor',
  'productType',
  'handle',
  'seo',
] as const;

export type PinnableConnectorField = (typeof PINNABLE_CONNECTOR_FIELDS)[number];

/**
 * Keys the connector's merge consults that a merchant edit does NOT pin, each
 * for a reason that is about the key rather than about the effort.
 *
 * - `status` — an imported product lands as a `draft` when the connection does
 *   not auto-publish, and the merchant reviewing it and setting `active` is the
 *   INTENDED workflow, not a decision to take the field over. Pinning there
 *   would make the ordinary act of publishing the thing that stops the platform
 *   ever unpublishing or archiving it again, on the very first product a
 *   merchant approved. #390 turns on this key and is a different decision about
 *   what a connector should do on republish; it is not answered here.
 * - `price` — the key does not guard a field. `convergeVariants` returns early
 *   on it, so pinning a price also stops the platform's newly-added variants
 *   being created and its removed ones being unsold. A merchant adjusting one
 *   price has not asked for that, and store-product prices do not pass through
 *   `updateListing` at all (they go through `updateVariant`), so the funnel this
 *   module hangs off could only ever pin a P2P listing's price — and a P2P
 *   listing is never connector-sourced.
 * - `collections` — membership is edited through the collections surface, not
 *   through `updateListing`, so this funnel never sees the edit that would pin
 *   it.
 */
export const UNPINNED_CONNECTOR_KEYS = ['status', 'price', 'collections'] as const;

/**
 * The stored values {@link pinnedByEdit} compares a patch against.
 *
 * `imageFileIds` is passed in rather than read off the listing row because the
 * gallery lives in a child table; the caller already has to decide whether that
 * read is worth making.
 */
export interface PinnableListingBefore {
  readonly title: string;
  readonly description: string;
  readonly vendor: string | null;
  readonly productType: string | null;
  readonly handle: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly imageFileIds: readonly string[];
}

/** NULL, absent and empty string are one value — see the module note. */
function same(before: string | null | undefined, after: string | null | undefined): boolean {
  return (before ?? '') === (after ?? '');
}

/** Order is part of an image gallery's meaning, so this is not a set comparison. */
function sameGallery(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((fileId, i) => fileId === after[i]);
}

/**
 * The pinnable fields this patch actually CHANGES, in
 * {@link PINNABLE_CONNECTOR_FIELDS} order.
 *
 * Pure: it decides nothing about whether the pins apply — that is the caller's,
 * because it depends on who is editing and whether the listing has a source at
 * all.
 */
export function pinnedByEdit(
  before: PinnableListingBefore,
  patch: UpdateListingInput,
): PinnableConnectorField[] {
  const pinned: PinnableConnectorField[] = [];

  if (patch.title !== undefined && !same(before.title, patch.title)) {
    pinned.push('title');
  }
  if (patch.description !== undefined && !same(before.description, patch.description)) {
    pinned.push('description');
  }
  if (patch.imageFileIds !== undefined && !sameGallery(before.imageFileIds, patch.imageFileIds)) {
    pinned.push('images');
  }
  if (patch.vendor !== undefined && !same(before.vendor, patch.vendor)) {
    pinned.push('vendor');
  }
  if (patch.productType !== undefined && !same(before.productType, patch.productType)) {
    pinned.push('productType');
  }
  if (patch.handle !== undefined && !same(before.handle, patch.handle)) {
    pinned.push('handle');
  }
  // One key covers both columns: the connector writes `seo` whole, so pinning
  // half of it would leave the other half tracking the platform and no key able
  // to say so.
  if (
    patch.seo !== undefined &&
    !(same(before.seoTitle, patch.seo.title) && same(before.seoDescription, patch.seo.description))
  ) {
    pinned.push('seo');
  }

  return pinned;
}

/**
 * The listing's next pin set, or `undefined` when this edit adds nothing.
 *
 * `undefined` rather than an unchanged array so the caller can leave the column
 * out of the UPDATE entirely: an edit that re-saves a title unchanged should not
 * write a row version.
 *
 * Existing entries keep their order and are never dropped. Removing a pin is not
 * this function's to do — see the unpinning note on `updateListing`.
 */
export function mergePins(
  existing: readonly string[],
  pinned: readonly PinnableConnectorField[],
): string[] | undefined {
  const added = pinned.filter((field) => !existing.includes(field));
  return added.length > 0 ? [...existing, ...added] : undefined;
}
