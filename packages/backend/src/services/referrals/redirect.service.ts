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
 * A bot, a link preview and a shopper all receive the identical destination —
 * origin, path and (empty) query. The classification decides whether a click
 * is CLAIMED and whether evidence is produced — never the page — because a
 * redirect that varied on the `User-Agent` would be cloaking, and search
 * engines treat it as such. The one difference is the FRAGMENT an organic
 * click carries, which names no resource and is never sent to a server.
 *
 * ## The redirect stores nothing on the device and attributes nothing
 *
 * ePrivacy Art. 5(3) wants PRIOR consent before anything is stored on, or read
 * from, a buyer's device for referral tracking, and a click is not consent. So
 * this response sets no cookie and writes no touch — not even for a request
 * that already carries a subject, which this route no longer resolves at all.
 * The click's evidence, the signed `mrf_` carrier, is appended to the
 * destination as a URL fragment (`#mercaria_ref=mrf_…`): a fragment is never
 * sent to a server and never appears in a `Referer`. The storefront reads it,
 * strips it from the address bar, keeps it in memory and asks; only
 * `POST /referrals/consent` turns it into a touch or a cookie.
 *
 * What still happens here touches no device and names no person: resolving
 * the link, the redirect lever, classification, and claiming the click
 * against the link's ceiling.
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
  ReferralRedirectDisposition,
  ReferralTrafficClass,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import { ALLOWED_ORIGINS } from '../../lib/allowed-origins.js';
import { config } from '../../config/index.js';
import { resolveProgramControls } from '../../db/referrals/programControlRepository.js';
import { claimReferralLinkClick, resolveReferralLink } from './touch.service.js';
import { mintReferralState, REFERRAL_STATE_PREFIX } from './referral-state.js';
import { trafficMayAttribute } from './traffic.js';

/**
 * The fragment key the storefront reads the carrier from
 * (`packages/frontend/lib/hooks/use-referral-binding.ts` spells it too).
 */
export const REFERRAL_FRAGMENT_KEY = 'mercaria_ref';

/**
 * Path prefixes this route serves. A composed destination starting with one
 * would send a browser back through resolution — the loop #143 link rule 6
 * forbids.
 */
export const REFERRAL_ROUTE_PREFIXES: readonly string[] = ['/r/', '/r'];

/**
 * The origin every referral redirect lands on.
 *
 * The storefront origin, `config.web.origin` (`WEB_URL`, default
 * `https://mercaria.co`) — where every referral destination template resolves.
 * It is validated against `ALLOWED_ORIGINS` — the same list CORS and the guest
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
  const configured = config.web.origin;
  if (!ALLOWED_ORIGINS.includes(configured)) {
    throw new Error(
      `WEB_URL (${configured}) is not an allowed browser origin. ` +
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
  if (
    REFERRAL_ROUTE_PREFIXES.some(
      (prefix) => target.pathname === prefix || target.pathname.startsWith('/r/'),
    )
  ) {
    throw new Error(
      `A referral destination resolved back onto the referral route (${target.pathname}); that is a loop.`,
    );
  }
  // `target.href` carries no search and no hash: nothing above ever sets one,
  // and `destinations.ts` produces path-only strings.
  return target.href;
}

/** The carrier's whole alphabet: its prefix, base64url, and one `.`. */
const URL_SAFE_CARRIER = new RegExp(`^${REFERRAL_STATE_PREFIX}[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`);

/**
 * Append the carrier to an ALREADY COMPOSED destination, as its fragment.
 *
 * After composition, never into it: the origin check and the loop guard run on
 * a fragment-free URL, and this changes nothing they checked — `URL#hash`
 * cannot alter the origin, the path or the query. The carrier is checked for
 * its own URL-safe shape (`mrf_` plus base64url and one `.`) rather than
 * trusted to stay that way, so a payload change that let a `#`, `&` or `%`
 * into the spelling fails here instead of corrupting the fragment.
 */
export function withReferralCarrier(location: string, carrier: string): string {
  if (!URL_SAFE_CARRIER.test(carrier)) {
    throw new Error('A referral carrier is not URL-safe; refusing to put it in a fragment.');
  }
  const target = new URL(location);
  target.hash = `${REFERRAL_FRAGMENT_KEY}=${carrier}`;
  return target.href;
}

/**
 * Everything the redirect handler learned about one request, already classified.
 *
 * There is no actor and no client surface: the redirect writes no touch, so it
 * has no use for a subject and deliberately does not resolve one.
 */
export interface ReferralRedirectRequest {
  token: string;
  trafficClass: ReferralTrafficClass;
  /**
   * What the caller DECLARED at click time — only a native client can, on
   * `X-Mercaria-Referral-Consent`. Only `denied` changes anything here (no
   * carrier at all); a `granted` declaration does not stand in for the buyer
   * answering the storefront's prompt, so the carrier still says `unknown`.
   */
  consentMode: ReferralConsentMode;
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
      /** The destination, with `#mercaria_ref=<carrier>` when one was issued. */
      location: string;
      disposition: ReferralRedirectDisposition;
      disclosureRequired: boolean;
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
 *     limited link's last click would cost the partner the campaign. The claim
 *     is a counter on the LINK row: it names no person and stores nothing on
 *     the device.
 *  4. EVIDENCE — a signed carrier in the destination's fragment, and nothing
 *     else. No touch is written here, even for a signed-in shopper: the touch
 *     waits for the buyer's consent (`POST /referrals/consent`), which is also
 *     the earliest moment a cookie may be written.
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
    // Redirected, nothing claimed, nothing recorded, no carrier handed over. A
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

  if (request.consentMode === 'denied') {
    // A native client declared a refusal up front: no carrier at all. The
    // redirect still happens — refusing to send somebody where they asked to
    // go would make consent a punishment rather than a choice.
    return {
      outcome: 'redirect',
      location,
      disposition: 'redirected_without_state',
      disclosureRequired: resolved.disclosureRequired,
    };
  }

  const minted = mintReferralState({
    linkId: resolved.linkId,
    codeId: resolved.code.id,
    clickedAt: request.at,
    lifetimeSeconds: resolved.version.attributionWindowDays * 24 * 60 * 60,
  });
  return {
    outcome: 'redirect',
    location: withReferralCarrier(location, minted.token),
    disposition: 'redirected_and_recorded',
    disclosureRequired: resolved.disclosureRequired,
  };
}
