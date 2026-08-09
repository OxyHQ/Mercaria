/**
 * Who an analytics event is about — and, far more importantly, who it is NOT
 * about (#77 "Identity and correlation rules", ADR 0003 I12).
 *
 * This module is the ONE translation from a `CommerceActor` to an analytics
 * identity. Every rule the issue states is enforced here or by a CHECK this
 * module's output has to satisfy, and each has its own test:
 *
 *  1. **A pseudonymous session is not an Oxy user.** The two are separate
 *     fields on {@link AnalyticsIdentity}, a discriminated union with no common
 *     `id` — the same device `CommerceActor` uses, for the same reason: code
 *     that forgets which it holds must not compile.
 *  2. **A guest checkout is not a durable person profile.** Nothing here reads
 *     or writes `guest_checkouts`, and the pseudonym is derived from the
 *     SESSION handle, which is itself purged on ADR 0003 D11's clock.
 *  3. **Email hash, phone, card fingerprint, provider customer, wallet, IP and
 *     device fingerprint are never a user id.** None of them is a parameter of
 *     any function in this file. There is nothing to pass them to.
 *  4. **Separate guest checkouts cannot be joined by matching contact or
 *     payment details.** Same reason: the derivation takes a session handle and
 *     nothing else, so two checkouts by one card are two unrelated pseudonyms.
 *  5. **A completed #109 claim connects only that checkout.** The seam is
 *     `claim-seam.ts`; this module has no back-fill path and no way to rewrite a
 *     stored pseudonym, which is what "cannot retroactively absorb unrelated
 *     guest activity" needs to be structural rather than promised.
 *
 * ## The derivation, and why it rotates
 *
 * `pseudonymousSessionId = sha256(epochSalt || ':' || handle)`, truncated to 32
 * hex characters. The salt is a 32-byte CSPRNG secret held in
 * `analytics_pseudonym_salts`, rotated on a schedule and then DELETED by the
 * shared expiry sweep. Three properties follow, and the third is the one that
 * matters:
 *
 *  - It is not reversible, so a leaked event table yields no session handles.
 *  - It is not GUESSABLE, unlike a plain hash of a uuid: without the salt an
 *    attacker holding a stolen guest token still cannot confirm which rows are
 *    that session's.
 *  - After the salt's deletion nobody — including Mercaria, including a lawful
 *    request — can recompute an old epoch's value, so activity either side of a
 *    rotation cannot be joined even in principle. That is what makes
 *    "short-lived pseudonymous session id" (envelope field 4) true rather than
 *    aspirational.
 *
 * ## Anonymous browsing gets a CLIENT-supplied surface handle
 *
 * A signed-out visitor with no cart has no server-side session at all — ADR
 * 0003 T10 makes issuance lazy precisely so browsing creates no row. The
 * pseudonym for such a visitor is derived from an opaque, client-minted surface
 * session id sent in `X-Mercaria-Analytics-Session`. It is not a credential, it
 * authorizes nothing, and it is hashed under the same rotating salt before
 * storage, so a client that forged one gains only the ability to mislabel its
 * own sessions.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AnalyticsActorKind } from '@mercaria/shared-types';
import type { CommerceActor } from '../commerce-actor.js';
import {
  readCurrentSalt,
  rotateSalt,
  type AnalyticsPseudonymSalt,
} from '../../db/analytics/pseudonymSaltRepository.js';
import { config } from '../../config/index.js';
import { RETENTION_SECONDS } from '../../db/expiryTargets.js';
import { log } from '../../lib/logger.js';

/**
 * A verified Oxy account, carried ONLY when consent permits (envelope field 3).
 */
export interface OxyAnalyticsIdentity {
  readonly kind: 'oxy';
  readonly oxyUserId: string;
}

/** A rotating, one-way session dimension. Never a person, never reversible. */
export interface PseudonymousAnalyticsIdentity {
  readonly kind: 'pseudonymous';
  /** Which actor kind it stands for — `guest` or `anonymous`, never `oxy`. */
  readonly actorKind: Exclude<AnalyticsActorKind, 'oxy'>;
  readonly pseudonymousSessionId: string;
  readonly pseudonymEpoch: number;
}

/**
 * No identity at all: an actor with no handle to hash, or an Oxy actor whose
 * consent was denied.
 *
 * A real, storable state — the event is still worth counting, and refusing to
 * record it would make a consent-denying cohort invisible in exactly the
 * denominators that need to know how big it is.
 */
export interface UnidentifiedAnalyticsIdentity {
  readonly kind: 'unidentified';
  readonly actorKind: AnalyticsActorKind;
}

/**
 * The analytics identity union.
 *
 * NO common `id` field, deliberately — the `CommerceActor` device (ADR 0003
 * D1). A shared `identity.id` is exactly the aliasing that lets a pseudonym
 * reach an `oxy_user_id` column; with no such field, the compiler forces a
 * `switch` at the one call site that writes those columns.
 */
export type AnalyticsIdentity =
  | OxyAnalyticsIdentity
  | PseudonymousAnalyticsIdentity
  | UnidentifiedAnalyticsIdentity;

/** The actor kind an analytics row records, from the commerce actor. */
export function analyticsActorKind(actor: CommerceActor): AnalyticsActorKind {
  switch (actor.kind) {
    case 'oxy':
      return 'oxy';
    case 'guest':
      return 'guest';
    case 'anonymous':
      return 'anonymous';
  }
}

