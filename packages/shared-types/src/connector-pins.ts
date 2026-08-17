/**
 * The connector field-pin VOCABULARY, and the partition a surface renders it
 * through (#416/#419 wrote the pins, #420 makes them visible).
 *
 * `listings.overriddenFields` is a set of bare strings a merchant edit writes
 * and a connector re-sync reads. It reaches a client on the ADMIN hydration
 * path as `Listing.overriddenFields`, which makes these keys a WIRE vocabulary:
 * a dashboard has to turn them into sentences a merchant can act on, and it
 * cannot import the backend module that used to declare them. So they live
 * here, in the one package both sides already depend on, and there is exactly
 * one declaration of the seven.
 *
 * The KEYS are frozen; the sentences a merchant reads are not, and live in
 * `@mercaria/ui` (`lib/connector-labels.ts`) — the split every taxonomy in this
 * package uses, for the reason `./condition` states: a copy change must not be
 * able to touch a stored value.
 *
 * ## Why the surface has to say something at all
 *
 * A pin is written by an ordinary edit and removed by nothing, so its only
 * symptom is a field that silently stops tracking the platform — which is
 * indistinguishable from a broken sync. A merchant reporting "my Shopify title
 * change isn't arriving" and a merchant who pinned the title six weeks ago look
 * identical from every surface that does not render this set.
 */

/**
 * The connector-managed fields a merchant edit PINS against a later sync.
 *
 * Exactly the keys the connector's field merge consults on the path
 * `updateListing` feeds — `toUpdatePatch` in `connector-sync.service` (the pull)
 * and `toIngestPatch` in `channel-ingest.service` (the push-in twin). A pin
 * naming a key nothing reads would be a merchant control with no effect, which
 * is the defect #416 exists to fix rather than a second instance of it;
 * `catalog-field-pins.test.ts` scans both read sites and fails the build on
 * either direction of drift.
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
 *   merchant approved. #390 turned on this key and did NOT change the answer:
 *   it recorded `listings.archived_by` / `archived_from_status` instead, so the
 *   connector's republish reads what ARCHIVED the listing rather than what the
 *   merchant pinned.
 * - `price` — the key does not guard a field. `convergeVariants` returns early
 *   on it, so pinning a price also stops the platform's newly-added variants
 *   being created and its removed ones being unsold. A merchant adjusting one
 *   price has not asked for that, and store-product prices do not pass through
 *   `updateListing` at all (they go through `updateVariant`).
 * - `collections` — membership is edited through the collections surface, not
 *   through `updateListing`, so that funnel never sees the edit that would pin
 *   it.
 *
 * They are listed rather than omitted because `catalog-field-pins.test.ts`
 * asserts the two sets partition the read vocabulary EXACTLY: a key in neither
 * fails the build, so a fifth read site added later cannot quietly land on the
 * permissive side. A merchant surface must NOT offer them as pinnable — an
 * imported product's status is the one a merchant publishes by hand, and a UI
 * implying that act pinned it would be a new false promise.
 */
export const UNPINNED_CONNECTOR_KEYS = ['status', 'price', 'collections'] as const;

export type UnpinnedConnectorKey = (typeof UNPINNED_CONNECTOR_KEYS)[number];

/**
 * What one listing's stored pin set contains, split into what a surface can
 * name and what it cannot.
 *
 * Two lists rather than one filtered list, because dropping the second would
 * hide a real pin — and hiding a pin is the entire defect #420 exists to close.
 * The column is a bare `text[]`: `mergePins` never removes an entry, and a
 * fixture, a repair or a later issue can put a key in it that a merchant edit
 * would not. Such a key is still HELD by the merge, so it is counted and
 * reported as unnamed rather than silently discarded.
 */
export interface PinnedConnectorFields {
  /**
   * The pinned fields in {@link PINNABLE_CONNECTOR_FIELDS} order, deduplicated.
   *
   * Canonical order rather than stored order: the stored order is the sequence
   * a merchant happened to edit in, so two products with the same pins would
   * otherwise render two different lists.
   */
  pinned: PinnableConnectorField[];
  /**
   * Everything else in the set, sorted. Includes
   * {@link UNPINNED_CONNECTOR_KEYS} — those are held by the merge exactly as
   * the seven are; what makes them different is that no merchant EDIT writes
   * them, which is a statement about the writer and not about the reader.
   */
  unnamed: string[];
}

/**
 * Split a listing's `overriddenFields` into the nameable pins and the rest.
 *
 * Pure, and total over any string array — the DTO field is `string[]` and this
 * is what makes reading it safe. Absent and empty are one value: a listing with
 * no pins and a listing that was never connector-sourced both partition to two
 * empty lists, and a surface renders nothing for either.
 */
export function partitionPinnedFields(
  overriddenFields: readonly string[] | undefined,
): PinnedConnectorFields {
  const stored = new Set(overriddenFields ?? []);
  const nameable: readonly string[] = PINNABLE_CONNECTOR_FIELDS;
  return {
    pinned: PINNABLE_CONNECTOR_FIELDS.filter((field) => stored.has(field)),
    unnamed: [...stored].filter((key) => !nameable.includes(key)).sort(),
  };
}

/**
 * Stop holding one or more of a listing's pinned keys (#427).
 *
 * ## What a release CAN mean, and what it cannot
 *
 * Nothing stores the platform's previous per-field value. `overriddenFields`
 * records only WHICH keys were taken over; the title, description, gallery
 * order, vendor, product type, handle and SEO pair the platform last sent are
 * kept nowhere. So a release means exactly one thing — **the field resumes
 * tracking the platform from the next sync** — and it can never mean *restore
 * what it was*. The field keeps the merchant's current value until the platform
 * next sends one, which on a webhook-driven connection may not be until they
 * edit something upstream.
 *
 * Every surface that offers this has to say that, in those terms. A control
 * labelled "undo", "revert" or "restore", or anything with a before/after, is a
 * promise the data cannot keep, and it would fail the way this whole area keeps
 * failing: silently, looking exactly like a working feature.
 *
 * ## It is SUBTRACTIVE, which is what keeps `status` unpinnable
 *
 * The only operation is removal from the stored set — there is deliberately no
 * input that could ADD a key. So {@link UNPINNED_CONNECTOR_KEYS} stay outside
 * what a merchant edit writes however this endpoint is called: releasing
 * `status` is the platform getting a field BACK, which is the opposite
 * direction from the one #416 refused, and no sequence of releases can make a
 * fourth key pinnable.
 *
 * ## Any key, not only the seven this vocabulary names
 *
 * `fields` is `string[]` rather than `PinnableConnectorField[]` for the reason
 * {@link partitionPinnedFields} reports `unnamed` at all: the column is a bare
 * `text[]` that `mergePins` never removes from, and a fixture, a repair or a
 * later issue can leave a key in it that no merchant edit writes — held by the
 * connector's merge all the same. A release that could only reach the seven
 * named keys would leave those permanently stuck, which is worse than not
 * offering a release. Narrowing this to the union would be that bug, spelled as
 * a type.
 *
 * A key that is not held is not an error: it is removed from nothing, and the
 * request converges. That is what makes a retry, a double tap and two dashboards
 * releasing the same field all end in one state.
 */
export interface ReleaseConnectorPinsInput {
  /**
   * The `overriddenFields` keys to stop holding. Keys that are not held are
   * no-ops rather than failures.
   */
  fields: string[];
}
