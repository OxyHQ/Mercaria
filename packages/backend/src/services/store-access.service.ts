/**
 * Who may act for a store, and with which permissions (ADR 0012).
 *
 * A store is owned by an Oxy account — `stores.oxy_account_id`, usually a
 * `kind=organization` — and OXY decides who belongs to that account and in
 * which role. Mercaria keeps no member list. It maps the caller's Oxy role onto
 * its own permissions (`STORE_ROLE_PERMISSIONS`) and applies the one thing it
 * does keep: a per-person exception (`store_permission_overrides`).
 *
 *     effective = (role defaults ∪ granted) − revoked
 *
 * An override never ADMITS anybody. No role, no access, whatever the row says.
 *
 * ## How the role is resolved
 *
 * 1. **The session IS the owning account, undelegated** — the person who owns a
 *    personal store, or an agent operating itself. Owner, with no round trip.
 * 2. **Anything else asks Oxy, with the CALLER's own bearer** —
 *    `oxyClient.accountAccessFor`, the SDK's reader of `GET /accounts/:id`.
 *
 * Rule 1 deliberately excludes a DELEGATED session. A person who switched into
 * an organization authenticates AS it (`req.userId` is the organization), but
 * Oxy authorizes that session as the human operator — and an `editor` holds
 * `account:act_as`. Treating "the session is the owning organization" as
 * ownership would hand every editor who switched in the `store:manage` their
 * role withholds. Asking Oxy instead gets the operator's own role, which is
 * Oxy's answer for that session everywhere else too.
 *
 * ## Failure is CLOSED, an outage is a 503, and only answers are remembered
 *
 * The SDK maps every outcome one way (`lib/errors/oxy-access.ts`): 401 → sign in
 * again, 403/404 → no access, anything else → `SERVICE_UNAVAILABLE`, never
 * "probably still a member". It caches only POSITIVE answers, per session, for
 * 30 s — a refusal or an outage is never remembered, so the next request asks
 * again — and a write asks `fresh` (`loadStore` passes it for every
 * non-read method), so a revoked role cannot keep changing a store.
 */

import type { Request } from 'express';
import type { AccountRole } from '@oxy.so/core';
import { getOxyActor, getOxyUserId, type OxyCallerRequest } from '@oxy.so/core/server';
import {
  STORE_ACCOUNT_ROLES,
  STORE_PERMISSIONS,
  effectiveStorePermissions,
  type StoreAccess,
  type StoreAccountRole,
} from '@mercaria/shared-types';
import {
  findStorePermissionOverride,
  findStorePermissionOverridesForUser,
  findStoresByOwnerAccounts,
  type StorePermissionOverrideRow,
  type StoreRow,
} from '../db/stores/storeRepository.js';
import { forbidden, MercariaError, serviceUnavailable } from '../lib/errors/error-codes.js';
import { oxyAccessOutcome } from '../lib/errors/oxy-access.js';
import { log } from '../lib/logger.js';
import { oxyClient } from '../middleware/auth.js';
import { ErrorCodes } from '../utils/api-response.js';

/**
 * The caller a store-access question is asked for. Built from a verified
 * request — never from a body or a header a client controls.
 */
export interface StoreCaller {
  /** The account the session speaks as (`req.userId`). */
  readonly accountId: string;
  /**
   * The person (or agent) who acted, when Oxy reported it — differs from
   * `accountId` when somebody operates an organization. `null` is unknown,
   * never "nobody".
   */
  readonly actorAccountId: string | null;
  /** Whether the session is a person operating another account. */
  readonly delegated: boolean;
  /** The verified Oxy session — what an answer about this caller is cached under. */
  readonly sessionId: string;
  /** The caller's own bearer, forwarded to Oxy and nowhere else. */
  readonly accessToken: string;
}

/** Options for one access question. */
export interface StoreAccessOptions {
  /** Ask Oxy rather than reuse a cached answer — every write passes it. */
  readonly fresh?: boolean;
}

