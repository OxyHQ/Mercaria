import { strongestCapability, type Place } from '@goway.to/sdk';
import type { MercariaLocation } from '@mercaria/contracts';

export interface StoreContactLink {
  kind: 'phone' | 'email' | 'website';
  value: string;
  href: `${'tel' | 'mailto' | 'http' | 'https'}:${string}`;
}

/** A fresh place read must still vouch for the public location that named it. */
export function placeBelongsToLocation(location: MercariaLocation, place: Place): boolean {
  const link = strongestCapability(place, 'commerce.mercaria.store');
  // A merged place is a GoWayGoneError from the public SDK, never a Place DTO.
  return (
    place.id === location.goWayPlaceId &&
    place.status === 'active' &&
    link?.value === location.ref.id &&
    (link.verification === 'business_asserted' || link.verification === 'oxy_verified')
  );
}

/** Only published contact facts. URI data cannot add mail headers or change schemes. */
export function storeContactLinks(contact: Place['contact']): StoreContactLink[] {
  const links: StoreContactLink[] = [];
  const phone = contact?.phone?.trim();
  const email = contact?.email?.trim();
  const website = contact?.website?.trim();
  const hasControls = (value: string) =>
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    );
  if (phone && !hasControls(phone))
    links.push({ kind: 'phone', value: phone, href: `tel:${encodeURIComponent(phone)}` });
  if (email && !hasControls(email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    links.push({ kind: 'email', value: email, href: `mailto:${encodeURIComponent(email)}` });
  if (website) {
    try {
      const url = new URL(website);
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !url.username &&
        !url.password
      ) {
        links.push({ kind: 'website', value: website, href: url.href as StoreContactLink['href'] });
      }
    } catch {
      /* Unusable source facts do not become navigation targets. */
    }
  }
  return links;
}
