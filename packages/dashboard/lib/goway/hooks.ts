/**
 * GoWay, from the merchant dashboard — the ONE module that builds a GoWay client
 * and every hook that calls it (ADR 0013).
 *
 * A store's location is a GoWay place, and its name, address, hours, contact
 * and accessibility are edited THERE, by the merchant, with their own Oxy
 * session: user tokens are `aud=oxy-api` and not bound to one app, so GoWay
 * authorizes a dashboard call exactly as it would one from goway.to, against
 * the store's claim on the place. Mercaria's backend never writes to GoWay.
 *
 * The token is read from the Oxy SDK before EVERY request and never kept here —
 * the SDK's own `getAccessToken` contract — so a sign-out ends GoWay access in
 * the same instant it ends Mercaria's.
 */

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxy.so/services";
import {
  MAX_CLAIM_LIST_LIMIT,
  MAX_HOURS_EXCEPTION_LIST_LIMIT,
  createGoWayClient,
  type GoWayClient,
  type Place,
  type PlaceClaim,
  type PlaceClaimRole,
  type PlaceCreateInput,
  type PlaceHoursException,
  type PlaceHoursExceptionInput,
  type PlaceUpdateInput,
  type SearchResult,
} from "@goway.to/sdk";
import { GOWAY_API_URL } from "../config";
import { useTranslation } from "../i18n";
import { queryKeys } from "../queryKeys";
import { MERCARIA_STORE_CAPABILITY } from "./place-link";
import type { CapabilityOperation } from "./place-form";

/** How many search results the place picker shows. */
const SEARCH_LIMIT = 10;

/** The dashboard's GoWay client, signed in as whoever is signed in to the dashboard. */
export function useGoWayClient(): GoWayClient {
  const { oxyServices } = useOxy();
  const { locale } = useTranslation();
  return useMemo(
    () =>
      createGoWayClient({
        ...(GOWAY_API_URL === undefined ? {} : { apiBaseUrl: GOWAY_API_URL }),
        getAccessToken: () => oxyServices.session.accessToken || null,
        locale,
      }),
    [oxyServices, locale],
  );
}

/** One GoWay place, with its names and its hours exceptions. */
export function useGoWayPlace(placeId: string | undefined) {
  const client = useGoWayClient();
  const { locale } = useTranslation();
  return useQuery<Place>({
    queryKey: queryKeys.goway.place(placeId ?? "", locale),
    queryFn: () => client.places.get(placeId ?? ""),
    enabled: Boolean(placeId),
    retry: false,
  });
}

/** GoWay's search, for the place picker. Off until there is something to search for. */
export function useGoWaySearch(query: string) {
  const client = useGoWayClient();
  const { locale } = useTranslation();
  const term = query.trim();
  return useQuery<SearchResult[]>({
    queryKey: queryKeys.goway.search(term, locale),
    queryFn: async () => (await client.search.query({ query: term, limit: SEARCH_LIMIT })).items,
    enabled: term.length >= 2,
    retry: false,
  });
}

/**
 * The claims the store's owning Oxy account holds on ONE place, every state —
 * `GET /claims?oxyAccountId=&placeId=`, so a store with many locations never
 * pages through every claim it holds to find this one. Readable by whoever
 * GoWay lets act for the account — its owner, admins and editors.
 */
export function usePlaceClaims(oxyAccountId: string | undefined, placeId: string | undefined) {
  const client = useGoWayClient();
  return useQuery<PlaceClaim[]>({
    queryKey: queryKeys.goway.placeClaims(oxyAccountId ?? "", placeId ?? ""),
    queryFn: async () =>
      (
        await client.claims.list({
          oxyAccountId: oxyAccountId ?? "",
          placeId: placeId ?? "",
          limit: MAX_CLAIM_LIST_LIMIT,
        })
      ).items,
    enabled: Boolean(oxyAccountId) && Boolean(placeId),
    retry: false,
  });
}