/**
 * Oxy's role vocabulary must be Mercaria's, or a role resolves to no
 * permissions. Assigning one to the other is the compile-time check: a role
 * Oxy adds fails `tsc` here instead of locking its holders out silently.
 */
function storeRoleOf(role: AccountRole): StoreAccountRole {
  return role;
}

/** A role name Oxy answered, or `null` for one outside the vocabulary (no permissions). */
function parseStoreRole(role: string): StoreAccountRole | null {
  return (STORE_ACCOUNT_ROLES as readonly string[]).includes(role)
    ? storeRoleOf(role as AccountRole)
    : null;
}

/** The caller of an authenticated request, or `null` when it carries none. */
export function storeCallerFrom(req: Request): StoreCaller | null {
  const accountId = getOxyUserId(req);
  const { accessToken, sessionId } = req;
  if (!accountId || !accessToken || !sessionId) return null;
  const actor = getOxyActor(req);
  return {
    accountId,
    actorAccountId: actor?.actorAccountId ?? null,
    delegated: actor?.delegated ?? false,
    sessionId,
    accessToken,
  };
}

/**
 * {@link storeCallerFrom}, for a handler that maps errors through
 * `respondWithError`: a request with no verified caller is a 401.
 */
export function requireStoreCaller(req: Request): StoreCaller {
  const caller = storeCallerFrom(req);
  if (!caller) {
    throw new MercariaError({ code: ErrorCodes.UNAUTHORIZED, message: 'Authentication required' });
  }
  return caller;
}

/**
 * The person an override applies to and an audit row names: the actor when
 * Oxy reported one, else the session's account.
 */
function overrideSubject(caller: StoreCaller): string {
  return caller.actorAccountId ?? caller.accountId;
}

/** Whether the session is, undelegated, exactly this account (rule 1). */
function isUndelegatedSelf(caller: StoreCaller, accountId: string): boolean {
  return (
    caller.accountId === accountId &&
    caller.actorAccountId === caller.accountId &&
    !caller.delegated
  );
}

/** The request shape the SDK's caller readers take, for this caller. */
function oxyCaller(caller: StoreCaller): OxyCallerRequest {
  return { userId: caller.accountId, sessionId: caller.sessionId, accessToken: caller.accessToken };
}

/** A failed Oxy read, as the error a store route answers. `null` is "no access". */
function storeAccessFailure(error: unknown, context: Record<string, unknown>): null {
  switch (oxyAccessOutcome(error)) {
    case 'denied':
      return null;
    case 'session_required':
      throw new MercariaError({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Your Oxy session is no longer valid. Sign in again.',
      });
    case 'unavailable':
      log.general.warn({ err: error, ...context }, '[StoreAccess] Oxy account graph unavailable');
      throw serviceUnavailable(
        'Store access cannot be checked right now because Oxy is unavailable. Try again shortly.',
      );
  }
}

/**
 * What the caller may do in an Oxy account, or `null` when Oxy says they hold
 * nothing there.
 *
 * Throws `SERVICE_UNAVAILABLE` when Oxy cannot answer and `UNAUTHORIZED` when
 * it no longer accepts the caller's bearer.
 */
async function readAccountAccess(
  caller: StoreCaller,
  accountId: string,
  options: StoreAccessOptions,
) {
  try {
    return await oxyClient.accountAccessFor(oxyCaller(caller), accountId, {
      fresh: options.fresh === true,
    });
  } catch (error) {
    return storeAccessFailure(error, { accountId });
  }
}

/**
 * The caller's role in an Oxy account, or `null` when they hold none.
 *
 * Throws `SERVICE_UNAVAILABLE` when Oxy cannot answer and `UNAUTHORIZED` when
 * it no longer accepts the caller's bearer.
 */
export async function resolveAccountRole(
  caller: StoreCaller,
  accountId: string,
  options: StoreAccessOptions = {},
): Promise<StoreAccountRole | null> {
  if (isUndelegatedSelf(caller, accountId)) return 'owner';
  const access = await readAccountAccess(caller, accountId, options);
  return access === null ? null : parseStoreRole(access.role);
}

