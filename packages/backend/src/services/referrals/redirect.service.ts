/**
 * `GET /r/:token` — resolving a partner's link into one allow-listed Mercaria
 * destination (#143 link rules 1-10).
 *
 * ## The destination cannot come from the request, and that is a SHAPE
 *
 * Nothing on this path accepts a URL. The absolute location is composed from
 * exactly two pieces: {@link referralRedirectOrigin}, a configured origin that
 * must be a member of `lib/allowed-origins.ts` (the ONE origin authority this
 * backend keeps, shared with CORS and the guest CSRF gate), and the RELATIVE
 * path `services/referrals/destinations.ts` builds from a closed template and a
 * validated opaque id. No query parameter, header or path segment beyond the
 * token itself reaches it — so "arbitrary destination" and "arbitrary campaign
 * injector" (acceptance 2) are inexpressible rather than filtered.
 *
 * The origin check is an EXACT comparison of parsed `hostname` values. A suffix
 * test would admit `mercaria.co.evil.example`, which is the classic way an
 * allow-list becomes an open redirect; #66's `AWIN_TRACKING_HOSTS` makes the
 * same call for the same reason.
 *
 * ## 302 and `no-store`, and why the alternatives are wrong
 *
 * A `301`/`308` is permanently cacheable: a browser that saw one would stop
 * asking, so the click ceiling would stop counting, a revoked link would keep
 * working, and the operator lever below would stop being a lever. `302` plus
 * `Cache-Control: no-store` is the only pair under which every click reaches
 * the row that decides. `Referrer-Policy: no-referrer` goes with them so the
 * destination page never learns the token from a `Referer` header.
 *
 * ## A classification never changes where somebody is sent
 *
 * A bot, a link preview and a shopper all receive the identical `Location`. The
 * classification decides whether a click is CLAIMED and whether evidence is
 * produced — never the destination — because a redirect that varied on the
 * `User-Agent` would be cloaking, and search engines treat it as such.
 *
 * ## Redirect loops
 *
 * The four destination templates cannot name this route, and the composed path
 * is asserted against {@link REFERRAL_ROUTE_PREFIXES} anyway, so a fifth
 * template added later fails here rather than looping a browser.
 *
 * ## Not #67
 *
 * This resolves a MERCARIA link to a MERCARIA page. The outbound
 * external-offer redirect (#37/#67) does not exist, and if it is built it is a
 * different route with a different token, a different allow-list and a
 * different risk. Nothing here composes a third-party URL — there is no
 * function that could.
 */

