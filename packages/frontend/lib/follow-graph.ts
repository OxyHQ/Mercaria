/**
 * Mercaria's corner of Oxy's user-owned follow graph.
 *
 * The user owns the follow and Mercaria borrows it: following a store here is
 * the same relationship any other Oxy application would see, and switching it
 * off in Mercaria does not take it away from the user. Everything Mercaria has
 * to decide about that — its namespace, what following a store MEANS, and how a
 * store is named to the graph — is decided once, here.
 *
 * See `@oxyhq/services` `docs/FOLLOWS.md` for the design this joins.
 */

import type { OxyServices } from '@oxyhq/core';

/** Mercaria's namespace in the shared graph. Claimed once; ours permanently. */
const FOLLOW_NAMESPACE = 'mercaria';

/** The one kind Mercaria defines today: a shop a buyer wants to hear from. */
export const STORE_FOLLOW_KIND = 'mercaria.store';

/**
 * The origin every store URI is built from — the production apex, deliberately
 * NOT an environment-dependent value.
 *
 * A target's URI is its identity, so it has to name the same store from a
 * developer's laptop, from staging and from production. Deriving it from the
 * running host would make a follow taken in one environment a different row
 * from the same follow taken in another, which reads to the user as a follow
 * that silently did not stick.
 */
const STORE_URI_ORIGIN = 'https://mercaria.co';

/**
 * The canonical URI for a store, keyed on its immutable id rather than its
 * handle.
 *
 * A handle is the store's public route (`/stores/<handle>`) and a merchant can
 * change it. Keyed on the handle, a rename would mint a SECOND target that
 * nobody follows, silently emptying a shop's followers the day it rebrands —
 * so the prettier URI is the wrong identity. The id never moves.
 */
export function storeFollowUri(storeId: string): string {
  return `${STORE_URI_ORIGIN}/stores/${storeId}`;
}

/**
 * Claiming the namespace and declaring the kind, at most once per app session.
 *
 * Registration is user-delegated — the capability comes from the signed-in
 * user's session, so this cannot run at boot on a server and has to happen
 * lazily, on the way into the first screen that needs a target. Both calls are
 * idempotent server-side, so a repeat is harmless; the promise is cached to
 * avoid making them on every store page rather than for correctness.
 */
let registration: Promise<void> | undefined;

export function ensureStoreFollowKind(oxyServices: OxyServices): Promise<void> {
  // A rejected promise is dropped rather than cached: a transient failure
  // (offline, a session that landed a moment later) must not permanently
  // disable following for the rest of the session.
  registration ??= registerStoreFollowKind(oxyServices).catch((error: unknown) => {
    registration = undefined;
    throw error;
  });
  return registration;
}

async function registerStoreFollowKind(oxyServices: OxyServices): Promise<void> {
  await oxyServices.claimFollowNamespace(FOLLOW_NAMESPACE);
  await oxyServices.registerFollowKind({
    kind: STORE_FOLLOW_KIND,
    label: 'Store',
    capabilities: {
      // You subscribe to a shop to hear about new stock and sales; the graph
      // records that verb so every surface says the same word.
      verb: 'subscribe',
      // `aggregate` — a count, never the list.
      //
      // A follower count is social proof a shop has earned and wants shown, so
      // `private` would throw away something genuinely useful. But WHO follows
      // a shop is shopping behaviour: published as a list it says which named
      // people are in the market for what that shop sells, which is an
      // inference a marketplace has no business making public. `aggregate` is
      // the only option that keeps the selling point without the disclosure.
      reverse: 'aggregate',
      // A Mercaria store is not an actor on another server; nothing about
      // following one has to leave Oxy.
      federated: false,
    },
  });
}
