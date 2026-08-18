/**
 * Moving a PUBLISHED listing to a newer product-type version — the twin of
 * `previewDraftUpgrade` / `applyDraftUpgrade`, one entity over (#587,
 * #367 box 12, ADR 0007 D10).
 *
 * ## The gap this closes, and what it was
 *
 * `listings.product_type_definition_id` had exactly one kind of writer: an
 * INSERT. `insertP2PListingWithin` pins NULL, `insertStoreProductWithin` writes
 * whatever `publishDraft` hands it, and no UPDATE statement anywhere in this
 * repository named the column. So a listing published under v1 stayed on v1
 * forever, and `catalog-governance/impact-plan.ts` recorded that honestly as
 * `rewire_path_missing` rather than claiming a rewire nothing performed.
 *
 * Migration 0109 anticipated this exact function:
 * `mercaria_listing_product_type_pin_not_cleared` permits `NULL → value` and
 * `value → value` and refuses only `value → NULL`, and says in so many words
 * that the second is permitted "precisely so #367 box 12's published-listing
 * migration has somewhere to land". The database was ready; nothing called it.
 *
 * ## NEVER silently rewrite — which is a fact about what this file does NOT do
 *
 * The preview is a separate REQUEST from the apply, on the same path with a
 * different verb, exactly as the draft upgrade is. And the apply writes ONE
 * COLUMN:
 *
 * - every `native_listing_attribute_claims` and `native_variant_attribute_claims`
 *   row keeps the attribute version it was settled under;
 * - every `native_listing_variant_axes` row keeps the product-type version that
 *   authorised it — which the database enforces anyway, since
 *   `mercaria_native_variant_axis_frozen` makes that citation immutable;
 * - a field the target version no longer declares becomes a `field_removed`
 *   line on the preview and `losesAnswers: true`, and NOTHING deletes the
 *   answer.
 *
 * That is `applyDraftUpgrade`'s ruling ported verbatim: deleting a stored answer
 * here would be the silent rewrite ADR 0007 D10 forbids, wearing a tidy-up's
 * clothes.
 *
 * ## Why the axis check REFUSES rather than repairing
 *
 * `mercaria_native_variant_axis_citation` refuses an axis row naming a product
 * type version that declares no `variant_capable`, `variant`-scope field for
 * that attribute. It fires on writes to the AXES table and never reads
 * `listings` — so moving the listing onto such a version reaches, through the
 * one door the trigger does not watch, exactly the state it exists to refuse.
 *
 * There is no repair available: the axis's cited version is immutable, and the
 * only way to re-cite one is to retire and re-declare it, which cascades every
 * `native_variant_axis_assignments` row away. So the choices are refuse or
 * destroy, and this file refuses — naming the attribute, so an operator knows
 * what the target version would have to declare.
 *
 * The trigger clause that would state the same rule at the row is named as owed
 * in `db/schema/variantAxes.ts` and `docs/variant-axes.md`; it is a migration
 * and this is not.
 *
 * ## Scope: ONE listing, by the store that owns it
 *
 * A bulk operator path over every listing pinned to a version is a governance
 * ACTION, and a governance action needs a `CATALOG_GOVERNANCE_ACTIONS` member,
 * which is CHECK-rendered onto two tables and therefore a migration. It is also
 * a policy decision nobody has made — the draft upgrade is store-scoped, and
 * "a merchant may re-pin their own draft but not their own listing" is not an
 * asymmetry to introduce as a side effect of where an endpoint lives.
 * `docs/catalog-authoring.md` records both.
 */

import type {
  AuthoringUpgradeChange,
  ListingProductTypeUpgradePreview,
  ListingProductTypeUpgradeResult,
  ListingUpgradeBlockerDetail,
  ProductTypeAuthoringFlow,
} from '@mercaria/shared-types';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import { findListingById, type ListingRecord } from '../../db/catalog/listingRepository.js';
import {
  findProductTypeDefinitionById,
  findPublishedProductTypeDefinition,
  type ProductTypeDefinitionRow,
} from '../../db/productTypes/productTypeRepository.js';
import { listProductTypeFields } from '../../db/productTypes/productTypeFieldRepository.js';
import { listAttributeKeysByIds } from '../../db/attributes/definitionRepository.js';
import { listListingAttributeClaims } from '../../db/variantAxes/attributeClaimRepository.js';
import { listVariantAxesForListing } from '../../db/variantAxes/variantAxisRepository.js';
import { repinListingProductTypeVersion } from '../catalog-write.service.js';
import { compareProductTypeVersionFields } from './version-upgrade.js';

/**
 * The flow a store listing's schema is read under.
 *
 * A CONSTANT and not an inference, because this whole surface is store-scoped:
 * `findStoreListing` refuses a listing another owner holds, and a store's
 * listing is authored through `/stores/:storeId/product-drafts`, which is the
 * merchant flow. A P2P listing cannot reach here twice over — it is owned by a
 * user, and `insertP2PListingWithin` pins NULL unconditionally, so it answers
 * `not_pinned` before any flow is needed.
 */
