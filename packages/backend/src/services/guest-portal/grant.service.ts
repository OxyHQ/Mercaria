/**
 * Minting, exchanging, resolving and revoking guest portal credentials
 * (#108, ADR 0003 D5/D9/D17).
 *
 * ## Three ways a credential comes into existence, and no fourth
 *
 *  - {@link mintPostCheckoutGrant} — the device that PLACED the group asks for
 *    one, presenting the guest session whose contact record the group names.
 *    Proof of a device: `tracking:read` and nothing else.
 *  - {@link mintExchangeGrant} — the send path mints one INSIDE the transaction
 *    that sends a link-bearing message. Proof of nothing yet; it confers proof.
 *  - {@link exchangeMagicLinkToken} — consuming an exchange mints the durable
 *    portal credential. Proof of an inbox: the full verified scope set.
 *
 * There is deliberately no "grant access to this group" function an operator,
 * a support tool or a future issue could call. ADR 0003 T15 permits a support
 * agent to trigger a RE-SEND to the stored contact and nothing more, so the
 * operator surface enqueues a message and the buyer's own inbox mints the
 * credential — which means no Mercaria employee is ever in possession of one.
 *
 * ## Why the confirmation grant is PULLED and not pushed
 *
 * ADR 0003 D5 says checkout completion mints the `post_checkout` grant. It
 * cannot be minted by the completion itself: that runs in the payment outbox,
 * minutes after the buyer's request ended and with nobody there to receive a
 * bearer token — a token minted into a handler is a token minted into a log.
 * So the WHEN moved and nothing else did: the grant is exactly D5's row, with
 * D5's origin and D5's scope, minted at the first moment there is a client to
 * hand it to. The consequence is a good one — the confirmation view works
 * before the webhook arrives, which is #108 initial-confirmation rule 3 and
 * test case 11 in one.
 *
 * ## Rejection is UNIFORM
 *
 * Malformed, unknown, expired, consumed and revoked credentials all resolve to
 * the same `null` (magic-link rule 8). The DISTINCTION lives only in the
 * structured security log, which carries grant row ids and checkout group ids —
 * never a token, in any form, and never an email (magic-link rule 10).
 */

