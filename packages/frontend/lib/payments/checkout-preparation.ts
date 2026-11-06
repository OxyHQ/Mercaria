import type { Address, CartGroup, CheckoutInput, CurrencyCode } from '@mercaria/shared-types';
import type { SheetCheckoutDetails, SheetSavedAddress } from '@peable.to/sdk/checkout/ui';

/** Keep source ids distinct: an Oxy id is never a Mercaria database key. */
export function checkoutAddress(
  address: Omit<Address, 'createdAt' | 'updatedAt'>,
  source: 'oxy' | 'mercaria',
): SheetSavedAddress {
  return {
    id: `${source}:${address.id}`,
    label: address.label || address.recipientName,
    address: {
      name: address.recipientName,
      line1: address.line1,
      line2: address.line2 ?? '',
      city: address.city,
      state: address.region ?? '',
      postalCode: address.postalCode,
      country: address.country,
      phone: address.phone ?? '',
    },
  };
}

export interface CheckoutSelection {
  readonly currency: CurrencyCode;
  readonly sellerKeys: readonly string[];
  readonly groups: readonly CartGroup[];
  readonly pickupLocationId?: string;
}

/** All fields, including supplemental merchant consent, become one immutable attempt. */
export function checkoutInput(
  details: SheetCheckoutDetails,
  selection: CheckoutSelection,
  extra: {
    discount: string;
    supplyCountry: string;
    digitalConsent: boolean;
    pickupEmail: string;
    pickupPhone: string;
  },
): CheckoutInput {
  const shipping = details.shipping;
  const ships = selection.groups.some((group) =>
    group.items.some((item) => item.delivery !== 'digital'),
  );
  const digital = selection.groups.some((group) =>
    group.items.some((item) => item.delivery === 'digital'),
  );
  return {
    destination: selection.pickupLocationId
      ? {
          type: 'pickup',
          locationId: selection.pickupLocationId,
          pickupContact: {
            email: extra.pickupEmail.trim(),
            ...(extra.pickupPhone.trim() ? { phone: extra.pickupPhone.trim() } : {}),
          },
        }
      : !ships
        ? { type: 'digital_delivery' }
        : {
            type: 'inline_shipping_address',
            // Freeze the full reviewed address, including saved addresses. No second lookup can change it.
            address: {
              recipientName: shipping.name.trim(),
              line1: shipping.line1.trim(),
              ...(shipping.line2.trim() ? { line2: shipping.line2.trim() } : {}),
              city: shipping.city.trim(),
              ...(shipping.state.trim() ? { region: shipping.state.trim() } : {}),
              postalCode: shipping.postalCode.trim(),
              country: shipping.country.toUpperCase(),
              ...(shipping.phone.trim() ? { phone: shipping.phone.trim() } : {}),
            },
          },
    ...(details.email.trim() ? { contact: { email: details.email.trim() } } : {}),
    ...(selection.sellerKeys.length ? { sellerKeys: [...selection.sellerKeys] } : {}),
    ...(extra.discount.trim() ? { discountCodes: [extra.discount.trim()] } : {}),
    ...(digital ? { digitalSupplyConsent: extra.digitalConsent } : {}),
    ...(!ships ? { digitalSupplyCountry: extra.supplyCountry.trim().toUpperCase() } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Structured own-profile places are review candidates, never inferred delivery destinations. */
export function profileAddressCandidates(user: unknown): SheetSavedAddress[] {
  const locations = record(user)?.locations;
  if (!Array.isArray(locations)) return [];
  return locations.flatMap((value, index) => {
    const place = record(value);
    const address = record(place?.address);
    if (!place || !address) return [];
    const street = text(address.street);
    const city = text(address.city);
    if (!street && !city) return []; // Never parse formattedAddress or profile.address.
    const country = text(record(place.metadata)?.countryCode).toUpperCase();
    return [
      {
        id: `profile:${text(place.id) || index}`,
        label: text(place.label) || text(place.name) || street || city,
        requiresReview: true,
        address: {
          name: '',
          line1: [text(address.streetNumber), street].filter(Boolean).join(' '),
          line2: text(address.streetDetails),
          city,
          state: text(address.state),
          postalCode: text(address.postalCode),
          country: /^[A-Z]{2}$/.test(country) ? country : '',
          phone: '',
        },
      },
    ];
  });
}
