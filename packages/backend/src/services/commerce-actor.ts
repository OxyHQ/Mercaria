/**
 * `CommerceActor` — the ONE actor contract cart, checkout and order access
 * consume (ADR 0003 D1, #103).
 *
 * Defined once here, resolved once per request in
 * `middleware/commerce-actor.ts`, and consumed by services — never
 * re-derived in a controller. Downstream issues (#104 cart ownership, #105
 * inline checkout contact, #109 claiming) build on this union as-is.
 *
 * ## There is deliberately NO common `id` field
 *
 * A shared `actor.id` would be the exact aliasing this ADR exists to prevent:
 * code that forgets which kind it holds compiles anyway and passes a guest id
 * where an Oxy id is expected. With no common field, every consumer must
 * `switch` on `kind`, and the compiler enforces invariant I1 at every call
 * site.
 */

/** A verified Oxy account — the actor whenever Oxy auth succeeded (D2). */
export type OxyActor = {
  readonly kind: 'oxy';
  /** The verified Oxy account id from `createOxyAuthMiddleware`. */
  readonly oxyUserId: string;
  /**
   * A VALID guest credential presented alongside Oxy auth. Carried so the two
   * explicit endpoints that need it — cart merge (#104) and claim (#109) —
   * can prove possession. No other code may read it (D2).
   */
  readonly presentedGuestSessionId?: string;
};

/** A live guest session and nothing else — the signed-out buyer. */
export type GuestActor = {
  readonly kind: 'guest';
  /** The `guest_sessions` row id — never the token. */
  readonly guestSessionId: string;
  /** Which transport carried the credential; decides how a rotation returns (D9). */
  readonly transport: 'cookie' | 'header';
};

/** No credential at all, or only an invalid one (D2: invalid resolves as absent). */
export type AnonymousActor = { readonly kind: 'anonymous' };

/** The discriminated union every buyer-side authorization path takes. */
export type CommerceActor = OxyActor | GuestActor | AnonymousActor;

/**
 * The stable key actor-aware rate limits and idempotency claims hash on.
 *
 * Keys off the ACTOR, not the transport: the same guest is one bucket whether
 * the credential arrived by cookie or header, and an anonymous caller falls
 * back to the network dimension. The ids inside are internal row/account ids —
 * they feed Redis keys and never leave the backend.
 */
export function actorRateKey(actor: CommerceActor, clientIp: string): string {
  switch (actor.kind) {
    case 'oxy':
      return `oxy:${actor.oxyUserId}`;
    case 'guest':
      return `guest:${actor.guestSessionId}`;
    case 'anonymous':
      return `ip:${clientIp}`;
  }
}