import { and, eq } from 'drizzle-orm';
import type {
  GuestOrderExchangeReason,
  GuestOrderScope,
  GuestPortalSessionState,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { guestCheckouts } from '../../db/schema/guests.js';
import {
  consumeExchangeGrant,
  countLivePostCheckoutGrants,
  findLiveGrantByTokenHash,
  insertGuestOrderAccessGrant,
  revokeGrant,
  revokeGroupGrants,
  touchGrantLastUsed,
  type GuestOrderAccessGrantRow,
} from '../../db/guestPortal/grantRepository.js';
import { setGuestCheckoutVerificationStage } from '../../db/guests/guestCheckoutRepository.js';
import { log } from '../../lib/logger.js';
import {
  hashPortalToken,
  mintExchangeToken,
  mintPortalToken,
  portalTokenMatches,
  readExchangeToken,
  readPortalToken,
} from './grant-token.js';
import { resolveExchangeScopes, resolveGrantScopes } from './scopes.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** `last_used_at` is written at ≥ 60 s granularity — the `guest_sessions` bound. */
export const PORTAL_LAST_USED_GRANULARITY_MS = 60_000;

/**
 * How long a spent exchange row is kept before the retention sweep takes it —
 * ADR 0003 D11's "exchange rows purged 24 h after expiry".
 */
const EXCHANGE_PURGE_GRACE_MS = 24 * 60 * 60 * 1_000;

/**
 * How long a portal grant is kept past expiry — D11's 90 days.
 *
 * Longer than the credential's own life on purpose: the row IS the audit trail
 * of who could reach which checkout group, and there is no second table
 * recording it. An incident three weeks after a leaked link is exactly when
 * somebody needs to read one.
 */
const PORTAL_PURGE_GRACE_MS = 90 * DAY_MS;

/**
 * How many live `post_checkout` grants one group may have at once.
 *
 * A cap rather than a unique index: a buyer legitimately wants the confirmation
 * on the phone they paid from AND the laptop they were browsing on, so "exactly
 * one" is wrong. Unbounded is worse — one cart credential would be a credential
 * factory — and five is enough devices that nobody meets it by accident.
 */
export const MAX_LIVE_POST_CHECKOUT_GRANTS = 5;

/** A minted credential and the state its holder is shown. Plaintext, once. */
export interface IssuedPortalCredential {
  /** The plaintext bearer token. Carried in a cookie or a response header ONLY. */
  readonly token: string;
  /** The safe projection of what was minted. Carries no secret. */
  readonly state: GuestPortalSessionState;
  /** The row, for callers that need its ids (the exchange, the operator audit). */
  readonly grant: GuestOrderAccessGrantRow;
}

/** Why {@link mintPostCheckoutGrant} refused. Bounded, so a route can map it. */
export type PostCheckoutGrantRefusal =
  /** The session presented did not place this group — or the group does not exist. */
  | 'not_this_sessions_checkout'
  /** The group already has as many live confirmation credentials as it may. */
  | 'too_many_live_grants';

/**
 * The outcome of a confirmation mint. A discriminated union, so a caller must
 * narrow — and discriminated on a STRING for the reason
 * `GuestMessageDeliveryResult` states: this package compiles with
 * `strict: false`, under which a boolean discriminant does not narrow.
 */
export type PostCheckoutGrantResult =
  | { readonly status: 'minted'; readonly credential: IssuedPortalCredential }
  | { readonly status: 'refused'; readonly refusal: PostCheckoutGrantRefusal };

/**
 * Mint the `post_checkout` credential for the device that placed a group.
 *
 * The authorization is the JOIN, not a comparison: the group's contact row must
 * name the presented guest session. A session that placed nothing, or placed
 * something else, matches no row and is refused before anything is created —
 * and because the refusal is the same for "not yours" and "does not exist", a
 * caller cannot use this to discover that a group id is real.
 *
 * This does NOT make the cart token into order access (ADR 0003 I3). It
 * exchanges one credential for a DIFFERENT, narrower, separately expiring and
 * separately revocable one, scoped to the single group that session itself
 * created — and the new credential carries `tracking:read` alone, so nothing it
 * can reach is a retrospective read of stored detail.
 */
export async function mintPostCheckoutGrant(input: {
  checkoutGroupId: string;
  guestSessionId: string;
  now: Date;
}): Promise<PostCheckoutGrantResult> {
  const db = getDb();
  const [contact] = await db
    .select({ id: guestCheckouts.id })
    .from(guestCheckouts)
    .where(
      and(
        eq(guestCheckouts.checkoutGroupId, input.checkoutGroupId),
        eq(guestCheckouts.guestSessionId, input.guestSessionId),
      ),
    )
    .limit(1);

  if (!contact) {
    log.guest.warn(
      { checkoutGroupId: input.checkoutGroupId },
      '[GuestPortal] confirmation grant refused: the presented session did not place this group',
    );
    return { status: 'refused', refusal: 'not_this_sessions_checkout' };
  }

  const live = await countLivePostCheckoutGrants(db, input.checkoutGroupId, input.now);
  if (live >= MAX_LIVE_POST_CHECKOUT_GRANTS) {
    return { status: 'refused', refusal: 'too_many_live_grants' };
  }

  const { token, tokenHash } = mintPortalToken();
  const expiresAt = new Date(input.now.getTime() + config.guest.portal.grantDays * DAY_MS);
  const grant = await insertGuestOrderAccessGrant(db, {
    checkoutGroupId: input.checkoutGroupId,
    guestCheckoutId: contact.id,
    tokenHash,
    purpose: 'portal',
    createdVia: 'post_checkout',
    scopes: resolveGrantScopes('post_checkout', false),
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + PORTAL_PURGE_GRACE_MS),
  });

  log.guest.info(
    { grantId: grant.id, checkoutGroupId: grant.checkoutGroupId },
    '[GuestPortal] post-checkout grant minted',
  );
  return {
    status: 'minted',
    credential: { token, state: toPortalSessionState(grant, input.now), grant },
  };
}

/**
 * Mint the single-use exchange credential a link carries.
 *
 * Takes a transaction handle, because it is called from inside the send
 * transaction: the plaintext must exist only for as long as it takes to compose
 * one message, and a grant committed separately from the message that carries it
 * is either a link nobody received or a message with no link in it.
 */
export async function mintExchangeGrant(
  db: DatabaseOrTransaction,
  input: {
    checkoutGroupId: string;
    guestCheckoutId: string;
    reason: GuestOrderExchangeReason;
    now: Date;
  },
): Promise<{ token: string; grant: GuestOrderAccessGrantRow }> {
  const { token, tokenHash } = mintExchangeToken();
  const expiresAt = new Date(
    input.now.getTime() + config.guest.portal.magicLinkMinutes * MINUTE_MS,
  );
  const grant = await insertGuestOrderAccessGrant(db, {
    checkoutGroupId: input.checkoutGroupId,
    guestCheckoutId: input.guestCheckoutId,
    tokenHash,
    purpose: 'exchange',
    createdVia: 'magic_link',
    exchangeReason: input.reason,
    scopes: resolveExchangeScopes(),
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + EXCHANGE_PURGE_GRACE_MS),
  });
  return { token, grant };
}

