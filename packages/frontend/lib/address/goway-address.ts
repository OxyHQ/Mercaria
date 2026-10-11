import type { SearchResult } from '@goway.to/sdk';
import type { CheckoutAddressInput } from '@mercaria/shared-types';

export type PostalAddress = Pick<
  CheckoutAddressInput,
  'line1' | 'city' | 'region' | 'postalCode' | 'country'
>;

/** Only structured geographic facts. Never guess a street from a place's display name. */
export function postalAddressFromResult(result: SearchResult): PostalAddress {
  const address = result.address;
  return {
    line1: [address?.street, address?.houseNumber].filter(Boolean).join(' '),
    city: address?.city ?? result.context?.city ?? '',
    region: address?.region ?? result.context?.region ?? '',
    postalCode: address?.postalCode ?? '',
    country: (address?.countryCode ?? result.context?.countryCode ?? '').toUpperCase(),
  };
}

export function hasRequiredPostalFields(address: PostalAddress): boolean {
  return Boolean(
    address.line1.trim() &&
      address.city.trim() &&
      address.postalCode.trim() &&
      /^[A-Z]{2}$/.test(address.country),
  );
}
