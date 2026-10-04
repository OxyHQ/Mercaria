/**
 * The location editor's commerce form ↔ Mercaria's publication (#93, ADR 0013)
 * — pure, so what is sent is tested without a renderer.
 *
 * Only Mercaria's own fields are here: which GoWay place, whether the location
 * offers collection and on what terms, and how fresh its stock claims are.
 * Where the location IS lives on the GoWay place.
 */

import type {
  LocationInventorySource,
  MerchantLocationPublication,
  PickupIdentityRequirement,
  UpsertLocationPublicationInput,
} from "@mercaria/shared-types";

/** The bounds the backend's CHECK holds the stock interval to, in seconds. */
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60;

/** The form, as text where a merchant types it. */
export interface PublicationDraft {
  pickupOffered: boolean;
  pickupInstructions: string;
  identityRequirement: PickupIdentityRequirement;
  inventorySource: LocationInventorySource;
  /**
   * In MINUTES, the unit a merchant thinks in. EMPTY for a location never
   * saved: the interval has no default anywhere in the stack (#68), so the form
   * does not invent one either.
   */
  stockIntervalMinutes: string;
  disclosesExactStock: boolean;
  lowStockThreshold: string;
}

export function publicationDraftOf(publication: MerchantLocationPublication | null): PublicationDraft {
  return {
    pickupOffered: publication?.pickupOffered ?? false,
    pickupInstructions: publication?.pickupInstructions ?? "",
    identityRequirement: publication?.identityRequirement ?? "collection_code",
    inventorySource: publication?.inventorySource ?? "manual",
    stockIntervalMinutes:
      publication === null ? "" : String(Math.round(publication.stockConfirmationIntervalSeconds / 60)),
    disclosesExactStock: publication?.disclosesExactStock ?? false,
    lowStockThreshold: String(publication?.lowStockThreshold ?? 3),
  };
}

/** The PUT body the form says, or the key of the first thing wrong. */
export function publicationInputOf(
  draft: PublicationDraft,
  goWayPlaceId: string | undefined,
): { ok: true; input: UpsertLocationPublicationInput } | { ok: false; errorKey: string } {
  if (goWayPlaceId === undefined || goWayPlaceId.trim() === "") {
    return { ok: false, errorKey: "settings.locations.editor.publication.placeRequired" };
  }
  const minutes = Number(draft.stockIntervalMinutes.trim());
  const seconds = Math.round(minutes * 60);
  if (
    draft.stockIntervalMinutes.trim() === "" ||
    !Number.isFinite(minutes) ||
    seconds < MIN_INTERVAL_SECONDS ||
    seconds > MAX_INTERVAL_SECONDS
  ) {
    return { ok: false, errorKey: "settings.locations.editor.publication.intervalInvalid" };
  }
  const threshold = Number(draft.lowStockThreshold.trim());
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 1000) {
    return { ok: false, errorKey: "settings.locations.editor.publication.thresholdInvalid" };
  }
  const instructions = draft.pickupInstructions.trim();
  return {
    ok: true,
    input: {
      goWayPlaceId: goWayPlaceId.trim(),
      pickupOffered: draft.pickupOffered,
      ...(instructions === "" ? {} : { pickupInstructions: instructions }),
      identityRequirement: draft.identityRequirement,
      inventorySource: draft.inventorySource,
      stockConfirmationIntervalSeconds: seconds,
      disclosesExactStock: draft.disclosesExactStock,
      lowStockThreshold: threshold,
    },
  };
}
