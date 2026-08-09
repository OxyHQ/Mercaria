/**
 * Whether a feed row's deep link may become a tracked destination, and what an
 * offer built from that row should be (#66 adapter rules 6, 9 and 10).
 *
 * This is the module that answers the second of #66's four failure modes: **a
 * feed row choosing where Mercaria's outbound redirect points.** `aw_deep_link`
 * is a URL a stranger writes into a CSV and #37's redirect exists to send a
 * buyer to it, so a feed that is compromised, mis-generated or simply mis-mapped
 * turns Mercaria into an open redirect with the network's name on it.
 *
 * ## The link is ADMITTED by a closed host set, never sanitised
 *
 * `AWIN_TRACKING_HOSTS` names the network's own redirectors and is a code
 * constant, not a column: a configurable set would make "which hosts may
 * Mercaria redirect to" answerable differently per deployment and per row, which
 * is the shape an open redirect eventually takes. Membership is an EXACT
 * comparison against the whole host — never `endsWith` on a bare suffix, under
 * which `awin1.com.evil.example` matches.
 *
 * ## Mercaria never CONSTRUCTS a tracking URL
 *
 * There is no function here that appends a click reference, a sub-id or a
 * campaign parameter, and there is no place in this domain that composes one.
 * #64 §6 records the rule — attribution belongs to the link, and #37's redirect
 * must not strip or rewrite its parameters — and composing one would mean
 * asserting an attribution contract Mercaria has not read. What #66 stores is
 * the network's own URL, unmodified, beside the ORIGINAL destination.
 */

import type {
  AwinMembershipStatus,
  AwinTrackingVerdict,
  CatalogSourceRightsVerdict,
} from '@mercaria/shared-types';
import { AWIN_COMMISSIONABLE_MEMBERSHIPS, AWIN_TRACKING_HOSTS } from '@mercaria/shared-types';

/**
 * The verdict on one candidate deep link, and the URL when there is one.
 *
 * `url` exists ONLY on the approved branch — a discriminated union rather than
 * an optional field beside a verdict, so a caller cannot read a rejected link's
 * URL without writing the coercion out loud. It cannot, in fact: there is no
 * property to read.
 */
export type AwinTrackingAssessment =
  | { readonly verdict: 'approved'; readonly url: string }
  | { readonly verdict: Exclude<AwinTrackingVerdict, 'approved'> };

/** Is this host one of the network's own redirectors? */
export function isAwinTrackingHost(host: string): boolean {
  // Exact, lower-cased, whole-host comparison. A suffix test admits
  // `awin1.com.evil.example`, which is the one host shape this check exists for.
  const normalized = host.trim().toLowerCase();
  return AWIN_TRACKING_HOSTS.includes(normalized);
}

/**
 * Examine one candidate `aw_deep_link`.
 *
 * PURE, and it takes the rights and the membership rather than reading them,
 * because the same three inputs decide the offer's kind one function down and
 * two readers of one policy can disagree.
 *
 * The order of the refusals is deliberate: Mercaria's OWN decisions are checked
 * before the provider's string is examined at all. A deployment whose rights
 * policy withheld affiliate parameters gets `rights_withheld` rather than a
 * verdict about a URL it was never going to use, which is the difference between
 * "we decided not to" and "their feed is broken" — and those lead to different
 * people.
 */
export function assessAwinTrackingLink(input: {
  candidate: string | undefined;
  membershipStatus: AwinMembershipStatus;
  rights: CatalogSourceRightsVerdict;
}): AwinTrackingAssessment {
  if (!input.rights.affiliate_params || !input.rights.outbound_link) {
    return { verdict: 'rights_withheld' };
  }
  if (!AWIN_COMMISSIONABLE_MEMBERSHIPS.includes(input.membershipStatus)) {
    return { verdict: 'not_commissionable' };
  }

  const candidate = input.candidate?.trim() ?? '';
  if (candidate === '') return { verdict: 'absent' };

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { verdict: 'rejected_shape' };
  }
  // HTTPS only. A tracked link over cleartext can be rewritten in transit, and
  // a rewritten redirect is a destination of somebody else's choosing.
  if (parsed.protocol !== 'https:') return { verdict: 'rejected_scheme' };
  if (!isAwinTrackingHost(parsed.hostname)) return { verdict: 'rejected_host' };

  // `parsed.toString()` rather than the raw string: the URL is normalised
  // exactly once, here, so the value that reaches the offer is the value that
  // was validated. Storing the raw text and validating a parse of it are two
  // representations of one URL, and they differ on exactly the inputs that
  // matter.
  return { verdict: 'approved', url: parsed.toString() };
}

/**
 * The record as it may leave the adapter — with the tracking URL, or without
 * it (issue adapter rules 9 and 10).
 *
 * ## ONE authority for the offer kind, and it is #62's
 *
 * The tempting shape here is a `deriveAwinOfferRouting` that returns
 * `affiliate | external | informational`, and it would be WRONG — #62's
 * `offerKindFor` already derives exactly that from the rights and the source
 * kind, so a second derivation would be two representations of one fact, and
 * the one that would eventually disagree is the one nobody is reading.
 *
 * So the division is: this function decides whether Mercaria may hand the
 * tracking URL over AT ALL (a question about the network's link, which #62
 * cannot see), and #62 decides what the offer is (a question about the rights,
 * which this module has no business answering). Withholding the URL makes
 * #62's own `affiliate_params`-absent branch produce exactly the right result
 * with no new mechanism: no affiliate routing metadata, `destination_url`
 * unchanged as the ORIGINAL, and #37 degrading to the plain link.
 *
 * The DESTINATION is never touched — that is adapter rule 10, and it is why
 * disclosure and reconciliation both have an answer no tracking layer can
 * rewrite.
 */
export function withAssessedAwinTracking<T extends { readonly affiliateUrl?: string }>(
  normalized: T,
  tracking: AwinTrackingAssessment,
): T {
  if (tracking.verdict === 'approved') return { ...normalized, affiliateUrl: tracking.url };
  // Deleted rather than set to `undefined`: `NormalizedSourceRecord`'s absent
  // fields are ABSENT, and #62's redactor composes the stored payload from the
  // keys that are present — an `affiliateUrl: undefined` would serialize
  // differently and change the content hash for no change in the fact.
  const { affiliateUrl: _withheld, ...rest } = normalized;
  return rest as T;
}

/**
 * The host an outbound destination points at, or `null`.
 *
 * Used by the pre-activation sample to check that a deep link and a destination
 * agree about which retailer this is. A disagreement means the feed's two URL
 * columns were mapped to each other's roles, which produces a catalogue that
 * works perfectly until somebody audits where the money went.
 */
export function destinationHost(value: string | undefined): string | null {
  const candidate = value?.trim() ?? '';
  if (candidate === '') return null;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Does a destination host belong to the advertiser Mercaria thinks it does?
 *
 * Label-wise containment, the `claim-scope.ts` rule (#83): `shop.apple.com` is
 * covered by `apple.com` and `notapple.com` is not. A bare `endsWith` would
 * admit the second, which is the whole reason that rule is written down.
 *
 * An advertiser with no declared host is NOT reported as a mismatch — it is
 * reported as nothing, because Mercaria has no expectation to compare against
 * and inventing one from the feed's own contents would make the check circular.
 */
export function destinationMatchesAdvertiser(input: {
  host: string | null;
  declaredHost: string | null;
}): boolean | null {
  if (input.host === null || input.declaredHost === null) return null;
  const declared = input.declaredHost.trim().toLowerCase();
  if (declared === '') return null;
  return input.host === declared || input.host.endsWith(`.${declared}`);
}
