/**
 * Where `/out/:token` is allowed to send somebody — the whole of the
 * open-redirect defence (#67 outbound rules 2 and 10, acceptance 1).
 *
 * ## The shape of the guarantee
 *
 * An open redirect is a route that will send a visitor to a destination an
 * ATTACKER chose. Three independent things make that unrepresentable here, and
 * only the third is a check:
 *
 *  1. **The token cannot carry a destination.**
 *     `AffiliateOutboundTokenClaims` has one member and it is an offer id, so
 *     there is no field a URL could arrive in.
 *  2. **The route reads no query and no body.** `admitOutboundDestination` takes
 *     a stored `OfferRow` and an allow-list, and NOTHING derived from the
 *     request — the signature is the version of that a reviewer can check.
 *  3. **The stored URL is still admitted rather than trusted.** A feed row is a
 *     URL a stranger writes into a CSV, so "it came out of our own database" is
 *     not the same as "we chose it". That is what the rest of this file is.
 *
 * ## The comparison is EXACT, on a parsed hostname
 *
 * `URL.hostname`, lower-cased, compared with `===` against a closed set. Never
 * `endsWith`, under which an approved `example.com` also admits the PREPENDED
 * `notexample.com`; never `includes`, under which anything matches; never a
 * regex assembled from a stored value.
 *
 * The prepended shape is the one that does the work, and it was proved rather
 * than argued: mutating this comparison to `host.endsWith(approved.host)` goes
 * red on `notexample.com` and PASSES `example.com.evil.test` — which ends in
 * `.evil.test` and is refused by `endsWith` anyway. An earlier draft of this
 * docblock named the appended shape, and a test carrying only that example
 * would have stayed green against exactly the mutation the comment warns
 * about.
 * #66 states the same rule for `AWIN_TRACKING_HOSTS` and this is the same rule
 * one layer out, applied to every destination rather than to Awin's redirectors
 * alone.
 *
 * ## Two admission routes, and why one is a constant and one is a table
 *
 * A NETWORK REDIRECTOR (`awin1.com`, and eBay's own marketplace hosts) is a
 * code constant, for #66's reason: making "which hosts may Mercaria redirect
 * to" answerable per deployment is the shape an open redirect eventually takes.
 * A MERCHANT SITE is a row, because which shops a source sells is a fact about a
 * commercial relationship that changes without a deploy — and it is scoped to
 * ONE catalog source, so approving a host for one advertiser does not approve
 * it for the whole marketplace.
 *
 * A deployment that has approved nothing therefore redirects to the networks'
 * own links and to nowhere else. That is the correct starting state, not a gap.
 *
 * ## What is refused before the host is even looked at
 *
 * A scheme that is not `https:` — a downgrade is not a destination, and `data:`,
 * `javascript:` and `blob:` are all URLs that parse. Credentials in the
 * authority (`https://user:pass@host/`), which some clients strip and some send,
 * and which no legitimate feed publishes. And a destination pointing back at
 * Mercaria, which is requirement 10's redirect loop: `/out/` handing over a
 * `mercaria.co` address would let a poisoned feed bounce a visitor around this
 * route, and it is also how an attacker would try to reach an internal path
 * with Mercaria's own origin on it.
 */

import type { OfferRow } from '../../db/offers/offerRepository.js';
import { AWIN_TRACKING_HOSTS, type OutboundDestinationKind } from '@mercaria/shared-types';
import { ALLOWED_ORIGINS } from '../../lib/allowed-origins.js';

/**
 * The affiliate networks' OWN redirector hosts, per network id, as a code
 * constant. See the module docblock.
 *
 * Awin's are #66's `AWIN_TRACKING_HOSTS`, read from there rather than copied —
 * two lists of one network's redirectors can disagree, and the direction they
 * disagree in is the permissive one.
 *
 * eBay's entry is EMPTY, and that is a measured fact rather than an omission:
 * eBay mints `itemAffiliateWebUrl` on its own marketplace hosts (`www.ebay.es`
 * and its siblings), which are ordinary merchant sites rather than redirectors,
 * and there are dozens of them. Enumerating every eBay marketplace host here
 * would be a code constant nobody could keep correct; an operator approves the
 * markets that deployment actually ingests, through the allow-list, where the
 * approval is dated and attributable.
 */
const NETWORK_REDIRECTOR_HOSTS: Readonly<Record<string, readonly string[]>> = {
  awin: AWIN_TRACKING_HOSTS,
  ebay: [],
};

/** Mercaria's own hosts, derived from the ONE origin authority. */
function mercariaHosts(): readonly string[] {
  const hosts: string[] = [];
  for (const origin of ALLOWED_ORIGINS) {
    try {
      hosts.push(new URL(origin).hostname.toLowerCase());
    } catch {
      // An unparseable entry in the origin list is that list's problem and is
      // already its own bug; skipping it here can only make this check
      // STRICTER about nothing, never more permissive about a real host.
      continue;
    }
  }
  return hosts;
}

/**
 * The verdict. A STRING discriminant, and the refusal branch has no `url` and
 * no `host` — so a caller cannot reach for a destination it was refused
 * without writing the coercion out loud. It cannot, in fact: there is no
 * property to read.
 *
 * The backend compiles `strict: false`, so a boolean-literal discriminant would
 * not narrow (`if (!verdict.admitted)` leaves the caller holding the union) —
 * #68's finding, and the reason every union in this domain reads this way.
 */
export type OutboundDestinationAdmission =
  | {
      readonly outcome: 'admitted';
      readonly url: string;
      readonly host: string;
      readonly kind: OutboundDestinationKind;
    }
  | {
      readonly outcome: 'refused';
      readonly reason:
        | 'destination_unparseable'
        | 'destination_scheme_not_https'
        | 'destination_credentials_present'
        | 'destination_host_not_allowlisted'
        | 'destination_is_mercaria';
    };