const STORE_LISTING_FLOW: ProductTypeAuthoringFlow = 'merchant';

/**
 * The statuses a pin may be moved on. See `listing_not_editable`.
 *
 * Stated POSITIVELY rather than as "not archived and not restricted", because
 * the two fail in opposite directions: a sixth status nobody classified is
 * REFUSED here and would have been PERMITTED by a deny-list. The three excluded
 * ones each have their own reason and none of them is tidiness:
 *
 * - `restricted` — a jury acted on this listing. Moving its pin is an edit, and
 *   `catalog-write.service.updateListing` refuses to edit a restricted listing
 *   at all; reaching one through a different function is the moderation escape
 *   that rule exists to close.
 * - `archived` — soft-deleted. `archiveListing` refuses to archive a restricted
 *   listing precisely because a cleared status laundered a decision, and moving
 *   a schema pin on a deleted row is work with no reader.
 * - `sold` — a completed sale, and the record IS the history. ADR 0007 D5's
 *   whole posture is that a newer version never reinterprets an older record;
 *   the deliberate exception this file exists for is a listing somebody is still
 *   selling or still editing, and a sold one has no future edit to benefit.
 */
const UPGRADABLE_LISTING_STATUSES: readonly ListingRecord['status'][] = ['draft', 'active'];

/**
 * One listing, refused unless this store owns it.
 *
 * 404 and never 403 — the tenant gate answers the same way for "no such
 * listing" and "somebody else's listing", because a distinguishable answer is
 * an oracle enumerating another merchant's catalogue. The #63 feed-importer
 * ruling, and #92's.
 */
async function findStoreListing(
  db: DatabaseOrTransaction,
  storeId: string,
  listingId: string,
): Promise<ListingRecord> {
  const listing = await findListingById(listingId, db);
  if (listing === null || listing.storeId !== storeId) throw notFound('No such listing.');
  return listing;
}

/** The attribute keys this listing has actually recorded something under. */
async function answeredAttributeKeys(
  db: DatabaseOrTransaction,
  listingId: string,
): Promise<Set<string>> {
  const [claims, axes] = await Promise.all([
    listListingAttributeClaims(db, listingId),
    listVariantAxesForListing(db, listingId),
  ]);

  // A claim names its raw text and the definition it RESOLVED to; the stable key
  // is the definition's, never the raw name — a connector's claim carries the
  // source's own words there, and comparing those against a product-type field
  // would report every ingested answer as belonging to no field at all.
  const resolvedIds = claims
    .map((claim) => claim.attributeDefinitionId)
    .filter((id): id is string => id !== null);
  const keysById = await listAttributeKeysByIds(db, [...new Set(resolvedIds)]);

  const answered = new Set<string>();
  for (const id of resolvedIds) {
    const key = keysById.get(id);
    if (key !== undefined) answered.add(key);
  }
  // An axis carries its key directly, kept in step with the registry by
  // `mercaria_native_variant_axis_citation`.
  for (const axis of axes) answered.add(axis.attributeKey);
  return answered;
}

/**
 * Every reason this listing may not move onto `target`.
 *
 * Returns a LIST rather than the first one: an operator fixing them one refusal
 * at a time is an operator making several attempts to learn what a single read
 * already knows.
 */
async function blockersFor(
  db: DatabaseOrTransaction,
  listing: ListingRecord,
  target: ProductTypeDefinitionRow,
): Promise<ListingUpgradeBlockerDetail[]> {
  const blockers: ListingUpgradeBlockerDetail[] = [];

  if (!UPGRADABLE_LISTING_STATUSES.includes(listing.status)) {
    blockers.push({
      blocker: 'listing_not_editable',
      detail: `This listing is ${listing.status}, and moving its schema version is an edit. Resolve that first.`,
    });
  }

  // The citation trigger's own predicate, at the listing grain. `variant` scope
  // AND `variant_capable`, both, because that is what the trigger requires — a
  // variant-scope field that is not `variant_capable` does not authorise an axis
  // either.
  const axes = await listVariantAxesForListing(db, listing.id);
  if (axes.length > 0) {
    const targetFields = await listProductTypeFields(db, target.id, STORE_LISTING_FLOW);
    const authorised = new Set(
      targetFields
        .filter((field) => field.scope === 'variant' && field.variantCapable === true)
        .map((field) => field.attributeKey),
    );
    for (const axis of axes) {
      if (authorised.has(axis.attributeKey)) continue;
      blockers.push({
        blocker: 'variant_axis_not_authorised',
        attributeKey: axis.attributeKey,
        detail:
          `Version ${String(target.version)} declares no variant-capable "${axis.attributeKey}" field, ` +
          'so it could not have authorised this listing\'s axis. Moving the listing onto it would ' +
          'reach a state the database refuses when an axis is written, and the axis cannot follow — ' +
          'its cited version is frozen, and re-declaring it would discard every assignment.',
      });
    }
  }

  return blockers;
}

