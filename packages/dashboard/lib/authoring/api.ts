/**
 * The catalog-authoring HTTP surface, as the dashboard calls it (#367 step 10).
 *
 * Thin transport only. Every shape here is a type `@mercaria/shared-types`
 * already owns, because the server composes the schema and this package
 * composes nothing (ADR 0007 D10). There is deliberately no local DTO that
 * mirrors an authoring type: a second spelling of `AuthoringField` is a second
 * answer to what a field is, and the two would diverge in the direction that
 * flatters whoever edited last.
 *
 * ## The two calls that do NOT throw on a refusal
 *
 * `publishProductDraft` and `patchProductDraft` answer a discriminated union
 * instead of rejecting, because their refusals are things an author acts on
 * rather than faults:
 *
 * - a refused publish is a 422 carrying the same `AuthoringValidationResult`
 *   the validate route returns, and the surface renders one list for both;
 * - a refused patch is a 409 whose remedy is "re-read the draft", which is
 *   mechanical.
 *
 * Everything else rejects, and a rejection is an error the surface reports as
 * one.
 *
 * ## No `If-None-Match`
 *
 * The schema route answers a deterministic ETag and a `304`. This client does
 * not send a conditional request: React Query already holds the composed schema
 * for the life of the wizard, so the round trip a `304` saves is one this
 * surface does not make. The ETag still travels — it is `schema.etag`, which is
 * what a draft pins and what `schema_version_superseded` compares against, and
 * that use has nothing to do with HTTP caching.
 */

import axios from "axios";
import type {
  AttributeComponentAxis,
  AuthoringCanonicalSearchResult,
  AuthoringCategoryOption,
  AuthoringDraft,
  AuthoringDraftStatus,
  AuthoringProductTypeOption,
  AuthoringSchema,
  AuthoringUpgradePreview,
  AuthoringValidationResult,
  CurrencyCode,
  ProductTypeAuthoringFlow,
} from "@mercaria/shared-types";
import apiClient from "../api/client";
import { unwrap } from "../api/unwrap";

/* -------------------------------------------------------------------------- */
/* Request shapes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One answer, in the ONE shape the server's `.strict()` schema admits.
 *
 * Exactly one value member is populated. Nothing here can carry a label: an
 * `enumValueId` is a row id, an `attributeKey` is a stable machine key, and
 * there is no property a translated string could legitimately be put in
 * (ADR 0007 D1 rule 3).
 */
export interface DraftAnswerPayload {
  readonly ordinal?: number;
  /**
   * IMPORTED, never restated.
   *
   * This was an inline literal union spelling out the five axes, which is a
   * SECOND representation of a closed value set the registry already owns — and
   * the two agreed only by coincidence. #367's apparel widening is what found
   * it, but the dangerous direction is the other one: a member REMOVED upstream
   * would leave this union still claiming it is sendable, and the request would
   * fail its `.strict()` schema at the server with a type-clean client.
   */
  readonly componentAxis?: AttributeComponentAxis;
  readonly text?: string;
  readonly number?: number;
  readonly boolean?: boolean;
  readonly enumValueId?: string;
  readonly canonicalRef?: {
    readonly kind: "canonical_product" | "canonical_variant" | "canonical_product_family" | "brand";
    readonly id: string;
  };
  readonly unit?: string;
}

/** The answers for one field. An empty `values` CLEARS the field, deliberately. */
export interface DraftFieldPayload {
  readonly attributeKey: string;
  readonly values: readonly DraftAnswerPayload[];
}

/** One variant row, with its axis answers inline. */
export interface DraftVariantPayload {
  readonly title?: string;
  readonly sku?: string;
  readonly barcode?: string;
  readonly price?: { readonly amount: number; readonly currency: CurrencyCode };
  readonly compareAtPrice?: { readonly amount: number; readonly currency: CurrencyCode };
  readonly inventoryTracked?: boolean;
  readonly inventoryAvailable: number;
  readonly axes: readonly DraftFieldPayload[];
  readonly selectedCanonicalVariantId?: string | null;
}

/** `PATCH /stores/:storeId/product-drafts/:draftId`. */
export interface PatchDraftPayload {
  readonly version: number;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly imageFileIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly selectedCanonicalProductId?: string | null;
  readonly fields?: readonly DraftFieldPayload[];
  readonly variants?: readonly DraftVariantPayload[];
}

/** `POST /stores/:storeId/product-drafts`. */
export interface CreateDraftPayload {
  readonly categoryId: string;
  readonly productTypeKey: string;
  readonly version?: number;
  readonly flow?: ProductTypeAuthoringFlow;
  readonly locale?: string;
  readonly market: string;
  readonly title?: string;
  readonly description?: string;
}

