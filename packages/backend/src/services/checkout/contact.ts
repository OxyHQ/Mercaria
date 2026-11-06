/** Server adapter for the canonical browser-safe address policy. */
import {
  CHECKOUT_TEXT_LIMITS,
  type CheckoutAddressInput,
  type CheckoutContactInput,
  type NormalizedCheckoutAddress,
  validateCheckoutAddress,
  CheckoutAddressValidationError,
  normalizeCheckoutText as normalizeText,
  normalizeOptionalCheckoutText as normalizeOptionalText,
  assertPlausibleCheckoutPhone as assertPlausiblePhone,
  canonicalizePhone,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';
export { canonicalizePhone, isIsoAlpha2Country } from '@mercaria/shared-types';
export type { NormalizedCheckoutAddress } from '@mercaria/shared-types';

export function normalizeCheckoutAddress(input: CheckoutAddressInput): NormalizedCheckoutAddress {
  const result = validateCheckoutAddress(input);
  if (!result.ok) throw validationError(result.message);
  return result.address;
}

/**
 * An email shape check that is deliberately PERMISSIVE about the local part.
 *
 * One `@`, a non-empty local part with no whitespace, and a domain with at
 * least one dot and a two-or-more-letter final label. RFC 5322 permits far
 * more than this (quoted strings, comments, address literals) and essentially
 * no mail provider accepts those at signup, so a stricter-than-RFC check is the
 * right trade — but it stays away from the parts that DO vary in practice: the
 * local part may contain `+`, `.`, `-`, `_`, `'` and Unicode, and the domain may
 * be an IDN.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/u;

/** A validated contact, in both of its forms. */
export interface NormalizedCheckoutContact {
  /** Exactly as typed (NFC, trimmed). What mail is addressed to. */
  displayEmail: string;
  /** Lower-cased whole address. Hashed, never displayed, never sent to. */
  normalizedEmail: string;
  /** As typed. */
  displayPhone?: string;
  /** Digits, `+`-prefixed only when the buyer gave one. Comparison only. */
  canonicalPhone?: string;
}

/** Validate and normalize a contact, producing both forms. */
export function normalizeCheckoutContact(input: CheckoutContactInput): NormalizedCheckoutContact {
  try {
    return normalizeContact(input);
  } catch (error) {
    if (error instanceof CheckoutAddressValidationError) throw validationError(error.message);
    throw error;
  }
}
function normalizeContact(input: CheckoutContactInput): NormalizedCheckoutContact {
  const displayEmail = normalizeText(input.email, 'Email', CHECKOUT_TEXT_LIMITS.email);
  if (!EMAIL_PATTERN.test(displayEmail)) {
    throw validationError('Email is not a valid address.');
  }
  const displayPhone = normalizeOptionalText(input.phone, 'Phone', CHECKOUT_TEXT_LIMITS.phone);
  if (displayPhone !== undefined) {
    assertPlausiblePhone(displayPhone);
  }

  return {
    displayEmail,
    // ADR 0003 D12, verbatim and nothing beyond it: trim, NFC, lowercase the
    // WHOLE address. `normalizeText` already did the first two.
    normalizedEmail: displayEmail.toLowerCase(),
    ...(displayPhone !== undefined
      ? { displayPhone, canonicalPhone: canonicalizePhone(displayPhone) }
      : {}),
  };
}
