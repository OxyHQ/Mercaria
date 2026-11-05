/**
 * A fake of the two account-graph reads `services/store-access.service.ts`
 * makes through the ONE `oxyClient`: `accountAccessFor(req, accountId)` (the
 * caller's access in one Oxy account) and `withUser(bearer, …).accounts.list()`
 * (every account they reach).
 *
 * A test states who holds which role with `roleOf(bearer, accountId)` — the
 * shape it already thinks in — and the fake answers the way the SDK does:
 * `null` is Oxy's 403/404 (`ACCESS_DENIED`), a thrown `OxyAccessError` passes
 * through as it is, and anything else thrown is an outage
 * (`ACCESS_UNAVAILABLE`). The permissions on an answer are Oxy's baseline for
 * the role (`packages/api/src/utils/accountRoles.ts`), for the permissions
 * Mercaria gates on.
 */

import type { AccountRole } from '@oxy.so/core';
import { OxyAccessError, type OxyAccountAccess } from '@oxy.so/core/server';

/** Oxy's baseline, for the account permissions Mercaria asks about. */
const BASELINE: Readonly<Record<AccountRole, readonly string[]>> = {
  owner: ['account:read', 'account:update', 'account:delete', 'account:act_as'],
  admin: ['account:read', 'account:update', 'account:act_as'],
  editor: ['account:read', 'account:act_as'],
  developer: ['account:read'],
  billing: ['account:read'],
  viewer: ['account:read'],
};

/**
 * A role is written as a plain string (`'admin'`), because TypeScript widens a
 * literal returned from an async callback and every test would otherwise need
 * a cast. {@link asRole} refuses at run time anything Oxy could not answer.
 */
export type FakeRoleOf = (
  bearer: string,
  accountId: string,
) => string | null | Promise<string | null>;

export type FakeAccountList = (
  bearer: string,
) => ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>;

/** A role Oxy could actually answer, or a loud failure in the test's own fixture. */
function asRole(value: string): AccountRole {
  if (!Object.hasOwn(BASELINE, value)) {
    throw new Error(`fakeAccountAccess: '${value}' is not an Oxy account role`);
  }
  return value as AccountRole;
}

/** What `roleOf` threw, as the SDK would have raised it. */
function asAccessError(error: unknown): OxyAccessError {
  if (error instanceof OxyAccessError) return error;
  return new OxyAccessError('ACCESS_UNAVAILABLE', 'Could not read the account from Oxy', {
    cause: error,
  });
}

export function fakeAccountAccess(roleOf: FakeRoleOf, list: FakeAccountList = () => new Map()) {
  return {
    async accountAccessFor(
      req: { accessToken?: string },
      accountId: string,
      _options?: { fresh?: boolean },
    ): Promise<OxyAccountAccess> {
      let answer: string | null;
      try {
        answer = await roleOf(req.accessToken ?? '', accountId);
      } catch (error) {
        throw asAccessError(error);
      }
      if (answer === null) {
        throw new OxyAccessError('ACCESS_DENIED', `Oxy refused account ${accountId}`);
      }
      const role = asRole(answer);
      const permissions = BASELINE[role];
      return {
        accountId,
        kind: 'organization',
        relationship: role === 'owner' ? 'owner' : 'member',
        role,
        source: 'direct',
        permissions,
        has: (permission: string) => permissions.includes(permission),
      };
    },
    async withUser<T>(
      bearer: string,
      fn: (user: { accounts: { list: () => Promise<unknown[]> } }) => Promise<T>,
    ): Promise<T> {
      return fn({
        accounts: {
          list: async () =>
            [...(await list(bearer))].map(([accountId, role]) => ({
              accountId,
              relationship: 'member',
              callerMembership: { role: asRole(role) },
            })),
        },
      });
    },
  };
}