/** One place's dated exceptions, past ones included. */
export function useHoursExceptions(placeId: string | undefined) {
  const client = useGoWayClient();
  return useQuery<PlaceHoursException[]>({
    queryKey: queryKeys.goway.hoursExceptions(placeId ?? ""),
    queryFn: async () =>
      (await client.places.hoursExceptions.list(placeId ?? "", { limit: MAX_HOURS_EXCEPTION_LIST_LIMIT })).items,
    enabled: Boolean(placeId),
    retry: false,
  });
}

/** Refresh every read of one place after a write to it. */
function useInvalidatePlace() {
  const queryClient = useQueryClient();
  return (placeId: string) => {
    queryClient.invalidateQueries({ queryKey: ["goway", "place", placeId] });
  };
}

/** Create a GoWay place for a shop GoWay does not know yet. */
export function useCreateGoWayPlace() {
  const client = useGoWayClient();
  return useMutation({ mutationFn: (input: PlaceCreateInput) => client.places.create(input) });
}

/** Edit a place the store's claim lets this session edit: hours, contact. */
export function useUpdateGoWayPlace(placeId: string) {
  const client = useGoWayClient();
  const invalidate = useInvalidatePlace();
  return useMutation({
    mutationFn: (input: PlaceUpdateInput) => client.places.update(placeId, input),
    onSuccess: () => invalidate(placeId),
  });
}

/** Apply the accessibility form's writes, one at a time, in order. */
export function useApplyCapabilityOperations(placeId: string) {
  const client = useGoWayClient();
  const invalidate = useInvalidatePlace();
  return useMutation({
    mutationFn: async (operations: readonly CapabilityOperation[]) => {
      for (const operation of operations) {
        if (operation.kind === "put") {
          await client.places.capabilities.put(placeId, operation.key, operation.assertion);
        } else {
          await client.places.capabilities.delete(placeId, operation.key);
        }
      }
    },
    // A partial failure still changed something: re-read either way.
    onSettled: () => invalidate(placeId),
  });
}

/**
 * Say, on the place, which Mercaria location it is: `commerce.mercaria.store`
 * = the location id. At `business_asserted` once the store's claim is
 * approved — which is what makes the link something Mercaria can trust.
 * Written while the claim is pending it lands at `community_reported`, and
 * GoWay re-tiers it on approval only if the claim's FILER wrote it, or a
 * session acting as the store's account; anyone else writes it again then.
 */
export function useAssertStoreLink(placeId: string) {
  const client = useGoWayClient();
  const invalidate = useInvalidatePlace();
  return useMutation({
    mutationFn: (locationId: string) =>
      client.places.capabilities.put(placeId, MERCARIA_STORE_CAPABILITY, { value: locationId }),
    onSuccess: () => invalidate(placeId),
  });
}

/** File a claim on the place for the store's owning Oxy account. GoWay's moderators decide it. */
export function useClaimGoWayPlace(placeId: string) {
  const client = useGoWayClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { oxyAccountId: string; role: PlaceClaimRole }) =>
      client.places.claims.create(placeId, input),
    onSuccess: (claim) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.goway.accountClaims(claim.oxyAccountId) }),
  });
}

/** Add a dated exception — a holiday closure or special hours. */
export function useCreateHoursException(placeId: string) {
  const client = useGoWayClient();
  const invalidate = useInvalidatePlace();
  return useMutation({
    mutationFn: (input: PlaceHoursExceptionInput) => client.places.hoursExceptions.create(placeId, input),
    onSuccess: () => invalidate(placeId),
  });
}

/** Withdraw one of the business's own exceptions. */
export function useDeleteHoursException(placeId: string) {
  const client = useGoWayClient();
  const invalidate = useInvalidatePlace();
  return useMutation({
    mutationFn: (exceptionId: string) => client.places.hoursExceptions.delete(placeId, exceptionId),
    onSuccess: () => invalidate(placeId),
  });
}

/** `https://goway.to/place/<id>` — where the place is public, and where it can be reported. */
export function useGoWayPlaceUrl(placeId: string | undefined): string | undefined {
  const client = useGoWayClient();
  return placeId === undefined ? undefined : client.links.place(placeId);
}
