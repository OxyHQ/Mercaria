import type { SearchResult } from '@goway.to/sdk';
import type { PlacePickerOption } from '@oxy.so/bloom/place-picker';
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

/** A GoWay search result as a Bloom `PlacePicker` option, carrying its structured postal facts. */
export type GoWayPlaceOption = PlacePickerOption & { postal: PostalAddress };

/**
 * The row a picker shows for a GoWay candidate: GoWay's own label first, then
 * the street, locality and country it sits in — each only when the label does
 * not already say it, so a POI ("Cadena SER") gains its address and a street
 * address is not repeated. The coordinate is GoWay's verbatim; the postal facts
 * are only the structured ones (`postalAddressFromResult`), never parsed out of
 * the label.
 */
export function placeOptionFromResult(result: SearchResult): GoWayPlaceOption {
  const postal = postalAddressFromResult(result);
  const country = result.address?.country ?? result.context?.country;
  const subtitle = [postal.line1, postal.city, country]
    .filter((part): part is string => Boolean(part) && !result.displayName.includes(part as string))
    .join(', ');
  return {
    id: result.id,
    title: result.displayName,
    ...(subtitle ? { subtitle } : {}),
    coordinate: { latitude: result.coordinate.latitude, longitude: result.coordinate.longitude },
    postal,
  };
}
