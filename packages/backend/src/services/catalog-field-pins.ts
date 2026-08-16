/**
 * Which merchant edits PIN a field against a connector re-sync (#416).
 *
 * `listings.overriddenFields` has always been read — four production sites
 * consult it to decide whether a connector may overwrite a merchant's work —
 * and was never written with anything but `[]`. So the dashboard's
 * "Keep my local edits" switch had both positions behaving identically: the set
 * it selects between was empty either way. This module is the write side.
 *
 * ## The vocabulary is the READ side's, and it lives in `@mercaria/shared-types`
 *
 * `PINNABLE_CONNECTOR_FIELDS` and `UNPINNED_CONNECTOR_KEYS` are declared in
 * `@mercaria/shared-types` (`connector-pins.ts`), with the argument for each
 * exclusion at the declaration. They moved there when #420 gave the dashboard a
 * surface that has to turn one of these keys into a sentence: `Listing.overriddenFields`
 * puts them on the wire, a client cannot import a service module, and two
 * declarations of one vocabulary can disagree. Nothing about what they MEAN
 * moved — `catalog-field-pins.test.ts` still scans both connector read sites and
 * fails the build on either direction of drift.
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

import type { PinnableConnectorField, UpdateListingInput } from '@mercaria/shared-types';

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
 * `PINNABLE_CONNECTOR_FIELDS` order.
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
