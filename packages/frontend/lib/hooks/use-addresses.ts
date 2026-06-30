import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type {
  Address,
  CreateAddressInput,
  UpdateAddressInput,
} from '@mercaria/shared-types';
import {
  fetchAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
} from '../api/addresses';
import { queryKeys } from './query-keys';

/** Five minutes — addresses change rarely. */
const STALE_TIME = 1000 * 60 * 5;

/** Fetch the buyer's saved addresses. Gated on auth. */
export function useAddresses() {
  const { isAuthenticated } = useOxy();
  return useQuery<Address[]>({
    queryKey: queryKeys.addresses.all,
    queryFn: fetchAddresses,
    enabled: isAuthenticated,
    staleTime: STALE_TIME,
  });
}

/** Create a new address; refreshes the list on success. */
export function useCreateAddress() {
  const queryClient = useQueryClient();
  return useMutation<Address, Error, CreateAddressInput>({
    mutationFn: (input) => createAddress(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.addresses.all });
    },
  });
}

/** Update an address (incl. set-default); refreshes the list on success. */
export function useUpdateAddress() {
  const queryClient = useQueryClient();
  return useMutation<Address, Error, { id: string; input: UpdateAddressInput }>({
    mutationFn: ({ id, input }) => updateAddress(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.addresses.all });
    },
  });
}

/** Delete an address; refreshes the list on success. */
export function useDeleteAddress() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => deleteAddress(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.addresses.all });
    },
  });
}