/* -------------------------------------------------------------------------- */
/* Outcomes that are not faults                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a save did.
 *
 * A STRING discriminant on `outcome`, and the conflict branch carries no
 * `draft` — so a caller cannot render a saved draft it did not receive.
 */
export type DraftSaveOutcome =
  | { readonly outcome: "saved"; readonly draft: AuthoringDraft }
  | { readonly outcome: "conflict" };

/** What a publish did. The refused branch carries no listing id. */
export type DraftPublishOutcome =
  | { readonly outcome: "published"; readonly listingId: string; readonly draft: AuthoringDraft }
  | { readonly outcome: "refused"; readonly validation: AuthoringValidationResult };

/**
 * Whether the authoring surface is mounted on this deployment at all.
 *
 * `CATALOG_AUTHORING_ENABLED` gates the MOUNT server-side (ADR 0007 D12), so an
 * unconfigured deployment answers 404 to every route here. That 404 IS the
 * fact, and this client deliberately has no flag of its own beside it: a second
 * answer to "is the wizard available" is one that can disagree with the server,
 * and the way it disagrees is a merchant filling in a form whose publish route
 * does not exist.
 */
export type AuthoringAvailability =
  | { readonly outcome: "available"; readonly categories: readonly AuthoringCategoryOption[] }
  | { readonly outcome: "unavailable" };

/** The HTTP status of an axios rejection, or `null` for a transport failure. */
function statusOf(error: unknown): number | null {
  if (!axios.isAxiosError(error)) return null;
  return error.response?.status ?? null;
}

/**
 * The `AuthoringValidationResult` carried by a 422 body, or `null`.
 *
 * Read defensively because it crosses a network: a body that is not the shape
 * the controller documents is treated as a transport failure and rethrown by
 * the caller, never as an empty finding list — an empty list reads as
 * "everything is fine", which is the opposite of what a 422 means.
 */
function validationFromError(error: unknown): AuthoringValidationResult | null {
  if (!axios.isAxiosError(error)) return null;
  const body = error.response?.data as { data?: { validation?: AuthoringValidationResult } } | undefined;
  const validation = body?.data?.validation;
  if (validation === undefined || !Array.isArray(validation.findings)) return null;
  return validation;
}

/* -------------------------------------------------------------------------- */
/* The schema surface                                                          */
/* -------------------------------------------------------------------------- */

const AUTHORING = "/catalog-authoring";
const drafts = (storeId: string) => `/stores/${storeId}/product-drafts`;

/**
 * The selectable categories, one level at a time.
 *
 * `roots` and `parentId` are two different questions and the server takes both:
 * a query string cannot carry a null, so "the top level" needs its own word.
 */
export async function fetchAuthoringCategories(params: {
  parentId?: string;
  roots?: boolean;
  locale: string;
  limit?: number;
}): Promise<readonly AuthoringCategoryOption[]> {
  const { data } = await apiClient.get(`${AUTHORING}/categories`, {
    params: {
      ...(params.parentId === undefined ? {} : { parentId: params.parentId }),
      ...(params.roots === true ? { roots: "true" } : {}),
      locale: params.locale,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    },
  });
  return unwrap<{ categories: AuthoringCategoryOption[] }>(data).categories;
}

/**
 * Probe the surface with the cheapest read it has.
 *
 * A 404 means the deployment has the surface switched off; anything else is a
 * real failure and is rethrown, because reporting an outage as "unavailable"
 * would silently send every merchant back to the legacy form and nobody would
 * find out.
 */
export async function probeAuthoringAvailability(locale: string): Promise<AuthoringAvailability> {
  try {
    const categories = await fetchAuthoringCategories({ roots: true, locale });
    return { outcome: "available", categories };
  } catch (error) {
    if (statusOf(error) === 404) return { outcome: "unavailable" };
    throw error;
  }
}

export async function fetchAuthoringProductTypes(params: {
  categoryId: string;
  locale: string;
}): Promise<readonly AuthoringProductTypeOption[]> {
  const { data } = await apiClient.get(`${AUTHORING}/product-types`, { params });
  return unwrap<{ productTypes: AuthoringProductTypeOption[] }>(data).productTypes;
}

export async function fetchAuthoringSchema(params: {
  productTypeKey: string;
  categoryId: string;
  market: string;
  locale: string;
  version?: number;
  flow?: ProductTypeAuthoringFlow;
}): Promise<AuthoringSchema> {
  const { productTypeKey, ...query } = params;
  const { data } = await apiClient.get(
    `${AUTHORING}/schemas/${encodeURIComponent(productTypeKey)}`,
    { params: query },
  );
  return unwrap<{ schema: AuthoringSchema }>(data).schema;
}

