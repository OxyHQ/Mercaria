/**
 * The two PLATFORM proofs (#83 methods 3 and 4) — signed account proof from an
 * existing connection, and a WooCommerce plugin / channel-key proof scoped to
 * one site and one connection.
 *
 * ## Reusing the connector's OAuth round trip rather than inventing a second one
 *
 * A merchant's control of a Shopify shop is exactly what `/channels/oauth`
 * already establishes: the platform authenticates the merchant, signs the
 * callback, and `connectAndVerify` stores the credential it issued. Building a
 * second authorization flow — a second redirect URI to register with every
 * platform, a second state token, a second callback to keep in lockstep —
 * would give a WEAKER proof of the same fact, because there would then be two
 * places a shop's identity is established and they could disagree.
 *
 * So this method consumes that flow's RESULT: a `connections` row that is
 * `connected` and carries a credential. What the claim adds on top is the
 * binding the issue asks for (security control 4, "bind OAuth state to claim,
 * user and merchant"): the claim's own challenge is a signed, expiring,
 * single-use record naming `{claim, claimant, merchant, connection}`, and the
 * proof is refused unless the caller is the claimant AND holds
 * `store:manage` on the store that owns the connection.
 *
 * `store:manage` and not `channels:write`, deliberately: an admin runs the
 * whole business and cannot reconfigure the store itself, and asserting the
 * merchant's identity to the outside world is the same class of act as
 * renaming the store or transferring its ownership. It is the permission the
 * payment-onboarding routes chose for the same reason.
 *
 * ## The channel key is verified, never trusted
 *
 * `channel-key.service.verifyKey` is the only accept decision — a constant-time
 * compare of the full digest, never a database equality. A key that verifies
 * but is NOT bound to a connection proves possession of a store credential and
 * nothing about a site, so it is refused: issue method 4 says "scoped to a site
 * and connection", and an unbound key has neither.
 */

import type { ConnectorProviderId } from '@mercaria/shared-types';
import {
  findConnectionById,
  type ConnectionRow,
} from '../../db/connectors/connectionRepository.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import { effectivePermissions } from '../../middleware/store-authz.js';
import { verifyKey } from '../channel-key.service.js';
import { normalizeDomain } from '../commerce-graph/merchant.service.js';
import type { ClaimProofSubject } from './claim-scope.js';
import { forbidden, notFound, validationError } from '../../lib/errors/error-codes.js';

/**
 * The permission a claimant must hold on the store that owns the connection.
 * See the docblock for why it is the store-level one and not `channels:write`.
 */
const REQUIRED_STORE_PERMISSION = 'store:manage';

/**
 * The proof subject a connection establishes.
 *
 * The shop domain is normalized through the ONE domain normalizer the graph
 * uses, so a platform reporting `Example-Shop.MyShopify.com` yields the same
 * key `merchant_domains` and `storefronts.domain` are stored under. A
 * connection with an unusable host contributes `null` rather than a
 * URL-shaped string no scope comparison would ever match.
 */
export function connectionProofSubject(connection: ConnectionRow): ClaimProofSubject {
  let shopDomain: string | null = null;
  if (connection.shopDomain !== null && connection.shopDomain.trim() !== '') {
    try {
      shopDomain = normalizeDomain(connection.shopDomain);
    } catch {
      // An unparseable host is absence, not a failure: the proof still covers
      // the shop by `(provider, externalShopId)`, which is the identity the
      // storefront convergence key is built on.
      shopDomain = null;
    }
  }
  return {
    kind: 'platform_connection',
    provider: connection.provider,
    externalShopId: connection.externalShopId,
    shopDomain,
  };
}

/**
 * Resolve a connection the claimant is entitled to prove with.
 *
 * Refusals, each a distinct answer, and none of them able to tell an
 * unauthorized caller which of the three it hit for someone else's connection:
 * an unknown id and a connection whose store the caller cannot manage both end
 * as a 404, because a 403 would confirm the id exists.
 */
export async function resolveClaimantConnection(params: {
  connectionId: string;
  claimantOxyUserId: string;
}): Promise<ConnectionRow> {
  const connection = await findConnectionById(params.connectionId);
  if (!connection) {
    throw notFound('Connection not found');
  }

  const store = await findStoreById(connection.storeId);
  const membership = store?.members.find((m) => m.oxyUserId === params.claimantOxyUserId);
  if (!store || !membership) {
    // Deliberately the same answer as "no such connection": telling a stranger
    // that an id exists but belongs to a store they cannot manage is the
    // enumeration this refusal exists to prevent.
    throw notFound('Connection not found');
  }
  if (!effectivePermissions(membership).has(REQUIRED_STORE_PERMISSION)) {
    // The caller IS a member, so the connection's existence is not a secret
    // from them — an honest 403 is safe here and a 404 would be a lie they
    // could disprove from the dashboard.
    throw forbidden(
      'Proving a merchant claim with a platform connection requires the store:manage permission.',
    );
  }
  if (connection.status !== 'connected' || !connection.hasCredentials) {
    throw validationError(
      'That platform connection is not currently authorized. Reconnect it and try again.',
    );
  }
  return connection;
}

/**
 * Turn a presented channel key into the connection it is bound to.
 *
 * Three refusals, and the first two are the same message on purpose: an
 * unknown key and a revoked key must be indistinguishable, or the endpoint
 * becomes an oracle for which keys once existed.
 */
export async function resolveChannelKeyConnection(params: {
  channelKey: string;
  claimantOxyUserId: string;
}): Promise<ConnectionRow> {
  const verified = await verifyKey(params.channelKey);
  if (!verified) {
    throw validationError('That channel key is not valid.');
  }
  if (verified.connectionId === undefined) {
    // Issue method 4 is "scoped to a site AND connection". A store-wide key
    // proves possession of a Mercaria credential and says nothing about a
    // site, so accepting it would let any staff member with an ingest key
    // claim any merchant their store can name.
    throw validationError(
      'That channel key is not bound to a connection, so it proves nothing about a site.',
    );
  }
  // The key proves possession; the membership check proves the presenter is
  // entitled to speak for the store. Both, because a leaked key must not be
  // enough on its own to move a merchant's identity.
  return resolveClaimantConnection({
    connectionId: verified.connectionId,
    claimantOxyUserId: params.claimantOxyUserId,
  });
}

/** The connector provider ids a storefront's `provider` column may echo. */
export function connectionProviderId(connection: ConnectionRow): ConnectorProviderId {
  return connection.provider;
}
