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
 * 2. **Anything else asks Oxy, with the CALLER's own bearer**
 *    (`oxy-account-graph.ts`).
 *
 * Rule 1 deliberately excludes a DELEGATED session. A person who switched into
 * an organization authenticates AS it (`req.userId` is the organization), but
 * Oxy authorizes that session as the human operator — and an `editor` holds
 * `account:act_as`. Treating "the session is the owning organization" as
 * ownership would hand every editor who switched in the `store:manage` their
 * role withholds. Asking Oxy instead gets the operator's own role, which is
 * Oxy's answer for that session everywhere else too.
 *
 * ## Failure is CLOSED, and it is a 503
 *
 * An Oxy outage refuses the request with `SERVICE_UNAVAILABLE`; it never falls
 * back to "probably still a member". See `oxy-account-graph.ts` for how each
 * Oxy outcome is read.
 *
 * ## The cache is short, per process, and keyed on the HUMAN
 *
 * A role is cached for {@link ROLE_CACHE_TTL_MS} (an absence for
 * {@link NO_ROLE_CACHE_TTL_MS}, so somebody just added is not kept waiting),
 * keyed on the ACTOR — `getOxyActor().actorAccountId` — and the account asked
 * about. Keyed on the session's account instead, two people operating one
 * organization would share each other's answers. A caller whose actor Oxy did
 * not report is never cached: there is no key that is safe to share.
 *
 * In-process rather than Redis on purpose: a revocation is bounded by the TTL
 * either way, and Redis would put a second network dependency in front of
 * every admin request for no gain in correctness.
 */

import type { Request } from 'express';
import type { AccountRole } from '@oxy.so/core';
import { getOxyActor, getOxyUserId } from '@oxy.so/core/server';
import {
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
import { forbidden, MercariaError } from '../lib/errors/error-codes.js';
import { ErrorCodes } from '../utils/api-response.js';
import { listCallerAccountRoles, readCallerAccountRole } from './oxy-account-graph.js';

/** How long a resolved role is reused. */
export const ROLE_CACHE_TTL_MS = 45_000;

/** How long "no role" is reused — shorter, so a fresh invitation lands quickly. */
export const NO_ROLE_CACHE_TTL_MS = 10_000;

/** Entries kept before the oldest is evicted. */
const ROLE_CACHE_MAX_ENTRIES = 10_000;

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
  /** The caller's own bearer, forwarded to Oxy and nowhere else. */
  readonly accessToken: string;
}

/**
 * Oxy's role vocabulary must be Mercaria's, or a role resolves to no
 * permissions. Assigning one to the other is the compile-time check: a role
 * Oxy adds fails `tsc` here instead of locking its holders out silently.
 */
function asStoreAccountRole(role: AccountRole): StoreAccountRole {
  return role;
}

/** The caller of an authenticated request, or `null` when it carries none. */
export function storeCallerFrom(req: Request): StoreCaller | null {
  const accountId = getOxyUserId(req);
  const accessToken = req.accessToken;
  if (!accountId || !accessToken) return null;
  const actor = getOxyActor(req);
  return {
    accountId,
    actorAccountId: actor?.actorAccountId ?? null,
    delegated: actor?.delegated ?? false,
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

const roleCache = new Map<string, { role: StoreAccountRole | null; expiresAt: number }>();

function cacheKey(caller: StoreCaller, accountId: string): string | null {
  return caller.actorAccountId === null ? null : `${caller.actorAccountId}\u0000${accountId}`;
}

function rememberRole(key: string, role: StoreAccountRole | null): void {
  if (roleCache.size >= ROLE_CACHE_MAX_ENTRIES) {
    const oldest = roleCache.keys().next().value;
    if (oldest !== undefined) roleCache.delete(oldest);
  }
  const ttl = role === null ? NO_ROLE_CACHE_TTL_MS : ROLE_CACHE_TTL_MS;
  // Delete first so a refreshed entry moves to the young end of the eviction order.
  roleCache.delete(key);
  roleCache.set(key, { role, expiresAt: Date.now() + ttl });
}

/** Forget every cached role. */
export function resetStoreAccessCacheForTests(): void {
  roleCache.clear();
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
): Promise<StoreAccountRole | null> {
  if (isUndelegatedSelf(caller, accountId)) return 'owner';

  const key = cacheKey(caller, accountId);
  const cached = key === null ? undefined : roleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.role;

  const oxyRole = await readCallerAccountRole(caller.accessToken, accountId);
  const role = oxyRole === null ? null : asStoreAccountRole(oxyRole);
  if (key !== null) rememberRole(key, role);
  return role;
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
): Promise<StoreAccess | null> {
  const role = await resolveAccountRole(caller, store.oxyAccountId);
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
 * Every store the caller can reach, newest first: the stores owned by any
 * account Oxy lists for them — ONE `GET /accounts`, which is anchored on the
 * human operator, so the answer is the same whichever of their accounts the
 * session is currently acting as.
 */
export async function listAccessibleStores(caller: StoreCaller): Promise<AccessibleStore[]> {
  const roles = new Map<string, StoreAccountRole>();
  for (const [accountId, role] of await listCallerAccountRoles(caller.accessToken)) {
    roles.set(accountId, asStoreAccountRole(role));
  }
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
 * account undelegated, or they hold `owner` or `admin` in it. Creating a store
 * for an organization and moving a store to one are both commitments the
 * organization's governors make, which is the line Oxy draws for its own
 * account administration.
 */
export async function assertMayOwnStores(caller: StoreCaller, accountId: string): Promise<void> {
  const role = await resolveAccountRole(caller, accountId);
  if (role !== 'owner' && role !== 'admin') {
    throw forbidden('Only an owner or admin of that Oxy account can give it a store');
  }
}

/** The Oxy account an audit row should name as the person who acted. */
export function storeAuditActor(caller: StoreCaller): string | null {
  return caller.actorAccountId;
}
