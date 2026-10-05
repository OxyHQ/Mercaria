/**
 * The two questions Mercaria asks Oxy's account graph, with the CALLER's own
 * bearer (ADR 0012): "what is my role in this account?" and "which accounts do
 * I reach, and in which role?".
 *
 * Asked with the caller's bearer because there is no service-token endpoint
 * that answers membership, and a service token could not prove the person
 * asked anyway — `sellers/viewer-oxy-client.ts` states the same rule for
 * seller reads. Each call builds a SHORT-LIVED client: the shared `oxyClient`
 * is a process-wide singleton, and setting a caller's token on it would leak
 * one caller's session into another's concurrent request.
 *
 * Oxy anchors both answers on the HUMAN operator: a person who switched into
 * an organization authenticates as it, and Oxy still resolves their access as
 * themselves. That is the answer Mercaria wants for every store question.
 *
 * Outcomes are translated here, once: a 403 or 404 is an ANSWER (no role); a
 * 401 is the caller's to fix by signing in again; anything else is Oxy being
 * unavailable, and the caller FAILS CLOSED with a 503.
 */

import { OxyApiError, OxyServices, type AccountNode, type AccountRole } from '@oxy.so/core';
import { MercariaError, serviceUnavailable } from '../lib/errors/error-codes.js';
import { ErrorCodes } from '../utils/api-response.js';
import { log } from '../lib/logger.js';

/** Where the shared Oxy client points; a per-caller client points at the same API. */
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

function clientFor(accessToken: string): OxyServices {
  const client = new OxyServices({ baseURL: OXY_API_URL });
  client.session.setAccessToken(accessToken);
  return client;
}

/** The caller's role in an account node, as Oxy resolved it. */
function roleOf(node: AccountNode): AccountRole | null {
  // `self` is the caller's own personal account: implicit ownership, no row.
  if (node.relationship === 'self') return 'owner';
  return node.callerMembership?.role ?? null;
}

/** `null` for an answer that means "no access"; throws for everything else. */
function translate(err: unknown, context: Record<string, unknown>): null {
  if (err instanceof OxyApiError && (err.status === 403 || err.status === 404)) return null;
  if (err instanceof OxyApiError && err.status === 401) {
    throw new MercariaError({
      code: ErrorCodes.UNAUTHORIZED,
      message: 'Your Oxy session is no longer valid. Sign in again.',
    });
  }
  log.general.warn({ err, ...context }, '[OxyAccountGraph] Oxy account graph unavailable');
  throw serviceUnavailable(
    'Store access cannot be checked right now because Oxy is unavailable. Try again shortly.',
  );
}

/** The caller's role in one Oxy account, or `null` when they hold none. */
export async function readCallerAccountRole(
  accessToken: string,
  accountId: string,
): Promise<AccountRole | null> {
  try {
    return roleOf(await clientFor(accessToken).accounts.get(accountId));
  } catch (err) {
    return translate(err, { accountId });
  }
}

/** Every account the caller reaches, with their role in each — one `GET /accounts`. */
export async function listCallerAccountRoles(accessToken: string): Promise<Map<string, AccountRole>> {
  const roles = new Map<string, AccountRole>();
  let nodes: AccountNode[];
  try {
    nodes = await clientFor(accessToken).accounts.list();
  } catch (err) {
    translate(err, { op: 'list' });
    return roles;
  }
  for (const node of nodes) {
    const role = roleOf(node);
    if (role !== null) roles.set(node.accountId, role);
  }
  return roles;
}
