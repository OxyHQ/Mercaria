/**
 * Normalizing and refusing what an applicant typed (#146 increment 2,
 * "Application").
 *
 * PURE — no database, no clock, no configuration, and **no outbound call of any
 * kind**. That last one is the property worth stating: the natural thing to do
 * with a promotion URL is fetch it to see whether it exists, and doing so would
 * turn every application form into an SSRF primitive pointed wherever the
 * applicant likes. Mercaria records the URL and a reviewer opens it in their own
 * browser. `referral-enrollment-isolation.test.ts` fails the build if this
 * domain learns to fetch one.
 *
 * ## What the CHECKs can and cannot do, and why the split falls where it does
 *
 * The database checks the JOINED arrays with a regex, because a CHECK may
 * contain no subquery and therefore cannot `unnest`. That is enough to state
 * the invariant — every market is two upper-case letters, every URL is https
 * with no whitespace — and it is what holds against `psql` and a service bug.
 * What it CANNOT do is tell an applicant which of their five URLs was the
 * problem, so this module refuses element by element and names the index.
 */

import {
  REFERRAL_AUDIENCE_BANDS,
  REFERRAL_PROMOTION_METHODS,
  type ReferralAudienceBand,
  type ReferralPromotionMethod,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';

/** What an applicant sends, before anything has been checked. */
export interface RawApplicationAnswers {
  promotionMethods?: readonly string[];
  promotionUrls?: readonly string[];
  audienceBand?: string;
  markets?: readonly string[];
  prohibitedMethodsAcknowledged?: boolean;
  hasRelatedParty?: boolean;
  relatedPartyDisclosure?: string;
  reviewConsent?: boolean;
  communicationConsent?: boolean;
  programId?: string;
}

/** The same answers, normalized and known to satisfy every CHECK. */
export interface NormalizedApplicationAnswers {
  promotionMethods: readonly ReferralPromotionMethod[];
  promotionUrls: readonly string[];
  audienceBand: ReferralAudienceBand;
  markets: readonly string[];
  prohibitedMethodsAcknowledged: boolean;
  hasRelatedParty: boolean;
  relatedPartyDisclosure: string | null;
  reviewConsentAt: Date | null;
  communicationConsentAt: Date | null;
  programId: string | null;
}

/** The bounds, stated once and read by both the refusals and the tests. */
export const MAX_PROMOTION_URLS = 10;
export const MAX_PROMOTION_URL_LENGTH = 300;
export const MAX_MARKETS = 50;
export const MAX_RELATED_PARTY_DISCLOSURE_LENGTH = 2_000;

/**
 * Normalize one promotion URL, or refuse it by name.
 *
 * HTTPS ONLY, and the refusal is the scheme rather than a sanitisation: a
 * `javascript:` or `data:` URL rendered on a reviewer's screen is the whole
 * attack, and an `http://` one is a link Mercaria would be publishing a
 * downgrade to. The host must have a dot and no credentials — a single-label
 * host is an internal name, and `https://user:pass@example.com` carries a
 * secret into a column a reviewer reads.
 *
 * The stored form is what `URL` normalized, not what was typed: two applicants
 * writing `https://Example.com` and `https://example.com/` must not read as two
 * different sites to the duplicate detector.
 */
export function normalizePromotionUrl(raw: string, index: number): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw validationError(`Promotion link ${String(index + 1)} is empty`);
  }
  if (trimmed.length > MAX_PROMOTION_URL_LENGTH) {
    throw validationError(
      `Promotion link ${String(index + 1)} is longer than ${String(MAX_PROMOTION_URL_LENGTH)} characters`,
    );
  }
  if (/\s/.test(trimmed)) {
    throw validationError(`Promotion link ${String(index + 1)} contains whitespace`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw validationError(`Promotion link ${String(index + 1)} is not a URL`);
  }

  if (parsed.protocol !== 'https:') {
    throw validationError(`Promotion link ${String(index + 1)} must start with https://`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw validationError(`Promotion link ${String(index + 1)} must not carry credentials`);
  }
  if (!parsed.hostname.includes('.')) {
    throw validationError(`Promotion link ${String(index + 1)} names no public host`);
  }

  const normalized = parsed.toString();
  if (normalized.length > MAX_PROMOTION_URL_LENGTH) {
    throw validationError(
      `Promotion link ${String(index + 1)} is longer than ${String(MAX_PROMOTION_URL_LENGTH)} characters`,
    );
  }
  return normalized;
}

/**
 * The HOST of a stored promotion URL, for the duplicate detector.
 *
 * Returns `undefined` rather than throwing on anything unparseable: this runs
 * over rows already in the database, and a detector that threw on one bad row
 * would stop reporting the good ones.
 */
export function promotionUrlHost(stored: string): string | undefined {
  try {
    return new URL(stored).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Normalize a whole answer set, or refuse it.
 *
 * Consents arrive as BOOLEANS and are stored as INSTANTS — #146 terms rule 3's
 * "store time, actor, locale and version" applied to the two consents the
 * application carries. A boolean column could say that consent was given and
 * never when, which is the one thing a consent record exists to say.
 */
export function normalizeApplicationAnswers(
  raw: RawApplicationAnswers,
  at: Date,
): NormalizedApplicationAnswers {
  const promotionMethods = (raw.promotionMethods ?? []).map((value) => {
    if (!REFERRAL_PROMOTION_METHODS.includes(value as ReferralPromotionMethod)) {
      throw validationError(`Unsupported promotion method: ${value}`);
    }
    return value as ReferralPromotionMethod;
  });

  const rawUrls = raw.promotionUrls ?? [];
  if (rawUrls.length > MAX_PROMOTION_URLS) {
    throw validationError(`At most ${String(MAX_PROMOTION_URLS)} promotion links may be given`);
  }
  const promotionUrls = rawUrls.map(normalizePromotionUrl);

  const audienceBand = raw.audienceBand ?? 'not_stated';
  if (!REFERRAL_AUDIENCE_BANDS.includes(audienceBand as ReferralAudienceBand)) {
    throw validationError(`Unsupported audience band: ${audienceBand}`);
  }

  const rawMarkets = raw.markets ?? [];
  if (rawMarkets.length > MAX_MARKETS) {
    throw validationError(`At most ${String(MAX_MARKETS)} markets may be given`);
  }
  // Upper-cased and de-duplicated: `es` and `ES` are one country, and storing
  // both would make the same market two markets to every reader grouping by it.
  const markets = [
    ...new Set(
      rawMarkets.map((value) => {
        const upper = value.trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(upper)) {
          throw validationError(`Not an ISO 3166-1 alpha-2 country code: ${value}`);
        }
        return upper;
      }),
    ),
  ];

  const hasRelatedParty = raw.hasRelatedParty === true;
  const disclosure = raw.relatedPartyDisclosure?.trim() ?? '';
  if (hasRelatedParty && disclosure.length === 0) {
    throw validationError('A declared related party needs a disclosure');
  }
  if (!hasRelatedParty && disclosure.length > 0) {
    throw validationError('A disclosure was given without declaring a related party');
  }
  if (disclosure.length > MAX_RELATED_PARTY_DISCLOSURE_LENGTH) {
    throw validationError(
      `The related-party disclosure is longer than ${String(MAX_RELATED_PARTY_DISCLOSURE_LENGTH)} characters`,
    );
  }

  const programId = raw.programId?.trim() ?? '';

  return {
    promotionMethods,
    promotionUrls,
    audienceBand: audienceBand as ReferralAudienceBand,
    markets,
    prohibitedMethodsAcknowledged: raw.prohibitedMethodsAcknowledged === true,
    hasRelatedParty,
    relatedPartyDisclosure: hasRelatedParty ? disclosure : null,
    // A consent that was not given is ABSENT, never a falsy instant: `null`
    // says nobody consented, and there is no value that could say "consented at
    // the zero epoch" and be read as consent by something scanning for a
    // non-null column.
    reviewConsentAt: raw.reviewConsent === true ? at : null,
    communicationConsentAt: raw.communicationConsent === true ? at : null,
    programId: programId.length > 0 ? programId : null,
  };
}

/**
 * What a SUBMISSION additionally owes, beyond what a draft may hold.
 *
 * Returned as a list rather than thrown one at a time: an applicant filling in
 * a long form deserves the whole answer, and a first-failure-wins refusal sends
 * them round the loop once per missing field. The database states the same
 * invariant in `referral_partner_applications_consent_check`, which is what
 * holds it against a caller that skips this function.
 */
export function missingSubmissionRequirements(
  answers: NormalizedApplicationAnswers,
): readonly string[] {
  const missing: string[] = [];
  if (!answers.prohibitedMethodsAcknowledged) {
    missing.push('the prohibited-method rules must be acknowledged');
  }
  if (answers.reviewConsentAt === null) missing.push('consent to review is required');
  if (answers.communicationConsentAt === null) {
    missing.push('consent to be contacted about this application is required');
  }
  if (answers.promotionMethods.length === 0) {
    missing.push('at least one promotion method must be declared');
  }
  return missing;
}
