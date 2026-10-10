import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@goway.to/sdk';
import { hasRequiredPostalFields, postalAddressFromResult } from '../goway-address';

const result: SearchResult = {
  id: 'address-result', displayName: 'Museum — not a street address', kind: 'address',
  coordinate: { latitude: 41.38, longitude: 2.17 }, source: 'goway',
  address: { street: 'Carrer de Mallorca', houseNumber: '401', city: 'Barcelona', postalCode: '08013', countryCode: 'ES' },
};

describe('GoWay postal address selection', () => {
  it('uses structured facts, without leaking display names, coordinates or provider ids into shipping fields', () => {
    expect(postalAddressFromResult(result)).toEqual({ line1: 'Carrer de Mallorca 401', city: 'Barcelona', postalCode: '08013', region: '', country: 'ES' });
    expect(hasRequiredPostalFields(postalAddressFromResult(result))).toBe(true);
  });
  it('leaves missing postal facts empty for review instead of guessing them from a POI label', () => {
    const address = postalAddressFromResult({ ...result, kind: 'poi', address: undefined, context: { city: 'Barcelona', countryCode: 'ES' } });
    expect(address).toEqual({ line1: '', city: 'Barcelona', postalCode: '', region: '', country: 'ES' });
    expect(hasRequiredPostalFields(address)).toBe(false);
  });
  it('clears absent fields when replacing a selected address and normalizes the country code', () => {
    const previous = { line1: 'Old address', city: 'Old city', region: 'Old region', postalCode: '00000', country: 'GB' };
    const address = { ...previous, ...postalAddressFromResult({ ...result, address: { street: 'Gran Via', countryCode: 'es' } }) };
    expect(address).toEqual({ line1: 'Gran Via', city: '', region: '', postalCode: '', country: 'ES' });
    expect(hasRequiredPostalFields(address)).toBe(false);
  });
});
