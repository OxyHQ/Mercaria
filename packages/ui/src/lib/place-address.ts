import type { Place } from '@goway.to/sdk';

/** GoWay's own address formatting, or only the structured facts it publishes. */
export function placeAddressLine(place: Pick<Place, 'address'>): string {
  const address = place.address;
  if (address === undefined) return '';
  if (address.formatted !== undefined && address.formatted.trim() !== '') return address.formatted.trim();
  const street = [address.street, address.houseNumber].filter(present).map(part => part.trim()).join(' ');
  const town = [address.postalCode, address.city].filter(present).map(part => part.trim()).join(' ');
  const country = present(address.country) ? address.country : address.countryCode;
  return [street, address.locality, town, address.region, country].filter(present).map(part => part.trim()).join(', ');
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}
