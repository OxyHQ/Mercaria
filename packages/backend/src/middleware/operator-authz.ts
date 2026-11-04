/**
 * The gates on Mercaria's operator desks — `/internal/*` — as APPLICATION ROLES.
 *
 * Who operates Mercaria is decided in Oxy (`~/Oxy/docs/application-roles.md`):
 * Mercaria declares one permission key per desk on its Oxy application, the
 * owning account's owners and admins grant them to people (append-only,
 * audited, never to themselves), and these gates ask Oxy — with the request's
 * own verified bearer — whether the HUMAN behind it holds the desk's key. There
 * is no allow-list of user ids in the environment and no local staff table.
 *
 * ## Seven desks, seven keys, because they are seven powers
 *
 * | Key | Desk |
 * |---|---|
 * | `payments.operate` | `/internal/payments/*` (fee schedules, retail-pricing policies, customer remedies) and `/internal/affiliate/*` |
 * | `catalog.operate` | every catalogue surface: commerce-graph, canonical catalogue, offers, matching, ingestion, backfill, attributes, condition, eBay, Awin, feed imports, offer freshness, product saves, price history/alerts/signals, search, search intent, SEO, taxonomy, navigation, proposals, governance, localization, metrics, pickup |
 * | `guest.operate` | `/internal/guest-commerce/*` (cart merge, portal, claims, buyer requests, P2P, governance) |
 * | `analytics.operate` | `/internal/analytics/*`, `/internal/discovery/*`, the merchant-demand acquisition pipeline |
 * | `retail.operate` | `/internal/retail-eligibility/*` — the compliance powers (recalls, resale authorizations, safety certificates) |
 * | `procurement.operate` | `/internal/supplier-preflight/*`, `/internal/procurement/*`, `/internal/retail-pilot/*`, `/internal/retail-reconciliation/*` — what Mercaria PAYS its suppliers |
 * | `referrals.operate` | `/internal/referrals/*` — pausing attribution stops partners earning; approving a payout batch is ADR 0005 D14's second pair of eyes |
 *
 * A new surface joins the key whose power it already shares; a new key is
 * justified only by a power none of these grants. Holding one key confers none
 * of the others — a payments operator is not thereby a compliance reviewer.
 *
 * ## What a caller is answered
 *
 * Every surface is mounted on every deployment. A non-holder — and a request
 * with no person in a session, including any service token — is answered 404,
 * as if the route did not exist, so an operator surface is never revealed. An
 * Oxy that cannot answer is 503 (never a "no", never cached); a deployment
 * whose application id Oxy does not know is 500. A read reuses an answer for at
 * most 30 s; every other method asks Oxy fresh, so a revoked operator cannot
 * make another change.
 *
 * Record {@link operatorId} as the actor: it is the PERSON even when they act
 * as their organization (`req.userId` is then the organization).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { appPermissionErrorStatus, OxyAppPermissionError } from '@oxy.so/core/server';
import { log } from '../lib/logger.js';
import { ErrorCodes, sendError } from '../utils/api-response.js';
import { oxyClient } from './auth.js';

/** The permission key each operator desk is gated on. Declared on Mercaria's Oxy application. */
export const OPERATOR_PERMISSIONS = Object.freeze({
  payments: 'payments.operate',
  catalog: 'catalog.operate',
  guest: 'guest.operate',
  analytics: 'analytics.operate',
  retail: 'retail.operate',
  procurement: 'procurement.operate',
  referrals: 'referrals.operate',
} as const);

export type OperatorPermission = (typeof OPERATOR_PERMISSIONS)[keyof typeof OPERATOR_PERMISSIONS];

/** Methods that change nothing, and so may reuse a recent answer. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A refusal, in Mercaria's envelope. 404 hides the surface; 503/500 are not refusals. */
function refuse(res: Response, refusal: OxyAppPermissionError): void {
  const status = appPermissionErrorStatus(refusal, 404);
  if (status === 503) {
    sendError(
      res,
      ErrorCodes.SERVICE_UNAVAILABLE,
      'Operator access cannot be checked right now',
      503,
    );
    return;
  }
  if (status === 500) {
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Operator access is not configured', 500);
    return;
  }
  sendError(res, ErrorCodes.NOT_FOUND, 'Not found', 404);
}

/**
 * The gate for one desk: `oxyClient.middleware.requireAppPermission`, fresh on
 * every write. Built on first use (a mount names it at import time), once per
 * desk.
 */
function operatorGate(permission: OperatorPermission): RequestHandler {
  let gates: { read: RequestHandler; write: RequestHandler } | undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    gates ??= {
      read: oxyClient.middleware.requireAppPermission(permission, { respond: false }),
      write: oxyClient.middleware.requireAppPermission(permission, {
        respond: false,
        fresh: true,
      }),
    };
    const gate = READ_METHODS.has(req.method) ? gates.read : gates.write;
    void gate(req, res, (error?: unknown) => {
      if (error === undefined) {
        next();
        return;
      }
      if (!(error instanceof OxyAppPermissionError)) {
        next(error);
        return;
      }
      if (error.code === 'APP_PERMISSION_DENIED') {
        log.general.warn(
          { oxyUserId: req.userId, permission, path: req.path, method: req.method },
          '[Operator] a non-holder reached an operator surface',
        );
      }
      refuse(res, error);
    });
  };
}

export const requirePaymentOperator = operatorGate(OPERATOR_PERMISSIONS.payments);
export const requireCatalogOperator = operatorGate(OPERATOR_PERMISSIONS.catalog);
export const requireGuestOperator = operatorGate(OPERATOR_PERMISSIONS.guest);
export const requireAnalyticsOperator = operatorGate(OPERATOR_PERMISSIONS.analytics);
export const requireRetailOperator = operatorGate(OPERATOR_PERMISSIONS.retail);
export const requireProcurementOperator = operatorGate(OPERATOR_PERMISSIONS.procurement);
export const requireReferralOperator = operatorGate(OPERATOR_PERMISSIONS.referrals);

/**
 * The operator who acted — the HUMAN Oxy resolved from the session, which is
 * the person even when they act as their organization. Only called behind one
 * of the gates above; a throw rather than a fallback, because the value is
 * stamped onto every repair, approval and kill switch as the ACTOR, and an
 * audit trail naming the wrong person is worse than one that failed to be
 * written.
 */
export function operatorId(req: Request): string {
  const operator = req.oxyAppPermissions?.operatorId;
  if (!operator) throw new Error('operatorId() called outside an operator gate');
  return operator;
}
