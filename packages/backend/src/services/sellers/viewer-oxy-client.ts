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
 * So a signed-in read goes through `oxyClient.withUser` — an isolated client
 * bound to the request's own bearer, caching nothing, disposed when the read
 * settles. Never `oxyClient.setTokens(...)`: the shared instance is a
 * module-level singleton and mutating its token per request would leak one
 * caller's session into another's concurrent read — the classic shared-mutable
 * bug, and here it would be an authentication one.
 *
 * This is the `services/publishAsAccount.ts` rule Mention established, one
 * domain over: identity questions are answered with the CALLER's own bearer and
 * never with a service credential, because a service token cannot prove the
 * user asked.
 */

import type { User } from '@oxy.so/core';
import { oxyClient } from '../../middleware/auth.js';
import { log } from '../../lib/logger.js';

/** The signed-in caller of a public read, when there is one. */
export interface SellerProfileViewer {
  oxyUserId: string;
  accessToken: string;
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
    // The viewer's read caches nothing (a user client never does): a block
    // taken thirty seconds ago must take effect on the next page load. A
    // signed-out read is everyone's answer and uses the shared client.
    return viewer
      ? await oxyClient.withUser(viewer.accessToken, (user) => user.users.get(oxyUserId))
      : await oxyClient.users.get(oxyUserId);
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
    const graph = await oxyClient.withUser(viewer.accessToken, (user) =>
      user.follows.viewerGraph(),
    );
    return graph.blockedIds.includes(oxyUserId);
  } catch (err) {
    log.general.warn({ err }, '[Sellers] viewer graph unavailable — block check skipped');
    return false;
  }
}
