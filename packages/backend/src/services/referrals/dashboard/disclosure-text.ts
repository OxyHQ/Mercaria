/**
 * The disclosure a partner must publish beside a referral link (#147 link tool
 * 3, ADR 0005 "Fraud controls, disclosures").
 *
 * ## A CODE CONSTANT, not a table
 *
 * The #126 terms decision, and the reason is the same: this is a published
 * consumer-law statement somebody signed off, so changing it is a commit with
 * an author and a date rather than a row an operator edits at 3am. A table
 * would additionally let somebody publish a disclosure version no shipped copy
 * contains, which would then be snapshotted onto instruments as the wording
 * partners were told to use.
 *
 * ## Versioned, and the program names the version
 *
 * `referral_programs.disclosure_version` already exists (#142 field 15) and is
 * pinned per program version. This registry resolves that pointer to the text,
 * which is what makes a version pointer durable — #126's rule that "a version
 * pointer is only as durable as the code that can still resolve it".
 *
 * A program naming a version this registry does not carry gets the ACTIVE text
 * and says so through `resolved: false`, rather than an empty string: a partner
 * shown nothing publishes nothing, and publishing nothing is the compliance
 * failure the disclosure exists to prevent.
 */

/** One published disclosure wording. */
export interface ReferralDisclosureTerms {
  version: string;
  /** The exact sentence a partner publishes. Rendered verbatim, never edited. */
  text: string;
  /** BCP-47. One language today; the field exists so a second is additive. */
  locale: string;
}

/** Every published version, newest last. */
export const REFERRAL_DISCLOSURE_TERMS: Readonly<Record<string, ReferralDisclosureTerms>> =
  Object.freeze({
    'disclosure-2026-08-01': {
      version: 'disclosure-2026-08-01',
      locale: 'en',
      text: 'I may earn a commission from Mercaria if you buy through this link. It costs you nothing extra and does not change the price you pay.',
    },
  });

/** The version a newly issued instrument carries. */
export const REFERRAL_ACTIVE_DISCLOSURE_VERSION = 'disclosure-2026-08-01';

/**
 * Resolve a program's disclosure version to the text a partner must publish.
 *
 * @returns the wording plus whether the requested version was the one found —
 *   so a surface can say "this is our current wording" rather than silently
 *   substituting it.
 */
export function resolveReferralDisclosure(version: string | undefined): {
  terms: ReferralDisclosureTerms;
  resolved: boolean;
} {
  const active = REFERRAL_DISCLOSURE_TERMS[REFERRAL_ACTIVE_DISCLOSURE_VERSION] as ReferralDisclosureTerms;
  if (version === undefined) return { terms: active, resolved: false };
  const found = REFERRAL_DISCLOSURE_TERMS[version];
  if (!found) return { terms: active, resolved: false };
  return { terms: found, resolved: true };
}