/**
 * Consume a presented `mgx_` token and mint the durable portal credential.
 *
 * ONE transaction, and everything in it is a consequence of the consume
 * succeeding: the portal grant, the contact's verification stage, and the
 * revocation of any portal credential this exchange supersedes. If the consume
 * finds nothing — expired, already used, revoked, unknown — the whole thing is
 * a uniform `null` and nothing was created.
 *
 * ## Superseding is a POLICY, and it is narrow on purpose
 *
 * #108 recovery rule 6 asks that superseded grants be revoked "where policy
 * requires it". The policy here: a `sensitive_action` exchange ROTATES the
 * session it was requested from (magic-link rule 9), so the presenting
 * credential is revoked and replaced. An `initial_confirmation` or `recovery`
 * exchange revokes nothing — a person reading mail on a laptop must not silently
 * log out the phone they paid from, and the credential they are replacing may
 * be the only one they still have. "Secure my access" is the deliberate,
 * user-driven revoke-everything, and it is a separate act with a separate
 * button.
 */
export async function exchangeMagicLinkToken(input: {
  presented: string;
  /** The portal grant the request already held, when a step-up was requested from one. */
  supersedesGrantId?: string;
  now: Date;
}): Promise<IssuedPortalCredential | null> {
  const token = readExchangeToken(input.presented);
  if (token === undefined) {
    logRejection('malformed');
    return null;
  }

  const presentedHash = hashPortalToken(token);
  return await getDb().transaction(async (tx) => {
    const consumed = await consumeExchangeGrant(tx, presentedHash, input.now);
    if (!consumed) {
      logRejection('unusable');
      return null;
    }
    // The lookup narrowed on an indexed equality; this is the ACCEPT decision,
    // and it is constant-time. Never `!==` on a secret-derived value.
    if (!portalTokenMatches(token, consumed.tokenHash)) {
      logRejection('digest_mismatch', consumed.id);
      throw new Error('guest portal exchange resolved a row its own digest does not match');
    }

    const { token: portalToken, tokenHash } = mintPortalToken();
    const expiresAt = new Date(input.now.getTime() + config.guest.portal.grantDays * DAY_MS);
    const grant = await insertGuestOrderAccessGrant(tx, {
      checkoutGroupId: consumed.checkoutGroupId,
      guestCheckoutId: consumed.guestCheckoutId,
      tokenHash,
      purpose: 'portal',
      createdVia: 'magic_link',
      // The scopes the LINK carried, not the ones policy would grant now: a
      // policy change between sending and clicking must not widen a link
      // already sitting in somebody's inbox.
      scopes: consumed.scopes as GuestOrderScope[],
      emailVerifiedAt: input.now,
      expiresAt,
      purgeAt: new Date(expiresAt.getTime() + PORTAL_PURGE_GRACE_MS),
    });

    if (consumed.exchangeReason === 'sensitive_action' && input.supersedesGrantId !== undefined) {
      await revokeGrant(tx, input.supersedesGrantId, input.now);
    }

    log.guest.info(
      {
        grantId: grant.id,
        exchangedGrantId: consumed.id,
        checkoutGroupId: grant.checkoutGroupId,
        reason: consumed.exchangeReason,
      },
      '[GuestPortal] magic link exchanged for a portal credential',
    );

    return {
      token: portalToken,
      state: toPortalSessionState(grant, input.now),
      grant,
    };
  });
}

/**
 * Mark a group's contact inbox proven — #108 email-verification rule 1.
 *
 * Deliberately OUTSIDE the exchange transaction, and best-effort. The
 * verification stage is a fact about the CONTACT and the credential is a fact
 * about ACCESS; failing to record the first must not cost somebody the second,
 * because the remedy for a missing stage is a re-derivation and the remedy for a
 * lost exchange is another 15-minute link the person may no longer be waiting
 * for.
 *
 * The stage says whether the proof landed before or after payment, and it is
 * read off the ORDERS rather than the payment domain: `lifecycle` is what the
 * portal already derives, and reaching into `payments` for a classification the
 * order status already carries would put a second reader on the payment seam.
 *
 * Idempotent by CAS on the stage: a second exchange for an already-verified
 * contact writes nothing, so the instant recorded is when the inbox was FIRST
 * proven.
 */
export async function recordContactVerification(input: {
  checkoutGroupId: string;
  paidBefore: boolean;
  now: Date;
}): Promise<void> {
  try {
    const db = getDb();
    const [current] = await db
      .select({ stage: guestCheckouts.contactVerificationStage })
      .from(guestCheckouts)
      .where(eq(guestCheckouts.checkoutGroupId, input.checkoutGroupId))
      .limit(1);
    if (!current || current.stage !== 'pending') return;

    await setGuestCheckoutVerificationStage(
      db,
      input.checkoutGroupId,
      input.paidBefore ? 'verified_after_payment' : 'verified_before_payment',
      input.now,
    );
  } catch (err) {
    log.guest.error(
      { err, checkoutGroupId: input.checkoutGroupId },
      '[GuestPortal] failed to record contact verification; the portal credential stands',
    );
  }
}