export async function searchCanonicalCatalog(params: {
  q: string;
  kind?: "canonical_product" | "brand";
  canonicalProductId?: string;
  limit?: number;
}): Promise<AuthoringCanonicalSearchResult> {
  const { data } = await apiClient.get(`${AUTHORING}/canonical-search`, { params });
  return unwrap<AuthoringCanonicalSearchResult>(data);
}

/* -------------------------------------------------------------------------- */
/* Drafts                                                                      */
/* -------------------------------------------------------------------------- */

export async function listProductDrafts(
  storeId: string,
  params: { status?: AuthoringDraftStatus; limit?: number; offset?: number } = {},
): Promise<readonly AuthoringDraft[]> {
  const { data } = await apiClient.get(drafts(storeId), { params });
  return unwrap<{ drafts: AuthoringDraft[] }>(data).drafts;
}

export async function fetchProductDraft(storeId: string, draftId: string): Promise<AuthoringDraft> {
  const { data } = await apiClient.get(`${drafts(storeId)}/${draftId}`);
  return unwrap<{ draft: AuthoringDraft }>(data).draft;
}

export async function createProductDraft(
  storeId: string,
  payload: CreateDraftPayload,
): Promise<AuthoringDraft> {
  const { data } = await apiClient.post(drafts(storeId), payload);
  return unwrap<{ draft: AuthoringDraft }>(data).draft;
}

/**
 * Save. A 409 is the CAS refusing, and it is an outcome rather than a fault.
 *
 * The server's `version` is a compare-and-swap carrying the store, the id and
 * `status = 'open'` in one predicate, so a conflict means one of: another
 * device saved, this draft was published, or it was discarded. The surface
 * re-reads and tells the author which; nothing here guesses.
 */
export async function patchProductDraft(
  storeId: string,
  draftId: string,
  payload: PatchDraftPayload,
): Promise<DraftSaveOutcome> {
  try {
    const { data } = await apiClient.patch(`${drafts(storeId)}/${draftId}`, payload);
    return { outcome: "saved", draft: unwrap<{ draft: AuthoringDraft }>(data).draft };
  } catch (error) {
    if (statusOf(error) === 409) return { outcome: "conflict" };
    throw error;
  }
}

export async function discardProductDraft(
  storeId: string,
  draftId: string,
  version: number,
): Promise<AuthoringDraft> {
  const { data } = await apiClient.delete(`${drafts(storeId)}/${draftId}`, { params: { version } });
  return unwrap<{ draft: AuthoringDraft }>(data).draft;
}

export async function validateProductDraft(
  storeId: string,
  draftId: string,
): Promise<AuthoringValidationResult> {
  const { data } = await apiClient.post(`${drafts(storeId)}/${draftId}/validate`, {});
  return unwrap<{ validation: AuthoringValidationResult }>(data).validation;
}

export async function previewDraftUpgrade(
  storeId: string,
  draftId: string,
): Promise<AuthoringUpgradePreview> {
  const { data } = await apiClient.get(`${drafts(storeId)}/${draftId}/upgrade`);
  return unwrap<{ preview: AuthoringUpgradePreview }>(data).preview;
}

export async function applyDraftUpgrade(
  storeId: string,
  draftId: string,
  payload: { version: number; targetDefinitionId: string },
): Promise<AuthoringDraft> {
  const { data } = await apiClient.post(`${drafts(storeId)}/${draftId}/upgrade`, payload);
  return unwrap<{ draft: AuthoringDraft }>(data).draft;
}

/**
 * Publish, carrying an idempotency key.
 *
 * The key is the CALLER's and is stable for one publish attempt, because a
 * retry after a timeout has to converge on the listing the first attempt may
 * already have created. A key minted per request would make the retry a second
 * publication.
 */
export async function publishProductDraft(
  storeId: string,
  draftId: string,
  idempotencyKey: string,
): Promise<DraftPublishOutcome> {
  try {
    const { data } = await apiClient.post(
      `${drafts(storeId)}/${draftId}/publish`,
      {},
      { headers: { "Idempotency-Key": idempotencyKey } },
    );
    const body = unwrap<{ listingId: string; draft: AuthoringDraft }>(data);
    return { outcome: "published", listingId: body.listingId, draft: body.draft };
  } catch (error) {
    const validation = validationFromError(error);
    if (statusOf(error) === 422 && validation !== null) {
      return { outcome: "refused", validation };
    }
    throw error;
  }
}
