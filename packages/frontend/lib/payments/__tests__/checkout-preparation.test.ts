import { describe, expect, it } from 'vitest';
import type { CartGroup } from '@mercaria/shared-types';
import {
  checkoutAddress,
  checkoutInput,
  checkoutPreflight,
  profileAddressCandidates,
} from '../checkout-preparation';
const address = {
  id: 'same-id',
  recipientName: 'Recipient',
  line1: '1 Example Street',
  city: 'Hong Kong',
  postalCode: '',
  country: 'HK',
  isDefault: true,
};
const group: CartGroup = {
  vendor: { kind: 'store', id: 'store', name: 'Store' },
  sellerKey: 'platform',
  commercial: {
    mode: 'connected_marketplace',
    sellerKind: 'store',
    sellerLabel: 'Store',
    sellerRole: 'direct',
    disclosures: [],
  },
  subtotal: { amount: 100, currency: 'USD' },
  items: [
    {
      listingId: 'item',
      variantId: 'variant',
      title: 'Item',
      variantTitle: '',
      quantity: 1,
      available: 1,
      delivery: 'shipped',
      unitPrice: { amount: 100, currency: 'USD' },
      lineTotal: { amount: 100, currency: 'USD' },
    },
  ],
};
const extra = {
  discount: '',
  supplyCountry: '',
  digitalConsent: false,
  pickupEmail: '',
  pickupPhone: '',
};
const details = {
  email: '',
  shipping: checkoutAddress(address, 'oxy').address,
  selectedAddressId: 'oxy:same-id',
};
describe('account checkout composition', () => {
  it('namespaces private and legacy ids and snapshots the reviewed address without requiring email', () => {
    expect(checkoutAddress(address, 'oxy').id).not.toBe(checkoutAddress(address, 'mercaria').id);
    const input = checkoutInput(
      details,
      { groups: [group], currency: 'USD', sellerKeys: ['platform'] },
      extra,
    );
    expect(input.destination).toEqual({
      type: 'inline_shipping_address',
      address: {
        recipientName: 'Recipient',
        line1: address.line1,
        city: 'Hong Kong',
        postalCode: '',
        country: 'HK',
      },
    });
    expect(input.contact).toBeUndefined();
    expect(input.sellerKeys).toEqual(['platform']);
  });
  it('uses an explicit collector, never the payer email, and no invented shipping address', () => {
    const input = checkoutInput(
      { ...details, email: 'payer@example.test' },
      { groups: [group], currency: 'USD', sellerKeys: [], pickupLocationId: 'pickup' },
      { ...extra, pickupEmail: 'collector@example.test' },
    );
    expect(input.destination).toEqual({
      type: 'pickup',
      locationId: 'pickup',
      pickupContact: { email: 'collector@example.test' },
    });
  });
  it('digital-only supply sends the declared country and consent without a destination', () => {
    const digital = {
      ...group,
      items: group.items.map((item) => ({ ...item, delivery: 'digital' as const })),
    };
    expect(
      checkoutInput(
        details,
        { groups: [digital], currency: 'USD', sellerKeys: [] },
        { ...extra, digitalConsent: true, supplyCountry: 'es' },
      ),
    ).toMatchObject({
      destination: { type: 'digital_delivery' },
      digitalSupplyCountry: 'ES',
      digitalSupplyConsent: true,
    });
  });
  it('imports only structured own-profile locations for explicit recipient review', () => {
    expect(
      profileAddressCandidates({
        address: '1 Street, Spain',
        locations: [{ address: { formattedAddress: '1 Street, Spain' } }],
      }),
    ).toEqual([]);
    const [candidate] = profileAddressCandidates({
      locations: [
        {
          id: 'home',
          name: 'Home',
          address: {
            streetNumber: '10',
            street: 'Example Street',
            city: 'Madrid',
            country: 'Spain',
          },
          metadata: { countryCode: 'es' },
        },
      ],
    });
    expect(candidate?.requiresReview).toBe(true);
    expect(candidate?.address).toMatchObject({
      name: '',
      country: 'ES',
      line1: '10 Example Street',
    });
    expect(
      profileAddressCandidates({
        locations: [{ address: { city: 'Madrid', country: 'Spain' } }],
      })[0]?.address.country,
    ).toBe('');
  });
  it('uses the shared server postcode and contact policy before starting an order', () => {
    const input = checkoutInput(
      details,
      { groups: [group], currency: 'USD', sellerKeys: [] },
      extra,
    );
    expect(checkoutPreflight(input)).toBeNull();
    if (input.destination?.type !== 'inline_shipping_address')
      throw new Error('fixture destination');
    input.destination.address.country = 'ES';
    expect(checkoutPreflight(input)).toBeTruthy();
    input.destination.address.postalCode = '28001';
    input.contact = { email: 'x@y.c' };
    expect(checkoutPreflight(input)).toBeTruthy();
    input.contact = { email: 'buyer@example.test' };
    expect(checkoutPreflight(input)).toBeNull();
  });
  it('ignores a stale pickup route for a digital-only cart', () => {
    const digital = {
      ...group,
      items: group.items.map((item) => ({ ...item, delivery: 'digital' as const })),
    };
    expect(
      checkoutInput(
        details,
        { groups: [digital], currency: 'USD', sellerKeys: [], pickupLocationId: 'stale' },
        { ...extra, digitalConsent: true, supplyCountry: 'HK' },
      ).destination,
    ).toEqual({ type: 'digital_delivery' });
  });
});
