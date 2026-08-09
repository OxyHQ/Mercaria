/**
 * The three pure rules every observation path shares, and the capability
 * boundary that bounds what a provider may claim.
 *
 * Pure and therefore exhaustively testable, which matters more here than usual:
 * a webhook, a poll, a submission answer and a convergence lookup all route
 * through `decideProviderObservation`, so a wrong answer is wrong four times
 * and in the same direction.
 */

import { describe, expect, it } from 'vitest';
import type {
  SupplierAdapterCapability,
  SupplierOrderState,
  SupplierOrderSubmission,
} from '@mercaria/shared-types';
import {
  SUPPLIER_ORDER_NORMALIZED_STATES,
  SUPPLIER_ORDER_STATE_RANK,
} from '@mercaria/shared-types';
import { PURCHASE_ORDER_LEGAL_TRANSITIONS } from '../../procurement/purchase-order.service.js';
import {
  applyDeclaredCancellationCapabilities,
  applyDeclaredOrderCapabilities,
  applyDeclaredOrderStateCapabilities,
  unknownSubmission,
} from '../adapter.js';
import {
  PURCHASE_ORDER_STATUS_BY_PROVIDER_STATE,
  decideProviderObservation,
  isStaleObservation,
  isStateRegression,
} from '../state-mapping.js';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const EARLIER = new Date('2026-08-09T11:00:00.000Z');
const LATER = new Date('2026-08-09T13:00:00.000Z');

function submission(overrides: Partial<SupplierOrderSubmission> = {}): SupplierOrderSubmission {
  return { ...unknownSubmission(1, NOW), ...overrides };
}

describe('the provider-state mapping', () => {
  it('has an entry for every normalized state', () => {
    // The anti-vacuity floor: a state added to the union with no mapping entry
    // would read as `undefined` and be treated as "no status change", which is
    // the silent direction.
    for (const state of SUPPLIER_ORDER_NORMALIZED_STATES) {
      expect(Object.hasOwn(PURCHASE_ORDER_STATUS_BY_PROVIDER_STATE, state)).toBe(true);
      expect(Object.hasOwn(SUPPLIER_ORDER_STATE_RANK, state)).toBe(true);
    }
  });

  it('maps a PARTIAL state to the whole-order status, not to a status of its own', () => {
    // The partiality is the line-outcome trail; a second status would be a
    // second representation of one fact.
    expect(PURCHASE_ORDER_STATUS_BY_PROVIDER_STATE.partially_accepted).toBe('accepted');
    expect(PURCHASE_ORDER_STATUS_BY_PROVIDER_STATE.partially_shipped).toBe('shipped');
  });

  it('moves nothing for the states that are supplier FACTS rather than transitions', () => {
    expect(PURCHASE_ORDER_STATUS_BY_PROVIDER_STATE.unknown).toBeNull();
    expect(PURCHASE_ORDER_STATUS_BY_PROVIDER_STATE.received).toBeNull();
    expect(PURCHASE_ORDER_STATUS_BY_PROVIDER_STATE.processing).toBeNull();
  });
});

describe('staleness and regression are DIFFERENT questions', () => {
  it('reads an equal timestamp as stale', () => {
    // `<=` and not `<`: an observation bearing the same instant carries no new
    // ordering information, and admitting it would let a redelivery re-run
    // every consequence of a state change.
    expect(isStaleObservation({ appliedObservedAt: NOW, observedAt: NOW })).toBe(true);
    expect(isStaleObservation({ appliedObservedAt: NOW, observedAt: LATER })).toBe(false);
    expect(isStaleObservation({ appliedObservedAt: null, observedAt: EARLIER })).toBe(false);
  });

  it('reads a lower-ranked state as a regression, and `unknown` as neither', () => {
    expect(isStateRegression({ appliedState: 'shipped', observedState: 'accepted' })).toBe(true);
    expect(isStateRegression({ appliedState: 'accepted', observedState: 'shipped' })).toBe(false);
    // `unknown` is an unmapped state, which is its own outcome — reporting it
    // as a regression would send it to the wrong queue.
    expect(isStateRegression({ appliedState: 'shipped', observedState: 'unknown' })).toBe(false);
  });

  it('ranks the three terminal states together with `delivered`', () => {
    // Ranking a cancellation below a shipment would make a legitimate late
    // cancellation read as a regression.
    expect(SUPPLIER_ORDER_STATE_RANK.cancelled).toBe(SUPPLIER_ORDER_STATE_RANK.delivered);
    expect(SUPPLIER_ORDER_STATE_RANK.rejected).toBe(SUPPLIER_ORDER_STATE_RANK.delivered);
  });
});

