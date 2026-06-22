import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  TaxRate,
  CreateTaxRateInput,
  UpdateTaxRateInput,
  Location,
  CreateLocationInput,
  UpdateLocationInput,
} from "@mercaria/shared-types";
import {
  fetchTaxRates,
  createTaxRate,
  updateTaxRate,
  deleteTaxRate,
} from "../api/tax-rates";
import {
  fetchLocations,
  createLocation,
  updateLocation,
  deleteLocation,
} from "../api/locations";
import { queryKeys } from "../queryKeys";

// --- Tax rates -------------------------------------------------------------

/** The store's tax rates. */
export function useTaxRates(storeId: string) {
  return useQuery<TaxRate[]>({
    queryKey: queryKeys.taxRates(storeId),
    queryFn: () => fetchTaxRates(storeId),
    enabled: Boolean(storeId),
  });
}

function invalidateTax(queryClient: ReturnType<typeof useQueryClient>, storeId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.taxRates(storeId) });
}

/** Create a tax rate. */
export function useCreateTaxRate(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaxRateInput) => createTaxRate(storeId, input),
    onSuccess: () => invalidateTax(queryClient, storeId),
  });
}

/** Update a tax rate. */
export function useUpdateTaxRate(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTaxRateInput }) =>
      updateTaxRate(storeId, id, input),
    onSuccess: () => invalidateTax(queryClient, storeId),
  });
}

/** Delete a tax rate. */
export function useDeleteTaxRate(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTaxRate(storeId, id),
    onSuccess: () => invalidateTax(queryClient, storeId),
  });
}

// --- Locations -------------------------------------------------------------

/** The store's locations. */
export function useLocations(storeId: string) {
  return useQuery<Location[]>({
    queryKey: queryKeys.locations(storeId),
    queryFn: () => fetchLocations(storeId),
    enabled: Boolean(storeId),
  });
}

function invalidateLocations(queryClient: ReturnType<typeof useQueryClient>, storeId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.locations(storeId) });
}

/** Create a location. */
export function useCreateLocation(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLocationInput) => createLocation(storeId, input),
    onSuccess: () => invalidateLocations(queryClient, storeId),
  });
}

/** Update a location. */
export function useUpdateLocation(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLocationInput }) =>
      updateLocation(storeId, id, input),
    onSuccess: () => invalidateLocations(queryClient, storeId),
  });
}

/** Delete a location. */
export function useDeleteLocation(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteLocation(storeId, id),
    onSuccess: () => invalidateLocations(queryClient, storeId),
  });
}
