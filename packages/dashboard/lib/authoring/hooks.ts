/**
 * React Query bindings for the catalog-authoring surface (#367 step 10).
 *
 * Queries only hold what the server sent. Nothing here derives a rule, a field
 * list or a default from a category — the composed `AuthoringSchema` is the
 * answer and this file transports it.
 *
 * ## Availability is PROBED, never configured
 *
 * `useAuthoringAvailability` asks the server the cheapest question it has and
 * reads a 404 as "this deployment has the surface switched off"
 * (`CATALOG_AUTHORING_ENABLED`, ADR 0007 D12). There is deliberately no
 * `EXPO_PUBLIC_` flag beside it: a client-side answer to "is the wizard
 * available" is a second representation of one fact, and the way two
 * representations disagree here is a merchant filling in a form whose publish
 * route does not exist. It is also what keeps the legacy `/products/new` in
 * place until a deployment turns the new surface on.
 *
 * A 404 is a stable answer about a deployment, so it is retried once and cached
 * for the session; a transport failure is not, and is rethrown so the screen
 * reports an error instead of quietly falling back.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AuthoringCanonicalSearchResult,
  AuthoringCategoryOption,
  AuthoringDraft,
  AuthoringDraftStatus,
  AuthoringProductTypeOption,
  AuthoringSchema,
  AuthoringUpgradePreview,
  AuthoringValidationResult,
} from "@mercaria/shared-types";
import { queryKeys } from "../queryKeys";
import {
  applyDraftUpgrade,
  createProductDraft,
  discardProductDraft,
  fetchAuthoringCategories,
  fetchAuthoringProductTypes,
  fetchAuthoringSchema,
  fetchProductDraft,
  listProductDrafts,
  patchProductDraft,
  previewDraftUpgrade,
  probeAuthoringAvailability,
  publishProductDraft,
  searchCanonicalCatalog,
  validateProductDraft,
  type AuthoringAvailability,
  type CreateDraftPayload,
  type DraftPublishOutcome,
  type DraftSaveOutcome,
  type PatchDraftPayload,
} from "./api";

/** The whole surface is off or on for a deployment; one probe answers it. */
export function useAuthoringAvailability(locale: string) {
  return useQuery<AuthoringAvailability>({
    queryKey: queryKeys.authoring.availability(locale),
    queryFn: () => probeAuthoringAvailability(locale),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * One level of the category tree.
 *
 * `parentId === null` asks for the roots. The two are different questions and
 * the server takes both, because a query string cannot carry a null.
 */
export function useAuthoringCategories(parentId: string | null, locale: string, enabled = true) {
  return useQuery<readonly AuthoringCategoryOption[]>({
    queryKey: queryKeys.authoring.categories(parentId, locale),
    queryFn: () =>
      fetchAuthoringCategories(
        parentId === null ? { roots: true, locale } : { parentId, locale },
      ),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAuthoringProductTypes(categoryId: string | null, locale: string) {
  return useQuery<readonly AuthoringProductTypeOption[]>({
    queryKey: queryKeys.authoring.productTypes(categoryId ?? "", locale),
    queryFn: () => fetchAuthoringProductTypes({ categoryId: categoryId ?? "", locale }),
    enabled: categoryId !== null,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * The composed schema for one product type, category, market and locale.
 *
 * Every one of those is in the key because every one of them is in the server's
 * own cache key and in the ETag: two locales that both fall back to English
 * produce identical bodies and must stay distinguishable, because the next
 * translation to land changes one and not the other.
 */
export function useAuthoringSchema(params: {
  productTypeKey: string | null;
  categoryId: string | null;
  market: string;
  locale: string;
  version?: number | null;
}) {
  const { productTypeKey, categoryId, market, locale } = params;
  const version = params.version ?? null;
  return useQuery<AuthoringSchema>({
    queryKey: queryKeys.authoring.schema(
      productTypeKey ?? "",
      categoryId ?? "",
      market,
      locale,
      version,
    ),
    queryFn: () =>
      fetchAuthoringSchema({
        productTypeKey: productTypeKey ?? "",
        categoryId: categoryId ?? "",
        market,
        locale,
        ...(version === null ? {} : { version }),
      }),
    enabled: productTypeKey !== null && categoryId !== null,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Search the canonical catalogue.
 *
 * The server floors `q` at two characters, and so does `enabled` here — a
 * one-character trigram query is a scan of the whole catalogue returning
 * whatever sorted first, which is a candidate list an author would be wrong to
 * trust.
 */
export function useCanonicalSearch(params: {
  query: string;
  kind?: "canonical_product" | "brand";
  canonicalProductId?: string | null;
}) {
  const kind = params.kind ?? "canonical_product";
  const canonicalProductId = params.canonicalProductId ?? null;
  const trimmed = params.query.trim();
  return useQuery<AuthoringCanonicalSearchResult>({
    queryKey: queryKeys.authoring.canonicalSearch(trimmed, kind, canonicalProductId),
    queryFn: () =>
      searchCanonicalCatalog({
        q: trimmed,
        kind,
        ...(canonicalProductId === null ? {} : { canonicalProductId }),
      }),
    enabled: trimmed.length >= 2,
  });
}

/**
 * The configurations one canonical product actually has.
 *
 * The same endpoint, on its `canonicalProductId` branch — which lists the
 * product's variants and IGNORES `q` entirely. The request schema still demands
 * `q`, so the product id is sent as it: a value the server does not read, and
 * the honest one to send, since it is what the request is about. Inventing a
 * search term would put a string in a log that reads like something somebody
 * typed.
 */
export function useCanonicalVariants(canonicalProductId: string | null) {
  return useQuery<AuthoringCanonicalSearchResult>({
    queryKey: queryKeys.authoring.canonicalSearch("", "canonical_variant", canonicalProductId),
    queryFn: () =>
      searchCanonicalCatalog({
        q: canonicalProductId ?? "",
        kind: "canonical_product",
        ...(canonicalProductId === null ? {} : { canonicalProductId }),
      }),
    enabled: canonicalProductId !== null && canonicalProductId.length >= 2,
    staleTime: 5 * 60 * 1000,
  });
}

/* -------------------------------------------------------------------------- */
/* Drafts                                                                      */
/* -------------------------------------------------------------------------- */

export function useProductDrafts(storeId: string, status: AuthoringDraftStatus = "open") {
  return useQuery<readonly AuthoringDraft[]>({
    queryKey: queryKeys.productDrafts.list(storeId, status),
    queryFn: () => listProductDrafts(storeId, { status }),
    enabled: storeId.length > 0,
  });
}

export function useProductDraft(storeId: string, draftId: string) {
  return useQuery<AuthoringDraft>({
    queryKey: queryKeys.productDrafts.detail(storeId, draftId),
    queryFn: () => fetchProductDraft(storeId, draftId),
    enabled: storeId.length > 0 && draftId.length > 0,
    // A draft is one author's private work in progress and the wizard holds the
    // authoritative copy in local state while it is open. Refetching on focus
    // would replace what somebody is typing with what was last saved.
    refetchOnWindowFocus: false,
  });
}

export function useCreateProductDraft(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation<AuthoringDraft, Error, CreateDraftPayload>({
    mutationFn: (payload) => createProductDraft(storeId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stores", storeId, "product-drafts"] });
    },
  });
}

export function useSaveProductDraft(storeId: string, draftId: string) {
  return useMutation<DraftSaveOutcome, Error, PatchDraftPayload>({
    mutationFn: (payload) => patchProductDraft(storeId, draftId, payload),
  });
}

export function useDiscardProductDraft(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation<AuthoringDraft, Error, { draftId: string; version: number }>({
    mutationFn: ({ draftId, version }) => discardProductDraft(storeId, draftId, version),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stores", storeId, "product-drafts"] });
    },
  });
}

export function useValidateProductDraft(storeId: string, draftId: string) {
  return useMutation<AuthoringValidationResult, Error, void>({
    mutationFn: () => validateProductDraft(storeId, draftId),
  });
}

export function useDraftUpgradePreview(storeId: string, draftId: string, enabled: boolean) {
  return useQuery<AuthoringUpgradePreview>({
    queryKey: queryKeys.productDrafts.upgrade(storeId, draftId),
    queryFn: () => previewDraftUpgrade(storeId, draftId),
    enabled: enabled && storeId.length > 0 && draftId.length > 0,
  });
}

export function useApplyDraftUpgrade(storeId: string, draftId: string) {
  const queryClient = useQueryClient();
  return useMutation<AuthoringDraft, Error, { version: number; targetDefinitionId: string }>({
    mutationFn: (payload) => applyDraftUpgrade(storeId, draftId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.productDrafts.detail(storeId, draftId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.productDrafts.upgrade(storeId, draftId) });
    },
  });
}

/**
 * Publish.
 *
 * The idempotency key is supplied by the caller and is stable for one publish
 * ATTEMPT, because a retry after a timeout has to converge on the listing the
 * first attempt may already have created. Minting one per request would make
 * the retry a second publication.
 */
export function usePublishProductDraft(storeId: string, draftId: string) {
  const queryClient = useQueryClient();
  return useMutation<DraftPublishOutcome, Error, { idempotencyKey: string }>({
    mutationFn: ({ idempotencyKey }) => publishProductDraft(storeId, draftId, idempotencyKey),
    onSuccess: (outcome) => {
      if (outcome.outcome !== "published") return;
      queryClient.invalidateQueries({ queryKey: ["stores", storeId, "products"] });
      queryClient.invalidateQueries({ queryKey: ["stores", storeId, "product-drafts"] });
    },
  });
}
