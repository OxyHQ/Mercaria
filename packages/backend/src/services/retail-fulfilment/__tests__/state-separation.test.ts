/**
 * The six examples #126 §"State separation" names, each as a test.
 *
 * They are all the same shape: set ONE axis's evidence to something dramatic
 * and assert every other axis is unmoved. That shape is the point — the failure
 * this whole module exists to prevent is a derivation reading one axis's
 * evidence for another, and it is invisible in any test that only checks the
 * axis it set.
 */

import { describe, expect, it } from 'vitest';
import type { MoovoTransportProjection } from '@mercaria/shared-types';
import {
  MOOVO_PROJECTION_STALE_AFTER_MS,
  deriveRetailFulfilmentStates,
} from '../state-separation.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');

function projection(overrides: Partial<MoovoTransportProjection> = {}): MoovoTransportProjection {
  return {
    transportRequestId: 'mvo-transport-1',
    state: 'in_transit',
    observedAt: NOW.toISOString(),
    sourceVersion: 4,
    shipmentCount: 1,
    ...overrides,
  };
}

describe('#126 state separation, example by example', () => {
  it('1. supplier accepted does not mean shipped', () => {
    const view = deriveRetailFulfilmentStates({
      orderStatus: 'paid',
      orderPaymentStatus: 'paid',
      procurementStatus: 'accepted',
      preparationStatus: 'planned',
      now: NOW,
    });
    expect(view.supplier_procurement).toEqual({
      known: true,
      state: 'accepted',
      observedAt: NOW.toISOString(),
      stale: false,
    });
    // Nothing physical has been asserted, so the transport axis has no state at
    // all — not `shipped`, and not a coarse "probably on its way".
    expect(view.transport_projection.known).toBe(false);
    expect(view.customer_order_payment).toMatchObject({ state: 'paid/paid' });
  });

  it('2. label created does not necessarily mean carrier pickup', () => {
    const view = deriveRetailFulfilmentStates({
      orderStatus: 'processing',
      orderPaymentStatus: 'paid',
      transportProjection: projection({ state: 'label_created' }),
      now: NOW,
    });
    // Copied verbatim. The two states are separate members of Moovo's own
    // vocabulary and this module maps a state to itself — a widening step here
    // is what would make a printed label read as a collected parcel.
    expect(view.transport_projection).toMatchObject({ known: true, state: 'label_created' });
    expect(view.transport_projection).not.toMatchObject({ state: 'awaiting_collection' });
  });

  it('3. carrier delivered does not settle a buyer dispute automatically', () => {
    const view = deriveRetailFulfilmentStates({
      orderStatus: 'delivered',
      orderPaymentStatus: 'paid',
      transportProjection: projection({ state: 'delivered' }),
      // A dispute is open and nothing has been refunded.
      now: NOW,
    });
    expect(view.transport_projection).toMatchObject({ known: true, state: 'delivered' });
    expect(view.refund_reconciliation).toEqual({ known: false, reason: 'no_refund' });
  });

  it('4. return delivered to the supplier does not complete a refund', () => {
    const view = deriveRetailFulfilmentStates({
      orderStatus: 'delivered',
      orderPaymentStatus: 'paid',
      returnAuthorizationStatus: 'approved',
      returnTransportProjection: projection({
        transportRequestId: 'mvo-return-1',
        state: 'delivered',
      }),
      now: NOW,
    });
    expect(view.return_transport).toMatchObject({ known: true, state: 'delivered' });
    // The refund axis reads the order's refund state and nothing else, so a
    // completed reverse movement leaves it exactly where it was.
    expect(view.refund_reconciliation).toEqual({ known: false, reason: 'no_refund' });
  });

  it('5. an unknown Moovo state remains unknown, and has no state to display', () => {
    const view = deriveRetailFulfilmentStates({
      orderStatus: 'processing',
      orderPaymentStatus: 'paid',
      now: NOW,
    });
    expect(view.transport_projection).toEqual({
      known: false,
      reason: 'moovo_projection_unavailable',
    });
    // The absence of a `state` key is the assertion. A sentinel string would be
    // displayable, and the first surface to render it would say something about
    // a parcel Mercaria knows nothing about.
    expect('state' in view.transport_projection).toBe(false);
  });

  it('6. return-to-sender is not ordinary cancellation', () => {
    const view = deriveRetailFulfilmentStates({
      orderStatus: 'shipped',
      orderPaymentStatus: 'paid',
      transportProjection: projection({ state: 'returned_to_sender' }),
      now: NOW,
    });
    expect(view.transport_projection).toMatchObject({ state: 'returned_to_sender' });
    // The commercial order is untouched: it is still a shipped, paid order
    // whose goods are coming back, which needs a decision nobody has made yet.
    expect(view.customer_order_payment).toMatchObject({ state: 'shipped/paid' });
  });
});

describe('staleness is derived against the reader clock', () => {
  it('reports a projection older than the bound as stale, with no sweep', () => {
    const view = deriveRetailFulfilmentStates({
      orderStatus: 'shipped',
      orderPaymentStatus: 'paid',
      transportProjection: projection({
        observedAt: new Date(NOW.getTime() - MOOVO_PROJECTION_STALE_AFTER_MS - 1000).toISOString(),
      }),
      now: NOW,
    });
    expect(view.transport_projection).toMatchObject({ known: true, stale: true });
  });

  it('reports one inside the bound as fresh', () => {
    const view = deriveRetailFulfilmentStates({
      orderStatus: 'shipped',
      orderPaymentStatus: 'paid',
      transportProjection: projection({
        observedAt: new Date(NOW.getTime() - MOOVO_PROJECTION_STALE_AFTER_MS + 1000).toISOString(),
      }),
      now: NOW,
    });
    expect(view.transport_projection).toMatchObject({ known: true, stale: false });
  });

  it('answers UNKNOWN — not fresh — when the observation time is unreadable', () => {
    // The failing direction matters. An unparseable timestamp treated as `now`
    // would make a projection of unknown age read as the freshest thing in the
    // view, which is the one answer a surface must never be given.
    const view = deriveRetailFulfilmentStates({
      orderStatus: 'shipped',
      orderPaymentStatus: 'paid',
      transportProjection: projection({ observedAt: 'whenever' }),
      now: NOW,
    });
    expect(view.transport_projection).toEqual({
      known: false,
      reason: 'moovo_observation_time_unreadable',
    });
  });
});

describe('every axis has its own evidence', () => {
  it('leaves the other six unknown when only the order is known', () => {
    const view = deriveRetailFulfilmentStates({
      orderStatus: 'paid',
      orderPaymentStatus: 'paid',
      now: NOW,
    });
    const unknown = Object.entries(view)
      .filter(([, axis]) => !axis.known)
      .map(([name]) => name)
      .sort();
    expect(unknown).toEqual([
      'preparation_fulfilment',
      'refund_reconciliation',
      'return_authorization',
      'return_transport',
      'supplier_procurement',
      'transport_projection',
    ]);
  });
});
