import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  StoreMember,
  InviteMemberInput,
  UpdateMemberInput,
} from "@mercaria/shared-types";
import { fetchMembers, inviteMember, updateMember, removeMember } from "../api/members";
import { queryKeys } from "../queryKeys";

/** The store's members. */
export function useMembers(storeId: string) {
  return useQuery<StoreMember[]>({
    queryKey: queryKeys.members(storeId),
    queryFn: () => fetchMembers(storeId),
    enabled: Boolean(storeId),
  });
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>, storeId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.members(storeId) });
  // Member changes affect the caller's own effective permissions on the store.
  queryClient.invalidateQueries({ queryKey: queryKeys.stores.all });
  queryClient.invalidateQueries({ queryKey: queryKeys.stores.detail(storeId) });
}

/** Invite a member. */
export function useInviteMember(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteMemberInput) => inviteMember(storeId, input),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}

/** Update a member's role/permissions. */
export function useUpdateMember(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ oxyUserId, input }: { oxyUserId: string; input: UpdateMemberInput }) =>
      updateMember(storeId, oxyUserId, input),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}

/** Remove a member. */
export function useRemoveMember(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (oxyUserId: string) => removeMember(storeId, oxyUserId),
    onSuccess: () => invalidate(queryClient, storeId),
  });
}