/** The two versions' field comparison for this listing's flow. */
async function changesBetween(
  db: DatabaseOrTransaction,
  listingId: string,
  current: ProductTypeDefinitionRow,
  target: ProductTypeDefinitionRow,
): Promise<{ changes: readonly AuthoringUpgradeChange[]; losesAnswers: boolean }> {
  const [currentFields, targetFields, answered] = await Promise.all([
    listProductTypeFields(db, current.id, STORE_LISTING_FLOW),
    listProductTypeFields(db, target.id, STORE_LISTING_FLOW),
    answeredAttributeKeys(db, listingId),
  ]);
  // The SAME comparison `previewDraftUpgrade` runs, called rather than copied.
  return compareProductTypeVersionFields(currentFields, targetFields, answered);
}

/**
 * What moving this listing to the currently published version would do.
 *
 * A DESCRIPTION and nothing else. It writes nothing, and there is no parameter
 * it could be handed that would make it write.
 */
export async function previewListingProductTypeUpgrade(
  db: DatabaseOrTransaction,
  storeId: string,
  listingId: string,
): Promise<ListingProductTypeUpgradePreview> {
  const listing = await findStoreListing(db, storeId, listingId);
  if (listing.productTypeDefinitionId === null) return { outcome: 'not_pinned' };

  const current = await findProductTypeDefinitionById(db, listing.productTypeDefinitionId);
  if (current === null) {
    throw notFound('The product type version this listing pins no longer exists.');
  }

  const published = await findPublishedProductTypeDefinition(db, current.key);
  // No published version at all, or the listing is already on it. Both are
  // "there is nothing to move to", and reporting them differently would invite a
  // client to render an upgrade for a key whose schema is entirely deprecated.
  if (published === null || published.id === current.id) {
    return { outcome: 'up_to_date', currentVersion: current.version };
  }

  const { changes, losesAnswers } = await changesBetween(db, listing.id, current, published);
  const blockers = await blockersFor(db, listing, published);
  if (blockers.length > 0) {
    return {
      outcome: 'blocked',
      currentVersion: current.version,
      targetVersion: published.version,
      changes,
      blockers,
    };
  }

  return {
    outcome: 'upgrade_available',
    currentVersion: current.version,
    targetVersion: published.version,
    targetDefinitionId: published.id,
    changes,
    losesAnswers,
  };
}

/**
 * Move the listing, after somebody saw the preview.
 *
 * Every guard the preview applies is re-applied here against the rows as they
 * stand, and the target is re-resolved rather than trusted: a preview is a
 * measurement at a moment, and the client's `targetDefinitionId` is a claim
 * about what it saw. What the parameter DOES is state which version the caller
 * was shown — a mismatch is answered rather than silently honoured, so an
 * operator cannot apply an upgrade to a version that was published while they
 * were reading.
 */
export async function applyListingProductTypeUpgrade(
  db: Database,
  input: {
    readonly storeId: string;
    readonly listingId: string;
    readonly targetDefinitionId: string;
  },
): Promise<ListingProductTypeUpgradeResult> {
  return db.transaction(async (tx) => {
    const listing = await findStoreListing(tx, input.storeId, input.listingId);
    if (listing.productTypeDefinitionId === null) {
      throw conflict(
        'This listing is pinned to no product type version, so there is nothing to move forward.',
      );
    }

    const current = await findProductTypeDefinitionById(tx, listing.productTypeDefinitionId);
    if (current === null) {
      throw notFound('The product type version this listing pins no longer exists.');
    }

    const published = await findPublishedProductTypeDefinition(tx, current.key);
    if (published === null || published.id === current.id) {
      throw conflict(
        `${current.key} v${String(current.version)} is the published version, so this listing is already current.`,
      );
    }
    if (published.id !== input.targetDefinitionId) {
      // Named rather than absorbed: the operator approved a specific version's
      // changes, and applying a different one would be this surface deciding
      // something nobody looked at.
      throw conflict(
        `${current.key} moved on while you were reading: version ${String(published.version)} is published now. Re-read the preview.`,
      );
    }

    const blockers = await blockersFor(tx, listing, published);
    if (blockers.length > 0) {
      throw conflict(blockers.map((entry) => entry.detail).join(' '));
    }

    const moved = await repinListingProductTypeVersion(
      tx,
      listing.id,
      current.id,
      published.id,
    );
    if (moved === null) {
      throw conflict('This listing was moved by somebody else while you were reading it.');
    }

    return {
      listingId: listing.id,
      fromDefinitionId: current.id,
      fromVersion: current.version,
      toDefinitionId: published.id,
      toVersion: published.version,
    };
  });
}
