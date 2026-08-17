/**
 * Mercaria's corner of Oxy's user-owned follow graph.
 *
 * The user owns the follow and Mercaria borrows it: following a store here is
 * the same relationship any other Oxy application would see, and switching it
 * off in Mercaria does not take it away from the user. Everything Mercaria has
 * to decide about that — its namespace, what following a store MEANS, and how a
 * store is named to the graph — is decided once, here.
 *
 * ## TWO followable things, and only ONE of them is Mercaria's to name
 *
 * A native `Store` is a Mercaria-local organisation with its own handle, brand
 * and policies and NO Oxy account behind it, so Mercaria defines
 * `mercaria.store` in its own namespace at its own URI.
 *
 * A P2P SELLER is a person — an Oxy account (`Seller.oxyUserId`) — and is
 * followed under the PLATFORM kind `oxy.user` at Oxy's own canonical user URI.
 * Mercaria neither claims the `oxy` namespace nor registers that kind (the
 * registry would refuse: `namespace_not_owned`), and nothing here may define a
 * `mercaria.*` kind for a person. A `follow_targets` row carries ONE kind and
 * `ensureFollowTarget` is idempotent on the URI, so whoever registers a URI
 * first fixes its kind permanently: a person registered under `mercaria.*` at a
 * `mercaria.co` URI would have their followers split from the identity every
 * other Oxy app already follows, with no repair short of a data migration.
 * `SELLER_FORBIDDEN_FOLLOW_KINDS` in `@mercaria/shared-types` names that
 * prohibition as a value, and `seller-identity-isolation.test.ts` scans this
 * file and fails the build on it.
 *
 * See `@oxyhq/services` `docs/FOLLOWS.md` for the design this joins.
 */

import type { OxyServices } from '@oxyhq/core';

/** Mercaria's namespace in the shared graph. Claimed once; ours permanently. */
const FOLLOW_NAMESPACE = 'mercaria';

/**
 * The one kind Mercaria defines, today and by design: a shop a buyer wants to
 * hear from.
 *
 * A PERSON's kind is not here and must never be added — `SELLER_FOLLOW_KIND`
 * (`oxy.user`) and `oxyUserFollowUri` live in `@mercaria/shared-types`, are
 * imported directly by `lib/hooks/use-seller-follow.ts`, and belong to the
 * platform rather than to this namespace.
 */
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

/**
 * The follow kind's display label, as written into Oxy's GLOBAL follow registry.
 *
 * Deliberately NOT localized, and not a `t()` call. This value is sent to Oxy
 * and stored once, server-side, for every surface in the ecosystem — so
 * resolving it against the device locale would mean whichever device happened
 * to register last writes ITS language into a registry every other Oxy app
 * reads. That is a cross-app data write wearing a translation's clothing.
 *
 * Localizing the word a Mercaria SCREEN shows is a different thing and is done
 * at those screens' own render sites.
 */
const STORE_FOLLOW_KIND_REGISTRY_LABEL = 'Store';

async function registerStoreFollowKind(oxyServices: OxyServices): Promise<void> {
  await oxyServices.claimFollowNamespace(FOLLOW_NAMESPACE);
  await oxyServices.registerFollowKind({
    kind: STORE_FOLLOW_KIND,
    label: STORE_FOLLOW_KIND_REGISTRY_LABEL,
    capabilities: {
      // NOT `subscribe`, which would be the natural word anywhere else:
      // "Subscribe" is already taken in Mercaria for a recurring PURCHASE
      // plan (the product page's purchase options render one), so a store
      // control using it would sit on the same screen as a billing choice
      // wearing the same word. The graph records the verb, so every surface
      // says "Follow".
      verb: 'follow',
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
