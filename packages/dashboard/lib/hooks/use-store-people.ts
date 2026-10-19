import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import type { AccountInvitation, AccountMember, AccountNode, AccountRole } from '@oxy.so/core';
import type {
  SetStorePermissionOverrideInput,
  StorePermissionOverride,
} from '@mercaria/shared-types';
import { fetchPermissionOverrides, setPermissionOverride } from '../api/permission-overrides';
import { transferStoreOwnerAccount } from '../api/stores';
import { queryKeys } from '../queryKeys';

/**
 * Who can act for a store, and the exceptions Mercaria keeps (ADR 0012).
 *
 * A store is owned by an Oxy account. WHO belongs to that account is read from
 * Oxy itself, with the signed-in session — Mercaria keeps no member list — and
 * the per-person permission exceptions are read from Mercaria.
 */

/** The Oxy account that owns the store. */
export function useOwnerAccount(oxyAccountId: string | undefined) {
  const { oxyServices } = useOxy();
  return useQuery<AccountNode>({
    queryKey: queryKeys.oxyAccount(oxyAccountId ?? ''),
    queryFn: () => oxyServices.accounts.get(oxyAccountId ?? ''),
    enabled: Boolean(oxyAccountId),
  });
}

/**
 * The owning account's members, as Oxy lists them. A PERSONAL account has none
 * — its one person is the account itself — so the list is not fetched for one.
 */
export function useOwnerAccountMembers(oxyAccountId: string | undefined, enabled: boolean) {
  const { oxyServices } = useOxy();
  return useQuery<AccountMember[]>({
    queryKey: queryKeys.oxyAccountMembers(oxyAccountId ?? ''),
    queryFn: () => oxyServices.accounts.members.list(oxyAccountId ?? ''),
    enabled: Boolean(oxyAccountId) && enabled,
  });
}

/**
 * The owning account's pending invitations. Oxy grants access only once the
 * invitee accepts, so until then they are here and not among the members.
 */
export function useOwnerAccountInvitations(oxyAccountId: string | undefined, enabled: boolean) {
  const { oxyServices } = useOxy();
  return useQuery<AccountInvitation[]>({
    queryKey: queryKeys.oxyAccountInvitations(oxyAccountId ?? ''),
    queryFn: () => oxyServices.accounts.invitations.list(oxyAccountId ?? ''),
    enabled: Boolean(oxyAccountId) && enabled,
  });
}

/** Invite one person, by email, to the owning account. */
export function useInviteToOwnerAccount(oxyAccountId: string) {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  return useMutation<AccountInvitation, Error, Invitee>({
    mutationFn: (invitee) => oxyServices.accounts.invitations.create(oxyAccountId, invitee),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.oxyAccountInvitations(oxyAccountId) }),
  });
}

/** Send a pending invitation again, with a fresh link and expiry. */
export function useResendInvitation(oxyAccountId: string) {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  return useMutation<AccountInvitation, Error, string>({
    mutationFn: (invitationId) =>
      oxyServices.accounts.invitations.resend(oxyAccountId, invitationId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.oxyAccountInvitations(oxyAccountId) }),
  });
}

/** Revoke a pending invitation; its link stops working. */
export function useCancelInvitation(oxyAccountId: string) {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (invitationId) =>
      oxyServices.accounts.invitations.cancel(oxyAccountId, invitationId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.oxyAccountInvitations(oxyAccountId) }),
  });
}

/** The store's permission overrides. */
export function usePermissionOverrides(storeId: string) {
  return useQuery<StorePermissionOverride[]>({
    queryKey: queryKeys.permissionOverrides(storeId),
    queryFn: () => fetchPermissionOverrides(storeId),
    enabled: Boolean(storeId),
  });
}

/** Write (or, with two empty sets, remove) one person's override. */
export function useSetPermissionOverride(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      oxyUserId,
      input,
    }: {
      oxyUserId: string;
      input: SetStorePermissionOverrideInput;
    }) => setPermissionOverride(storeId, oxyUserId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.permissionOverrides(storeId) });
      // An override can change the CALLER's own permissions on the store.
      queryClient.invalidateQueries({ queryKey: queryKeys.stores.all });
    },
  });
}

/** One person to invite. Oxy invites by email, and never as `owner`. */
export interface Invitee {
  email: string;
  role: Exclude<AccountRole, 'owner'>;
}

/** What "convert to organization" needs. */
export interface ConvertToOrganizationInput {
  username: string;
  displayName: string;
  invitees: readonly Invitee[];
}

/** The outcome, including any invitation Oxy refused. */
export interface ConvertToOrganizationResult {
  organizationId: string;
  failedInvitees: string[];
}

/**
 * Convert to organization, with the owner's own session:
 *  1. create the organization in Oxy (the caller becomes its owner);
 *  2. invite the people listed by email — each joins only after accepting the
 *     invitation in Oxy, and one Oxy refuses is reported, not fatal: the
 *     organization exists either way;
 *  3. move the store to the organization.
 *
 * Step 3 is the only Mercaria write, and it runs last: a store is never moved
 * onto an organization that does not exist yet.
 */
export function useConvertToOrganization(storeId: string) {
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();
  return useMutation<ConvertToOrganizationResult, Error, ConvertToOrganizationInput>({
    mutationFn: async (input) => {
      const organization = await oxyServices.accounts.create({
        kind: 'organization',
        username: input.username,
        name: { displayName: input.displayName },
      });
      const failedInvitees: string[] = [];
      for (const invitee of input.invitees) {
        try {
          await oxyServices.accounts.invitations.create(organization.accountId, invitee);
        } catch {
          failedInvitees.push(invitee.email);
        }
      }
      await transferStoreOwnerAccount(storeId, { oxyAccountId: organization.accountId });
      return { organizationId: organization.accountId, failedInvitees };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stores.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stores.detail(storeId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.permissionOverrides(storeId) });
    },
  });
}

/** Usernames for a set of Oxy ids, to name members and override holders. */
export function useUsernames(oxyUserIds: readonly string[]) {
  const { oxyServices } = useOxy();
  const ids = [...oxyUserIds].sort();
  return useQuery<Map<string, string>>({
    queryKey: ['oxy-usernames', ids],
    queryFn: async () => {
      const users = await oxyServices.users.getMany(ids);
      return new Map(users.map((user) => [user.id, user.username]));
    },
    enabled: ids.length > 0,
  });
}
