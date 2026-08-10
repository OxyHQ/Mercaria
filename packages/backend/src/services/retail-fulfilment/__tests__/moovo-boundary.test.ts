/**
 * What Moovo receives, and what happens when Moovo is not there (#126 privacy
 * 2/3/4 and the fail-closed seam).
 *
 * Two things are under test and they are separate failures:
 *
 *  - the DISCLOSURE gate, whose failure is a buyer's email or a portal
 *    credential leaving Mercaria in a logistics payload; and
 *  - the PORT's default, whose failure is a seam that looks like it works.
 *
 * The second is worth stating plainly because it is the one that would pass
 * review: a default that returned a plausible transport handle would make every
 * test here green, every downstream derivation confident, and the whole of
 * #156–#159 look already done.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { MOOVO_LOGISTICS_OPERATIONS, type MoovoTransportEndpoint } from '@mercaria/shared-types';
import {
  MOOVO_REQUEST_ALLOWED_KEYS,
  MOOVO_REQUEST_FORBIDDEN_KEYS,
  assertMoovoRequestDisclosure,
  composeMoovoTransportRequest,
} from '../moovo-request.js';
import {
  isMoovoBookingAvailable,
  moovoLogisticsPort,
  registerMoovoLogisticsPort,
  resetMoovoLogisticsPort,
  unregisteredMoovoLogisticsPort,
} from '../moovo.port.js';

afterEach(() => {
  resetMoovoLogisticsPort();
});

const ENDPOINT: MoovoTransportEndpoint = {
  contactName: 'Buyer',
  contactPhone: null,
  line1: '1 Market Street',
  line2: null,
  city: 'Valencia',
  region: null,
  postalCode: '46001',
  country: 'ES',
};

describe('the Moovo request vocabulary', () => {
  it('keeps the allowed and forbidden key sets DISJOINT', () => {
    // The `RETAIL_FORBIDDEN_COMPONENT_KIND` device. An overlap would let a
    // forbidden key be admitted by the allow-list while the prohibition list
    // still claimed to forbid it, which reads as protection and is none.
    const overlap = MOOVO_REQUEST_FORBIDDEN_KEYS.filter((key) =>
      MOOVO_REQUEST_ALLOWED_KEYS.has(key),
    );
    expect(overlap).toEqual([]);
    expect(MOOVO_REQUEST_FORBIDDEN_KEYS.length).toBeGreaterThan(10);
  });
});

describe('composeMoovoTransportRequest', () => {
  const base = {
    sourceReference: 'mercaria:retail-fulfilment:abc',
    origin: { ...ENDPOINT, city: 'Madrid' },
    destination: ENDPOINT,
    lines: [{ orderItemId: 'item-1', quantity: 2, description: 'A thing' }],
  };

  it('composes a tracking-only request from supplier-booked carriage', () => {
    const request = composeMoovoTransportRequest({
      ...base,
      mode: 'supplier_controlled',
      existingCarriage: {
        carrierName: 'Whatever the supplier called it',
        trackingReference: 'TR-1',
        dispatchedAt: '2026-08-10T09:00:00.000Z',
      },
    });
    // The carrier name is passed through UNTOUCHED. Mapping it to a canonical
    // list here is the carrier-state mapping #126 acceptance 2 forbids, and it
    // would also be a second normalization of a fact Moovo owns.
    expect(request.existingCarriage?.carrierName).toBe('Whatever the supplier called it');
  });

  it('refuses a supplier-controlled request with no existing carriage', () => {
    // Without it Moovo would be asked to ARRANGE transport for a parcel a
    // carrier already has — a second booking for one movement.
    expect(() =>
      composeMoovoTransportRequest({ ...base, mode: 'supplier_controlled' }),
    ).toThrow(/tracking only/i);
  });

  it('refuses a Moovo-controlled request that carries existing carriage', () => {
    expect(() =>
      composeMoovoTransportRequest({
        ...base,
        mode: 'moovo_controlled',
        existingCarriage: {
          carrierName: 'X',
          trackingReference: 'TR-1',
          dispatchedAt: '2026-08-10T09:00:00.000Z',
        },
      }),
    ).toThrow(/duplicate shipment/i);
  });

  it('refuses a request with no source reference', () => {
    expect(() =>
      composeMoovoTransportRequest({ ...base, sourceReference: '  ', mode: 'moovo_controlled' }),
    ).toThrow(/source reference/i);
  });

  it('refuses a request with no lines', () => {
    expect(() =>
      composeMoovoTransportRequest({ ...base, lines: [], mode: 'moovo_controlled' }),
    ).toThrow(/at least one line/i);
  });
});

describe('assertMoovoRequestDisclosure', () => {
  it('throws and NAMES the prohibition for a forbidden key', () => {
    // The fixture is an object passed through whole with a buyer email riding
    // along — the shape a TYPE cannot catch, which is why the runtime walk
    // exists at all.
    expect(() =>
      assertMoovoRequestDisclosure({
        sourceReference: 'x',
        destination: { ...ENDPOINT, buyerEmail: 'someone@example.com' },
      }),
    ).toThrow(/buyerEmail/);
  });

  it('throws for a key nobody thought about, rather than dropping it', () => {
    // Two gates that fail differently, #107's arrangement: the allow-list
    // catches the unanticipated key, the forbidden list names the deliberate
    // one. Dropping silently would ship the composition that produced it.
    expect(() =>
      assertMoovoRequestDisclosure({ sourceReference: 'x', internalNote: 'VIP customer' }),
    ).toThrow(/allow-list/);
  });

  it('walks INTO arrays, where a line-level leak would sit', () => {
    expect(() =>
      assertMoovoRequestDisclosure({
        sourceReference: 'x',
        lines: [
          { orderItemId: 'a', quantity: 1, description: 'ok' },
          { orderItemId: 'b', quantity: 1, description: 'ok', supplierCost: 1234 },
        ],
      }),
    ).toThrow(/supplierCost/);
  });

  it('accepts a fully composed request', () => {
    const request = composeMoovoTransportRequest({
      sourceReference: 'mercaria:retail-fulfilment:abc',
      mode: 'moovo_controlled',
      origin: { ...ENDPOINT, city: 'Madrid' },
      destination: ENDPOINT,
      lines: [{ orderItemId: 'item-1', quantity: 1, description: 'A thing' }],
    });
    expect(() => assertMoovoRequestDisclosure(request)).not.toThrow();
  });
});

describe('the Moovo port fails closed', () => {
  it('refuses every operation and names the issue that owes it', async () => {
    const port = moovoLogisticsPort();
    const request = composeMoovoTransportRequest({
      sourceReference: 'mercaria:retail-fulfilment:abc',
      mode: 'moovo_controlled',
      origin: { ...ENDPOINT, city: 'Madrid' },
      destination: ENDPOINT,
      lines: [{ orderItemId: 'item-1', quantity: 1, description: 'A thing' }],
    });

    const results = [
      await port.registerTrackingOnlyTransport(request),
      await port.bookTransport(request),
      await port.readTransportProjection('mvo-1'),
      await port.cancelTransport('mvo-1'),
      await port.requestReturnTransport(request),
    ];
    for (const result of results) {
      expect(result.outcome).toBe('unavailable');
      if (result.outcome === 'unavailable') {
        expect(result.reason).toBe('client_not_registered');
        // The issue number in the VALUE is what makes an operator trace say
        // "#159 has not landed" rather than "logistics failed".
        expect(result.owedBy).toMatch(/^#(156|157|158|159)$/);
      }
    }
    expect(results).toHaveLength(MOOVO_LOGISTICS_OPERATIONS.length);
  });

  it('reports booking as UNAVAILABLE while the default is installed', () => {
    // Identity comparison against the refusing default, not a flag: a boolean
    // somebody sets can report `true` with the default still in place, which is
    // the one way `chooseFulfilmentMode` could pick Mode A with nothing behind
    // it.
    expect(moovoLogisticsPort()).toBe(unregisteredMoovoLogisticsPort);
    expect(isMoovoBookingAvailable()).toBe(false);
  });

  it('reports booking as available once a port is registered, and resets', () => {
    registerMoovoLogisticsPort({
      ...unregisteredMoovoLogisticsPort,
      async bookTransport() {
        return { outcome: 'ok', value: { transportRequestId: 'mvo-1', registeredAt: 'now' } };
      },
    });
    expect(isMoovoBookingAvailable()).toBe(true);
    resetMoovoLogisticsPort();
    expect(isMoovoBookingAvailable()).toBe(false);
  });
});