/**
 * Resolve a presented `mgp_` token to a live grant, or `null` — uniformly.
 *
 * Touches `last_used_at` at ≥ 60 s granularity, which is audit and NOT a
 * sliding window: a portal credential's expiry is absolute, so using one cannot
 * extend it. That is the difference from `guest_sessions`, where idle expiry
 * makes the touch load-bearing, and it is deliberate — a cart may follow
 * somebody around for months, and access to a placed order should not.
 */
export async function resolvePortalGrant(
  presented: string | undefined,
  now: Date,
): Promise<GuestOrderAccessGrantRow | null> {
  const token = readPortalToken(presented);
  if (token === undefined) {
    if (presented !== undefined) logRejection('malformed');
    return null;
  }

  const db = getDb();
  const grant = await findLiveGrantByTokenHash(db, hashPortalToken(token), 'portal', now);
  if (!grant) {
    logRejection('unusable');
    return null;
  }
  if (!portalTokenMatches(token, grant.tokenHash)) {
    logRejection('digest_mismatch', grant.id);
    return null;
  }

  await touchGrantLastUsed(db, grant.id, now, PORTAL_LAST_USED_GRANULARITY_MS);
  return grant;
}

/**
 * "Secure my access" — revoke every live credential for the group except the
 * one that asked (ADR 0003 diagram 10).
 *
 * Sparing the presenting credential is what makes the button usable: without
 * it, securing your access logs you out, and a control people avoid pressing
 * protects nobody. The blast radius is bounded to ONE checkout group whatever
 * happens, because that is the only scope any of these rows has.
 */
export async function secureGroupAccess(input: {
  checkoutGroupId: string;
  keepGrantId: string;
  now: Date;
}): Promise<string[]> {
  const revoked = await revokeGroupGrants(getDb(), input.checkoutGroupId, input.now, {
    exceptGrantId: input.keepGrantId,
  });
  log.guest.info(
    {
      checkoutGroupId: input.checkoutGroupId,
      keptGrantId: input.keepGrantId,
      revokedGrantIds: revoked,
    },
    '[GuestPortal] group access secured',
  );
  return revoked;
}

/** Revoke ONE credential — the portal's own sign-out. Idempotent. */
export async function revokePortalGrant(id: string, now: Date): Promise<boolean> {
  const revoked = await revokeGrant(getDb(), id, now);
  if (revoked) log.guest.info({ grantId: id }, '[GuestPortal] portal credential revoked');
  return revoked;
}

/**
 * The SAFE projection of a grant — names every field, carries no secret.
 *
 * `stepUpSatisfied` is DERIVED against the clock rather than stored, for the
 * reason `guest_sessions` has no status column: a freshness flag beside a
 * timestamp is a second account of one fact, and the place it must not go stale
 * is a gate deciding whether a placed order may be cancelled.
 */
export function toPortalSessionState(
  grant: GuestOrderAccessGrantRow,
  now: Date,
): GuestPortalSessionState {
  return {
    id: grant.id,
    checkoutGroupId: grant.checkoutGroupId,
    scopes: grant.scopes as GuestOrderScope[],
    emailVerified: grant.emailVerifiedAt !== null,
    verifiedAt: grant.emailVerifiedAt === null ? null : grant.emailVerifiedAt.toISOString(),
    stepUpSatisfied: stepUpSatisfied(grant, now),
    createdVia: grant.createdVia,
    expiresAt: grant.expiresAt.toISOString(),
    createdAt: grant.createdAt.toISOString(),
  };
}

/**
 * Whether the inbox proof behind a credential is fresh enough for a sensitive
 * mutation (#108 authorization rule 3).
 *
 * An unverified credential is never fresh: `null` is not "long ago", it is
 * "never", and the comparison below would read a missing proof as an old one if
 * the null were coerced to an epoch.
 */
export function stepUpSatisfied(grant: GuestOrderAccessGrantRow, now: Date): boolean {
  if (grant.emailVerifiedAt === null) return false;
  const age = now.getTime() - grant.emailVerifiedAt.getTime();
  return age <= config.guest.portal.stepUpMinutes * MINUTE_MS;
}

/**
 * The structured security event for a rejected credential (#108 magic-link rule
 * 10: "record only safe grant and session ids in logs").
 *
 * The reason category exists for operators; the HTTP answer stays uniform
 * whatever it says. No token in any form, no email, no hash — a grant row id at
 * most, and only when one was actually resolved.
 */
function logRejection(
  reason: 'malformed' | 'unusable' | 'digest_mismatch',
  grantId?: string,
): void {
  log.guest.warn(
    { reason, ...(grantId !== undefined ? { grantId } : {}) },
    '[GuestPortal] credential rejected',
  );
}