describe('deciding what one observation does', () => {
  const base = {
    currentStatus: 'submitted' as const,
    appliedState: 'received' as const,
    appliedObservedAt: NOW,
    legalNextStatuses: PURCHASE_ORDER_LEGAL_TRANSITIONS.submitted,
  };

  it('asks staleness FIRST, so a late delivery is not reported as a regression', () => {
    // The order of the checks is load-bearing: an at-least-once webhook stream
    // delivers old events routinely, and reporting each as a regression would
    // fill the operator queue with ordinary behaviour.
    expect(
      decideProviderObservation({
        ...base,
        appliedState: 'shipped',
        observedState: 'accepted',
        observedAt: EARLIER,
      }),
    ).toEqual({ action: 'ignore_stale' });
  });

  it('raises an unmapped state rather than guessing at the nearest one', () => {
    expect(
      decideProviderObservation({ ...base, observedState: 'unknown', observedAt: LATER }),
    ).toEqual({ action: 'raise_unmapped' });
  });

  it('advances the clock for a state that implies no status change', () => {
    // Without this branch the monotonic guard would only advance on
    // transitions, and a status confirmed for a week would keep re-admitting a
    // week-old redelivery.
    expect(
      decideProviderObservation({ ...base, observedState: 'processing', observedAt: LATER }),
    ).toEqual({ action: 'advance_only' });
  });

  it('applies a legal edge and REFUSES an illegal one', () => {
    expect(
      decideProviderObservation({ ...base, observedState: 'accepted', observedAt: LATER }),
    ).toEqual({ action: 'apply', nextStatus: 'accepted' });

    // A shipment on an order Mercaria has already cancelled. The machine has no
    // such edge, and forcing it would make a parcel nobody expects look like a
    // fulfilment somebody asked for.
    expect(
      decideProviderObservation({
        currentStatus: 'cancelled',
        appliedState: 'cancelled',
        appliedObservedAt: NOW,
        observedState: 'shipped',
        observedAt: LATER,
        legalNextStatuses: PURCHASE_ORDER_LEGAL_TRANSITIONS.cancelled,
      }),
    ).toEqual({ action: 'raise_illegal_transition', nextStatus: 'shipped' });
  });
});