/**
 * What a role plus an override yields on one store. The owning account itself
 * holds every permission and no override applies to it: an account is not a
 * member of itself, so there is no role for an exception to adjust.
 */
function accessFor(
  store: Pick<StoreRow, 'oxyAccountId'>,
  caller: StoreCaller,
  role: StoreAccountRole,
  override: StorePermissionOverrideRow | null,
): StoreAccess {
  if (overrideSubject(caller) === store.oxyAccountId) {
    return { role: 'owner', permissions: [...STORE_PERMISSIONS] };
  }
  return { role, permissions: effectiveStorePermissions(role, override) };
}

/** The caller's access to one store, or `null` when they have none. */
export async function resolveStoreAccess(
  caller: StoreCaller,
  store: Pick<StoreRow, 'id' | 'oxyAccountId'>,
  options: StoreAccessOptions = {},
): Promise<StoreAccess | null> {
  const role = await resolveAccountRole(caller, store.oxyAccountId, options);
  if (role === null) return null;
  const override = await findStorePermissionOverride(store.id, overrideSubject(caller));
  return accessFor(store, caller, role, override);
}

/** One store the caller can reach, with what they may do there. */
export interface AccessibleStore {
  store: StoreRow;
  access: StoreAccess;
}

/**
 * Every account the caller reaches, with their role in each — ONE `GET /accounts`
 * as the caller, anchored on the human operator, so the answer is the same
 * whichever of their accounts the session is currently acting as.
 */
async function listCallerAccountRoles(caller: StoreCaller): Promise<Map<string, StoreAccountRole>> {
  const roles = new Map<string, StoreAccountRole>();
  let nodes: Awaited<ReturnType<typeof oxyClient.accounts.list>>;
  try {
    nodes = await oxyClient.withUser(caller.accessToken, (user) => user.accounts.list());
  } catch (error) {
    storeAccessFailure(error, { op: 'list' });
    return roles;
  }
  for (const node of nodes) {
    // `self` is the caller's own personal account: implicit ownership, no row.
    if (node.relationship === 'self') roles.set(node.accountId, 'owner');
    else if (node.callerMembership)
      roles.set(node.accountId, storeRoleOf(node.callerMembership.role));
  }
  return roles;
}

/** Every store the caller can reach, newest first. */
export async function listAccessibleStores(caller: StoreCaller): Promise<AccessibleStore[]> {
  const roles = await listCallerAccountRoles(caller);
  // The session's own account, when it is the caller undelegated — the list
  // carries it as `self` already; this only saves a person whose list Oxy
  // could not resolve from losing their personal store.
  if (isUndelegatedSelf(caller, caller.accountId)) roles.set(caller.accountId, 'owner');

  const stores = await findStoresByOwnerAccounts([...roles.keys()]);
  const overrides = await findStorePermissionOverridesForUser(
    stores.map((store) => store.id),
    overrideSubject(caller),
  );
  return stores.flatMap((store) => {
    const role = roles.get(store.oxyAccountId);
    if (role === undefined) return [];
    return [{ store, access: accessFor(store, caller, role, overrides.get(store.id) ?? null) }];
  });
}

/**
 * Refuse unless the caller may put a store under `accountId`: they ARE that
 * account undelegated, or Oxy grants them `account:update` in it — the
 * permission its governors (owners and admins) hold. Creating a store for an
 * organization and moving a store to one are both commitments the
 * organization's governors make, which is the line Oxy draws for its own
 * account administration. Always asked fresh: it is a write.
 */
export async function assertMayOwnStores(caller: StoreCaller, accountId: string): Promise<void> {
  if (isUndelegatedSelf(caller, accountId)) return;
  const access = await readAccountAccess(caller, accountId, { fresh: true });
  if (!access?.has('account:update')) {
    throw forbidden('Only an owner or admin of that Oxy account can give it a store');
  }
}

/** The Oxy account an audit row should name as the person who acted. */
export function storeAuditActor(caller: StoreCaller): string | null {
  return caller.actorAccountId;
}
