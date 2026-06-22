import type {
  ApiResponse,
  StoreMember,
  InviteMemberInput,
  UpdateMemberInput,
} from "@mercaria/shared-types";
import apiClient from "./client";
import { unwrap } from "./unwrap";

const base = (storeId: string) => `/admin/stores/${storeId}/members`;

/** GET the store's members. */
export async function fetchMembers(storeId: string): Promise<StoreMember[]> {
  const { data } = await apiClient.get<ApiResponse<StoreMember[]>>(base(storeId));
  return unwrap(data);
}

/** POST a new member invite. Returns the updated member list. */
export async function inviteMember(
  storeId: string,
  input: InviteMemberInput,
): Promise<StoreMember[]> {
  const { data } = await apiClient.post<ApiResponse<StoreMember[]>>(base(storeId), input);
  return unwrap(data);
}

/** PATCH a member's role/permissions. Returns the updated member list. */
export async function updateMember(
  storeId: string,
  oxyUserId: string,
  input: UpdateMemberInput,
): Promise<StoreMember[]> {
  const { data } = await apiClient.patch<ApiResponse<StoreMember[]>>(
    `${base(storeId)}/${oxyUserId}`,
    input,
  );
  return unwrap(data);
}

/** DELETE a member. Returns the updated member list. */
export async function removeMember(
  storeId: string,
  oxyUserId: string,
): Promise<StoreMember[]> {
  const { data } = await apiClient.delete<ApiResponse<StoreMember[]>>(
    `${base(storeId)}/${oxyUserId}`,
  );
  return unwrap(data);
}
