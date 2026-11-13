/**
 * A fake of Oxy application roles at the SDK boundary — what
 * `oxyClient.middleware.requireAppPermission` returns — for route tests that
 * exercise the operator gates (`middleware/operator-authz.ts`) without an Oxy.
 *
 * It behaves as the SDK middleware does with `respond: false`: a holder gets
 * `req.oxyAppPermissions` (the HUMAN operator as `operatorId`) and `next()`; a
 * non-holder, or a request with no person, gets `next(OxyAppPermissionError)`
 * with the SDK's own code, which the real gate renders. `holdings` answers who
 * holds what; returning `'unavailable'` models an Oxy that cannot answer.
 *
 * `fresh` is recorded per call so a test can assert that a write asked Oxy
 * fresh.
 */

import type { NextFunction, Request, Response } from 'express';
import { OxyAppPermissionError } from '@oxy.so/core/server';

export type FakeHoldings = (
  req: Request,
) => readonly string[] | 'unavailable' | 'no_session' | 'not_configured';

export interface FakeAppPermissions {
  readonly requireAppPermission: (
    permission: string,
    options?: { fresh?: boolean; respond?: boolean },
  ) => (req: Request, res: Response, next: NextFunction) => Promise<void>;
  /** Every gate decision, in order. */
  readonly calls: { permission: string; fresh: boolean; method: string }[];
}

/**
 * @param holdings who holds what (or why there is no answer).
 * @param operatorOf the HUMAN Oxy would resolve from the session — defaults to
 *   `req.userId`; a route test that stubs `getRequiredOxyUserId` passes its own.
 */
export function fakeAppPermissions(
  holdings: FakeHoldings,
  operatorOf: (req: Request) => string | undefined = (req) => req.userId,
): FakeAppPermissions {
  const calls: FakeAppPermissions['calls'] = [];
  return {
    calls,
    requireAppPermission:
      (permission, options = {}) =>
      async (req, _res, next) => {
        calls.push({ permission, fresh: options.fresh === true, method: req.method });
        const held = holdings(req);
        if (held === 'unavailable') {
          next(new OxyAppPermissionError('APP_PERMISSION_UNAVAILABLE', 'Oxy is unavailable'));
          return;
        }
        if (held === 'no_session') {
          next(new OxyAppPermissionError('APP_PERMISSION_SESSION_REQUIRED', 'No session'));
          return;
        }
        if (held === 'not_configured') {
          next(new OxyAppPermissionError('APP_PERMISSION_NOT_CONFIGURED', 'Unknown application'));
          return;
        }
        if (!held.includes(permission)) {
          next(
            new OxyAppPermissionError('APP_PERMISSION_DENIED', `Missing ${permission}`, {
              permission,
            }),
          );
          return;
        }
        const operatorId = operatorOf(req) ?? 'fake-operator';
        req.oxyAppPermissions = {
          applicationId: 'mercaria-test-app',
          operatorId,
          permissions: [...held],
          has: (key: string) => held.includes(key),
        };
        next();
      },
  };
}

/**
 * A request that has ALREADY passed an operator gate, for a service test that
 * calls `governanceActor` / `operatorId` directly instead of driving a route:
 * the two properties a gate leaves behind (`userId` from authentication,
 * `oxyAppPermissions` from the gate) and nothing else.
 */
export function gatedOperatorRequest(
  operatorId: string,
  held: readonly string[] = ['catalog.operate'],
): Request {
  return {
    userId: operatorId,
    oxyAppPermissions: {
      applicationId: 'mercaria-test-app',
      operatorId,
      permissions: [...held],
      has: (key: string) => held.includes(key),
    },
  } as unknown as Request;
}
