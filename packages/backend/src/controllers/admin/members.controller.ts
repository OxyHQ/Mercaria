/**
 * Store members controller (THIN).
 *
 * Lists/invites/updates/removes store members. The acting member
 * (`req.storeMembership`, set by `loadStore`) is passed to `store.service` so it
 * can enforce the owner-protection invariants (only an owner may touch another
 * owner; the last owner cannot be removed/demoted). Those rules live in the
 * service, not here.
 */

import type { Request, Response } from 'express';
import type { InviteMemberInput, UpdateMemberInput, StoreMember } from '@mercaria/shared-types';
import type { IStore, IStoreMember } from '../../models/store.js';
import {
  inviteMember,
  updateMember,
  removeMember,
} from '../../services/store.service.js';
import { sendSuccess } from '../../utils/api-response.js';
import { respondWithError } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';

/** Serialize a store member to the `StoreMember` DTO. */
function toMemberDTO(member: IStoreMember): StoreMember {
  return {
    oxyUserId: member.oxyUserId,
    role: member.role,
    permissions: [...member.permissions],
    joinedAt: member.joinedAt.toISOString(),
  };
}

/** Read the loaded store + acting membership, or respond 500 if missing. */
function loaded(req: Request, res: Response): { store: IStore; actor: IStoreMember } | null {
  const store = req.store;
  const actor = req.storeMembership;
  if (!store || !actor) {
    respondWithError(res, undefined, 'Store not loaded');
    return null;
  }
  return { store, actor };
}

/** GET /admin/stores/:storeId/members — list members. */
export function listMembers(req: Request, res: Response): void {
  const ctx = loaded(req, res);
  if (!ctx) return;
  sendSuccess(res, ctx.store.members.map(toMemberDTO));
}

/** POST /admin/stores/:storeId/members — invite/add a member. */
export async function addMember(req: Request, res: Response): Promise<void> {
  const ctx = loaded(req, res);
  if (!ctx) return;
  try {
    const storeId = String((ctx.store as { _id: unknown })._id);
    const updated = await inviteMember(storeId, ctx.actor, req.body as InviteMemberInput);
    sendSuccess(res, updated.members.map(toMemberDTO), 201);
  } catch (err) {
    log.general.error({ err }, 'Failed to add store member');
    respondWithError(res, err, 'Failed to add member');
  }
}

/** PATCH /admin/stores/:storeId/members/:oxyUserId — update a member's role/permissions. */
export async function patchMember(req: Request, res: Response): Promise<void> {
  const ctx = loaded(req, res);
  if (!ctx) return;
  const targetOxyUserId = routeParam(req, 'oxyUserId');
  try {
    const storeId = String((ctx.store as { _id: unknown })._id);
    const updated = await updateMember(
      storeId,
      ctx.actor,
      targetOxyUserId,
      req.body as UpdateMemberInput,
    );
    sendSuccess(res, updated.members.map(toMemberDTO));
  } catch (err) {
    log.general.error({ err, targetOxyUserId }, 'Failed to update store member');
    respondWithError(res, err, 'Failed to update member');
  }
}

/** DELETE /admin/stores/:storeId/members/:oxyUserId — remove a member. */
export async function deleteMember(req: Request, res: Response): Promise<void> {
  const ctx = loaded(req, res);
  if (!ctx) return;
  const targetOxyUserId = routeParam(req, 'oxyUserId');
  try {
    const storeId = String((ctx.store as { _id: unknown })._id);
    const updated = await removeMember(storeId, ctx.actor, targetOxyUserId);
    sendSuccess(res, updated.members.map(toMemberDTO));
  } catch (err) {
    log.general.error({ err, targetOxyUserId }, 'Failed to remove store member');
    respondWithError(res, err, 'Failed to remove member');
  }
}
