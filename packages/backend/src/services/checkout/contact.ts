/** Server adapters for the canonical browser-safe checkout input policy. */
import {
  type CheckoutAddressInput,
  type CheckoutContactInput,
  type NormalizedCheckoutAddress,
  type NormalizedCheckoutContact,
  validateCheckoutAddress,
  validateCheckoutContact,
} from '@mercaria/shared-types';
import { validationError } from '../../lib/errors/error-codes.js';
export { canonicalizePhone, isIsoAlpha2Country } from '@mercaria/shared-types';
export type { NormalizedCheckoutAddress, NormalizedCheckoutContact } from '@mercaria/shared-types';

export function normalizeCheckoutAddress(input: CheckoutAddressInput): NormalizedCheckoutAddress {
  const result = validateCheckoutAddress(input);
  if (result.ok === false) throw validationError(result.message);
  return result.address;
}
export function normalizeCheckoutContact(input: CheckoutContactInput): NormalizedCheckoutContact {
  const result = validateCheckoutContact(input);
  if (result.ok === false) throw validationError(result.message);
  return result.contact;
}