describe('the order capability boundary', () => {
  const FULL: SupplierAdapterCapability[] = [
    'order_draft_submission',
    'order_state_read',
    'order_reference_lookup',
    'order_cancellation',
    'order_partial_acceptance',
    'shipment_read',
    'tracking_events',
  ];

  it('downgrades a partial acceptance to `unknown`, never to `accepted`', () => {
    // The direction is the whole rule: it lands on the value that BLOCKS, not
    // the one that commits. The supplier may well have accepted everything —
    // what is missing is Mercaria's right to tell a customer which lines.
    const result = applyDeclaredOrderCapabilities(
      submission({
        state: 'partially_accepted',
        lineOutcomes: [
          { clientLineReference: 'line-1', kind: 'accepted', quantity: 1, reasonCode: null },
        ],
      }),
      FULL.filter((entry) => entry !== 'order_partial_acceptance'),
    );
    expect(result.answer.state).toBe('unknown');
    expect(result.answer.lineOutcomes).toEqual([]);
    expect(result.downgrades.map((entry) => entry.commitment)).toContain(
      'assumed_partial_acceptance',
    );
    // A downgrade NAMES the emulation it prevented rather than dropping the
    // field silently — a seam that looks like a real answer is worse than a
    // refusal.
    expect(result.downgrades[0]?.explanation.length).toBeGreaterThan(20);
  });

  it('keeps a partial acceptance when the capability IS declared', () => {
    // The mutation-shaped half: without this, a boundary that downgraded
    // everything unconditionally would pass the test above.
    const result = applyDeclaredOrderCapabilities(
      submission({
        state: 'partially_accepted',
        lineOutcomes: [
          { clientLineReference: 'line-1', kind: 'accepted', quantity: 1, reasonCode: null },
        ],
      }),
      FULL,
    );
    expect(result.answer.state).toBe('partially_accepted');
    expect(result.answer.lineOutcomes).toHaveLength(1);
    expect(result.downgrades).toEqual([]);
  });

  it('refuses a delivery from an adapter that cannot read an order back', () => {
    const result = applyDeclaredOrderCapabilities(
      submission({ state: 'delivered' }),
      ['order_draft_submission'],
    );
    expect(result.answer.state).toBe('unknown');
    expect(result.downgrades.map((entry) => entry.commitment)).toContain('assumed_delivery');
  });

  it('refuses an unverifiable dedupe claim', () => {
    // A dedupe claim Mercaria cannot confirm is what closes an ambiguity, and
    // closing one on an unverifiable claim is how one customer order becomes
    // two supplier orders.
    const result = applyDeclaredOrderCapabilities(
      submission({ state: 'accepted', duplicateOfExistingOrder: true }),
      ['order_draft_submission', 'order_state_read'],
    );
    expect(result.answer.duplicateOfExistingOrder).toBe(false);
    expect(result.downgrades.map((entry) => entry.commitment)).toContain(
      'emulated_provider_idempotency',
    );
  });

  it('strips shipments, scans and a cancellability claim the adapter cannot back', () => {
    const state: SupplierOrderState = {
      ...submission({ state: 'shipped' }),
      cancellable: true,
      shipments: [
        {
          shipmentReference: null,
          trackingNumber: 'T1',
          carrier: null,
          service: null,
          shippedAt: NOW.toISOString(),
          deliveredAt: null,
          packages: [],
          trackingEvents: [
            {
              status: 'in_transit',
              occurredAt: NOW.toISOString(),
              description: null,
              locationCountry: null,
              locationRegion: null,
            },
          ],
        },
      ],
    };
    const result = applyDeclaredOrderStateCapabilities(state, ['order_draft_submission']);
    expect(result.answer.shipments).toEqual([]);
    expect(result.answer.cancellable).toBe(false);
    const commitments = result.downgrades.map((entry) => entry.commitment);
    expect(commitments).toContain('synthetic_shipment');
    expect(commitments).toContain('assumed_cancellation_accepted');
  });

  it('strips only the SCANS when shipments are declared and tracking is not', () => {
    const state: SupplierOrderState = {
      ...submission({ state: 'shipped' }),
      cancellable: false,
      shipments: [
        {
          shipmentReference: null,
          trackingNumber: 'T1',
          carrier: null,
          service: null,
          shippedAt: NOW.toISOString(),
          deliveredAt: null,
          packages: [],
          trackingEvents: [
            {
              status: 'in_transit',
              occurredAt: NOW.toISOString(),
              description: null,
              locationCountry: null,
              locationRegion: null,
            },
          ],
        },
      ],
    };
    const result = applyDeclaredOrderStateCapabilities(state, [
      'order_draft_submission',
      'order_state_read',
      'shipment_read',
    ]);
    expect(result.answer.shipments).toHaveLength(1);
    expect(result.answer.shipments[0]?.trackingEvents).toEqual([]);
  });

  it('strips a cancellation split from an adapter that cannot report one', () => {
    const result = applyDeclaredCancellationCapabilities(
      {
        state: 'accepted',
        reasonCode: null,
        providerMessage: null,
        observedAt: NOW.toISOString(),
        lineOutcomes: [
          { clientLineReference: 'line-1', kind: 'cancelled', quantity: 1, reasonCode: null },
        ],
      },
      ['order_cancellation'],
    );
    expect(result.answer.lineOutcomes).toEqual([]);
    expect(result.downgrades).toHaveLength(1);
  });
});

describe('the unknown submission', () => {
  it('has no external order id and no state, whatever it is given', () => {
    // The ONE function every failed call produces. There is deliberately no
    // parameter that could make it answer anything else — which is what makes a
    // lost response AMBIGUOUS rather than a failure somebody could retry past.
    const answer = unknownSubmission(7, NOW);
    expect(answer.externalOrderId).toBeNull();
    expect(answer.state).toBe('unknown');
    expect(answer.duplicateOfExistingOrder).toBe(false);
    expect(answer.stateMappingVersion).toBe(7);
  });
});