/**
 * The in-process cache of the current epoch.
 *
 * Read on every event, so a database round trip per event would put the sink's
 * whole point at risk. The cache is refreshed on a timer bound to the rotation
 * interval and on a miss; a task holding a stale epoch for a few seconds after
 * a rotation writes events under the previous salt, which is correct — the
 * epoch is stored beside the hash, so nothing is ambiguous.
 */
let cachedSalt: AnalyticsPseudonymSalt | undefined;
let cachedAt = 0;

/** How long the cached epoch is trusted before it is re-read. */
const SALT_CACHE_TTL_MS = 60_000;

/** Reset the cache. Exported for tests and for the rotation path. */
export function resetPseudonymSaltCache(): void {
  cachedSalt = undefined;
  cachedAt = 0;
}

/**
 * The salt in force, opening the first epoch if none exists.
 *
 * Opening on demand rather than in a migration: a salt is a SECRET and a
 * migration file is committed source, so the first epoch has to be minted by
 * running code. A deployment that never collects anything therefore never mints
 * one, which is the correct amount of secret material to hold.
 */
async function currentSalt(now: Date): Promise<AnalyticsPseudonymSalt> {
  if (cachedSalt && now.getTime() - cachedAt < SALT_CACHE_TTL_MS) {
    return cachedSalt;
  }

  const existing = await readCurrentSalt();
  if (existing && !saltRotationDue(existing, now)) {
    cachedSalt = existing;
    cachedAt = now.getTime();
    return existing;
  }

  const rotated = await rotateSalt({
    salt: randomBytes(32).toString('hex'),
    now,
    // The retirement clock starts when the epoch OPENS, not when it closes:
    // measuring from closure would let a long-lived epoch keep its salt for the
    // retention period on top of its own lifetime, which is the shape that
    // quietly turns a 45-day guarantee into a 90-day one.
    expiresAt: new Date(now.getTime() + RETENTION_SECONDS.analyticsSalt * 1000),
  });
  cachedSalt = rotated;
  cachedAt = now.getTime();
  log.general.info(
    { epoch: rotated.epoch },
    '[Analytics] opened a new pseudonym salt epoch; the previous one is now unrecomputable ' +
      'once the expiry sweep deletes it',
  );
  return rotated;
}

/** Whether the epoch in force has outlived the configured rotation interval. */
function saltRotationDue(salt: AnalyticsPseudonymSalt, now: Date): boolean {
  const ageMs = now.getTime() - salt.activeFrom.getTime();
  return ageMs >= config.analytics.pseudonymRotationHours * 3600_000;
}

/**
 * Derive the analytics identity for one event.
 *
 * @param actor The resolved commerce actor.
 * @param surfaceSessionId An opaque client-minted handle for an anonymous
 *   visitor. Ignored for every other actor kind — an Oxy or guest actor has a
 *   server-side handle, and preferring a client's would let a client merge two
 *   sessions it does not own.
 * @param consentPermitsIdentity Whether the Oxy account id may be recorded
 *   (envelope field 3's "and permitted").
 */
export async function deriveAnalyticsIdentity(input: {
  actor: CommerceActor;
  surfaceSessionId?: string;
  consentPermitsIdentity: boolean;
  now: Date;
}): Promise<AnalyticsIdentity> {
  const { actor, consentPermitsIdentity, now } = input;

  if (actor.kind === 'oxy') {
    // Consent denied: the event is still counted, and it is counted with NO
    // identity at all rather than with a pseudonym. Hashing an Oxy id into the
    // pseudonym space would create a stable per-account identifier under a
    // different name, which is the exact substitution rule 3 forbids.
    return consentPermitsIdentity
      ? { kind: 'oxy', oxyUserId: actor.oxyUserId }
      : { kind: 'unidentified', actorKind: 'oxy' };
  }

  const handle = actor.kind === 'guest' ? actor.guestSessionId : input.surfaceSessionId;
  if (handle === undefined || handle === '') {
    return { kind: 'unidentified', actorKind: analyticsActorKind(actor) };
  }

  const salt = await currentSalt(now);
  return {
    kind: 'pseudonymous',
    actorKind: actor.kind === 'guest' ? 'guest' : 'anonymous',
    pseudonymousSessionId: hashHandle(salt.salt, handle),
    pseudonymEpoch: salt.epoch,
  };
}

/**
 * The hash itself.
 *
 * Truncated to 32 hex characters (128 bits): far beyond collision range for any
 * plausible session volume, and short enough that the column does not double
 * the row width of the highest-volume table in the schema. Exported so the
 * experiment assignment can derive the same unit reference without a second
 * spelling of the construction.
 */
export function hashHandle(salt: string, handle: string): string {
  return createHash('sha256').update(`${salt}:${handle}`).digest('hex').slice(0, 32);
}

/**
 * Whether a supplied surface session id is well formed.
 *
 * Bounded because it is client-supplied and reaches a hash: an unbounded string
 * would let a caller spend our CPU, and a non-opaque one (an email, a phone
 * number) would put contact data in front of a hash function that is about to
 * write its output next to commerce events. The shape refuses anything but an
 * opaque token, so a client that sent an address gets its event recorded
 * unidentified rather than pseudonymised under it.
 */
export function isWellFormedSurfaceSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

/**
 * Constant-time comparison of two pseudonyms.
 *
 * Used only by the operator consistency check. Not a security boundary — both
 * sides are already stored — but comparing derived identifiers with `===`
 * anywhere in this domain is the habit that eventually gets copied somewhere it
 * matters, and the codebase already refuses `!==` on secrets elsewhere.
 */
export function pseudonymsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
