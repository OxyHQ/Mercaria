/**
 * The Oxy client a PUBLIC seller read should use, and why it is not always the
 * shared one.
 *
 * Mercaria's process-wide `oxyClient` carries no user session: it is the right
 * client for "what does everyone see", and the wrong one for anything a viewer's
 * own relationships change. Blocking is exactly that — whether a seller is
 * visible to *this* caller is a fact about Oxy's account graph that only the
 * caller's own credential can be asked.
 *
 * So a signed-in read builds a SHORT-LIVED client bound to the request's own
 * bearer. Never `oxyClient.setTokens(...)`: the shared instance is a
 * module-level singleton and mutating its token per request would leak one
 * caller's session into another's concurrent read — the classic shared-mutable
 * bug, and here it would be an authentication one.
 *
 * This is the `services/publishAsAccount.ts` rule Mention established, one
 * domain over: identity questions are answered with the CALLER's own bearer and
 * never with a service credential, because a service token cannot prove the
 * user asked.
 */

import { OxyServices } from '@oxyhq/core';
import type { User } from '@oxyhq/core';
import { oxyClient } from '../../middleware/auth.js';
import { log } from '../../lib/logger.js';

/** Where the shared client points. Kept in one place so the two agree. */
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

/** The signed-in caller of a public read, when there is one. */
export interface SellerProfileViewer {
  oxyUserId: string;
  accessToken: string;
}

/**
 * Build the viewer's own Oxy client, or reuse the shared anonymous one.
 *
 * A new `OxyServices` per signed-in request is deliberate and its cost is
 * stated: no SDK response cache is shared between requests, so a seller page
 * costs one identity read and one viewer-graph read. That is the price of
 * asking a viewer-scoped question with the viewer's own credential, and this
 * surface is metered on its own rate-limit bucket for it.
 */
function clientFor(viewer: SellerProfileViewer | null): OxyServices {
  if (!viewer) return oxyClient;
  const client = new OxyServices({ baseURL: OXY_API_URL });
  client.setTokens(viewer.accessToken);
  return client;
}

/**
 * Read a seller's Oxy account through the strongest credential available.
 *
 * `null` means "there is no such account, as far as this caller is concerned",
 * and it deliberately conflates several causes — deleted, suspended by Oxy,
 * never existed, or hidden from this viewer by Oxy's own enforcement. The
 * caller answers all of them with the same 404, because a response that told
 * them apart would be an oracle: a blocked caller would learn they had been
 * blocked, and a probe would learn which ids exist.
 *
 * A transient failure resolves the same way, which is the honest trade: a
 * profile page that 404s during an Oxy outage is a worse experience than one
 * that renders, and it is the only one that cannot show a person who has since
 * been erased.
 */
export async function readSellerOxyUser(
  oxyUserId: string,
  viewer: SellerProfileViewer | null,
): Promise<User | null> {
  try {
    // `cache: false` on the viewer path: a block taken thirty seconds ago must
    // take effect on the next page load, and a five-minute TTL is long enough
    // for the person who blocked to see the page again and believe it failed.
    return await clientFor(viewer).getUserById(oxyUserId, viewer ? { cache: false } : undefined);
  } catch (err) {
    log.general.warn({ err, oxyUserId }, '[Sellers] Oxy profile unresolvable — treated as absent');
    return null;
  }
}

/**
 * Whether this viewer has blocked this seller.
 *
 * ONE round trip (`getViewerGraph`) rather than three, and ids only — Mercaria
 * never receives, stores or logs the viewer's block LIST, it asks a membership
 * question and keeps the boolean.
 *
 * Only the direction a viewer's credential can observe. The reverse — the
 * seller having blocked the viewer — is Oxy's to enforce on the profile read
 * itself, which is why {@link readSellerOxyUser} uses the viewer's own bearer
 * rather than a service one: whatever Oxy withholds from this caller, Mercaria
 * withholds too, without having to model somebody else's block list.
 *
 * Fails OPEN on an error. A viewer-graph outage must not hide every seller on
 * the marketplace, and the consequence of the open failure is bounded: the
 * viewer sees a public page they could have seen while signed out.
 */
export async function viewerHasBlocked(
  viewer: SellerProfileViewer | null,
  oxyUserId: string,
): Promise<boolean> {
  if (!viewer) return false;
  if (viewer.oxyUserId === oxyUserId) return false;
  try {
    const graph = await clientFor(viewer).getViewerGraph();
    return graph.blockedIds.includes(oxyUserId);
  } catch (err) {
    log.general.warn({ err }, '[Sellers] viewer graph unavailable — block check skipped');
    return false;
  }
}