/** One approved host, as the repository reads it. */
export interface ApprovedOutboundHost {
  readonly host: string;
  readonly kind: OutboundDestinationKind;
}

/**
 * Choose which stored URL is handed over, and compose NOTHING.
 *
 * `affiliate_tracking_template` is the provider's OWN minted, already-attributed
 * URL — Awin's `aw_deep_link` (admitted against `AWIN_TRACKING_HOSTS` at
 * ingestion by #66) or eBay's `itemAffiliateWebUrl` (minted by eBay under the
 * campaign id Mercaria sends in an INGESTION header). Despite the column's
 * name, **nothing anywhere in this repository interpolates a placeholder into
 * it**, and this function does not either: it is returned verbatim or not at
 * all.
 *
 * That is not a shortcut, it is #65's and #66's shared prohibition. #65 states
 * `EBAY_FORBIDDEN_LINK_OPERATIONS` as values (`compose_tracking_url`,
 * `append_campaign_parameter`, `strip_tracking_parameter`, …) and #66 records
 * that "attribution belongs to the link" — a rebuilt link is indistinguishable
 * from a working one until a month of revenue is missing, which is the failure
 * mode that makes composition worse than doing nothing.
 *
 * Preferring the attributed URL is the whole of Mercaria's part in attribution.
 * Falling back to `destination_url` when there is none is #62's rights model
 * working: no `affiliate_params` right ⇒ no routing metadata was stored ⇒ the
 * offer is `external` rather than `affiliate` and the plain link is correct.
 */
export function selectOutboundUrl(offer: OfferRow): string | undefined {
  const attributed = offer.affiliateTrackingTemplate?.trim();
  if (attributed !== undefined && attributed !== '') return attributed;
  const plain = offer.destinationUrl?.trim();
  return plain === undefined || plain === '' ? undefined : plain;
}

/**
 * Decide whether one stored URL may be handed to a visitor.
 *
 * PURE. It takes the offer and the approved hosts and reads no clock, no
 * configuration and no request — so its answer is a function of stored state
 * alone, which is what makes it testable exhaustively and what makes "the
 * destination cannot come from the caller" checkable by reading the signature.
 */
export function admitOutboundDestination(input: {
  readonly url: string;
  readonly affiliateNetwork: string | null;
  readonly approvedHosts: readonly ApprovedOutboundHost[];
}): OutboundDestinationAdmission {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { outcome: 'refused', reason: 'destination_unparseable' };
  }

  // HTTPS only. `http:` is a downgrade; `data:`, `javascript:` and `blob:` all
  // parse perfectly well and are exactly what a poisoned feed row carries.
  if (parsed.protocol !== 'https:') {
    return { outcome: 'refused', reason: 'destination_scheme_not_https' };
  }

  // `https://user:pass@host/` — no legitimate feed publishes one, clients
  // disagree about whether to send it, and it is a credential Mercaria would be
  // publishing on a public page.
  if (parsed.username !== '' || parsed.password !== '') {
    return { outcome: 'refused', reason: 'destination_credentials_present' };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === '') {
    return { outcome: 'refused', reason: 'destination_unparseable' };
  }

  // Requirement 10's loop, and the reason it is checked BEFORE the allow-list:
  // an operator who approved a Mercaria host by mistake must not thereby create
  // one, so this refusal is not something an allow-list row can override.
  if (mercariaHosts().includes(host)) {
    return { outcome: 'refused', reason: 'destination_is_mercaria' };
  }

  const network = input.affiliateNetwork?.trim().toLowerCase();
  const redirectors =
    network === undefined || network === '' ? [] : (NETWORK_REDIRECTOR_HOSTS[network] ?? []);
  if (redirectors.includes(host)) {
    return { outcome: 'admitted', url: input.url, host, kind: 'network_redirector' };
  }

  for (const approved of input.approvedHosts) {
    if (approved.host === host) {
      return { outcome: 'admitted', url: input.url, host, kind: approved.kind };
    }
  }

  return { outcome: 'refused', reason: 'destination_host_not_allowlisted' };
}

/**
 * The destination HOST for the disclosure a page shows BEFORE the click
 * (#67 outbound rule 5, trust principle 1).
 *
 * A hostname and never the URL: a host is what a shopper needs in order to know
 * who will receive them, and a full tracked URL on a public page hands a crawler
 * the attributed destination with no click record behind it.
 *
 * ## It reads `destination_url` and NOT the URL the redirect hands over
 *
 * This is the one place the two deliberately differ, and getting it backwards
 * would be a real deception. Rule 5 asks for "the REAL DESTINATION MERCHANT",
 * and on an Awin offer the URL actually handed over is `www.awin1.com/…` — the
 * network's redirector, which is a hop rather than a shop. Disclosing that
 * would tell a shopper they are going to an affiliate network they have never
 * heard of, when the page they will land on is the retailer's.
 *
 * So the disclosure names `destination_url`'s host (the merchant, exactly as
 * the source published it) while `selectOutboundUrl` prefers the attributed
 * link. Both are stored, neither is composed, and the redirector is the private
 * mechanism by which the shopper reaches the host they were promised.
 *
 * It deliberately does NOT consult the allow-list. A page discloses where an
 * offer SAYS it goes even when the redirect will refuse — the alternative is a
 * page that silently omits the merchant's name for a reason the shopper cannot
 * see. The refusal happens at the click, where it is recorded.
 */
export function outboundDestinationHost(offer: OfferRow): string | undefined {
  const merchantUrl = offer.destinationUrl?.trim();
  if (merchantUrl === undefined || merchantUrl === '') return undefined;
  try {
    const host = new URL(merchantUrl).hostname.toLowerCase();
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}