import type {
  ReferralConsentMode,
  ReferralClientSurface,
  ReferralRedirectDisposition,
  ReferralTrafficClass,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { ALLOWED_ORIGINS } from '../../lib/allowed-origins.js';
import { config } from '../../config/index.js';
import { resolveProgramControls } from '../../db/referrals/programControlRepository.js';
import type { CommerceActor } from '../commerce-actor.js';
import {
  claimReferralLinkClick,
  registerLinkTouch,
  resolveReferralLink,
} from './touch.service.js';
import { attributeRecordedTouch, touchActorFor } from './binding.service.js';
import { mintReferralState } from './referral-state.js';
import { trafficMayAttribute } from './traffic.js';

/**
 * Path prefixes this route serves. A composed destination starting with one
 * would send a browser back through resolution — the loop #143 link rule 6
 * forbids.
 */
export const REFERRAL_ROUTE_PREFIXES: readonly string[] = ['/r/', '/r'];

/**
 * The origin every referral redirect lands on.
 *
 * `REFERRAL_REDIRECT_BASE_URL` when set, else the first production origin. It
 * is validated against `ALLOWED_ORIGINS` — the same list CORS and the guest
 * CSRF gate read — so there is no second answer to "where may Mercaria send a
 * browser", which is precisely the shape an open redirect takes when a
 * deployment gets its own list.
 *
 * @throws When the configured value is not an allow-listed origin. Refusing at
 *   the first redirect is the right failure: a deployment pointing referral
 *   traffic at an unlisted host has a configuration bug, and serving it would
 *   be the bug shipping.
 */
export function referralRedirectOrigin(): string {
  const configured = config.referrals.redirectBaseUrl;
  if (!ALLOWED_ORIGINS.includes(configured)) {
    throw new Error(
      `REFERRAL_REDIRECT_BASE_URL (${configured}) is not an allowed browser origin. ` +
        'Referral redirects compose their destination from this origin plus an allow-listed ' +
        'relative path; an unlisted origin would make the route an open redirect.',
    );
  }
  return configured;
}

/**
 * Compose the absolute destination.
 *
 * Built with the `URL` constructor from a validated base and a relative path,
 * so the result's origin is the base's by construction: string concatenation
 * would admit a path beginning `//evil.example` as a protocol-relative URL.
 * The origin is compared back afterwards anyway — the belt to that brace — and
 * the loop guard runs on the final pathname rather than on the input.
 */
export function composeReferralDestination(relativePath: string): string {
  const origin = referralRedirectOrigin();
  const target = new URL(relativePath, origin);
  const base = new URL(origin);
  if (target.origin !== base.origin || target.hostname !== base.hostname) {
    throw new Error(
      `A referral destination resolved off-origin (${target.origin}); the relative path was rejected.`,
    );
  }
  if (REFERRAL_ROUTE_PREFIXES.some((prefix) => target.pathname === prefix || target.pathname.startsWith('/r/'))) {
    throw new Error(
      `A referral destination resolved back onto the referral route (${target.pathname}); that is a loop.`,
    );
  }
  // `target.href` carries no search and no hash: nothing above ever sets one,
  // and `destinations.ts` produces path-only strings.
  return target.href;
}

/** Everything the redirect handler learned about one request, already classified. */
export interface ReferralRedirectRequest {
  token: string;
  trafficClass: ReferralTrafficClass;
  clientSurface: ReferralClientSurface;
  consentMode: ReferralConsentMode;
  actor: CommerceActor;
  at: Date;
}

/**
 * How the redirect resolved. String discriminants, because this backend
 * compiles with `strict: false` and TypeScript will not narrow a union on the
 * truthiness of a boolean-literal discriminant — the #68 finding.
 */
export type ReferralRedirectOutcome =
  | {
      outcome: 'redirect';
      location: string;
      disposition: ReferralRedirectDisposition;
      disclosureRequired: boolean;
      /** Present only when the visitor had no subject and consent permits state. */
      state?: { token: string; maxAgeMs: number };
      /** Present when the click was attributed immediately (a subject was present). */
      touchId?: string;
    }
  | { outcome: 'not_found'; disposition: ReferralRedirectDisposition };

/**
 * Resolve one click.
 *
 * The sequence, and why it is this order:
 *
 *  1. RESOLVE — signature, then the row's lifecycle, then the program gate.
 *     Nothing is written, so garbage costs one indexed read.
 *  2. The operator's REDIRECT lever. After resolution, because a lever check
 *     needs the program the token names; an unknown token is a 404 either way,
 *     and answering the same 404 for a disabled program is deliberate — a
 *     stranger must not be able to tell "no such link" from "that programme is
 *     paused", which would make the lever an oracle over which programs exist.
 *  3. CLAIM the click, for organic traffic only. A scanner that spent a
 *     limited link's last click would cost the partner the campaign.
 *  4. EVIDENCE. With a subject present, the touch is written now. With none,
 *     the carrier holds the click and `binding.service.ts` writes the touch
 *     when a subject appears — ADR 0003 T10: an anonymous click writes no row.
 */
export async function resolveReferralRedirect(
  request: ReferralRedirectRequest,
): Promise<ReferralRedirectOutcome> {
  const db = getDb();
  const resolved = await resolveReferralLink(db, request.token, request.at);

  const controls = await resolveProgramControls(db, resolved.version.programId);
  if (!controls.redirectEnabled) {
    return { outcome: 'not_found', disposition: 'refused_redirect_disabled' };
  }

  const location = composeReferralDestination(resolved.destinationPath);
  const attributable = trafficMayAttribute(request.trafficClass);

  if (!attributable) {
    // Redirected, nothing claimed, nothing recorded, no state handed over. A
    // crawler leaves exactly the trace ADR 0003 T10 wants it to leave: none.
    return {
      outcome: 'redirect',
      location,
      disposition: 'redirected_unattributed',
      disclosureRequired: resolved.disclosureRequired,
    };
  }

  if (!(await claimReferralLinkClick(db, resolved.linkId))) {
    // The ceiling, reached between the resolve and here or long ago. A partner
    // asking why gets the answer from the operator trace; the caller gets the
    // same 404 every other refusal produces.
    return { outcome: 'not_found', disposition: 'refused_link_unusable' };
  }

  const touchActor = touchActorFor(request.actor);
  if (touchActor !== null) {
    // A subject is already present — a signed-in shopper, or a native client
    // presenting its guest credential — so the click is resolved COMPLETELY
    // here: the evidence lands where ADR 0005 D6 says it should, and the same
    // `attributeRecordedTouch` every bind goes through decides the winner.
    //
    // Recording the touch and stopping was the first shape of this and it was
    // wrong: no carrier is issued on this branch (there is nothing to defer),
    // so `POST /referrals/bind` would have nothing to present and the touch
    // would sit unattributed forever — a signed-in buyer's click silently
    // earning a partner nothing.
    const registered = await registerLinkTouch({
      linkId: resolved.linkId,
      codeId: resolved.code.id,
      occurredAt: request.at,
      context: {
        actor: touchActor,
        clientSurface: request.clientSurface,
        consentMode: request.consentMode,
        trafficClass: request.trafficClass,
        at: request.at,
      },
    });
    await attributeRecordedTouch(registered.touch.id, registered.version.id);
    return {
      outcome: 'redirect',
      location,
      disposition: 'redirected_and_recorded',
      disclosureRequired: resolved.disclosureRequired,
      touchId: registered.touch.id,
    };
  }

  if (request.consentMode === 'denied') {
    // The one thing a consent declaration does here: no web state is written.
    // The redirect still happens — refusing to send somebody where they asked
    // to go would make consent a punishment rather than a choice.
    return {
      outcome: 'redirect',
      location,
      disposition: 'redirected_without_state',
      disclosureRequired: resolved.disclosureRequired,
    };
  }

  const lifetimeSeconds = resolved.version.attributionWindowDays * 24 * 60 * 60;
  const minted = mintReferralState({
    linkId: resolved.linkId,
    codeId: resolved.code.id,
    clickedAt: request.at,
    lifetimeSeconds,
  });
  return {
    outcome: 'redirect',
    location,
    disposition: 'redirected_and_recorded',
    disclosureRequired: resolved.disclosureRequired,
    state: {
      token: minted.token,
      maxAgeMs: Math.max(minted.expiresAt.getTime() - request.at.getTime(), 0),
    },
  };
}
