/**
 * #125 acceptance criterion 1: the Printful adapter passes #124's common
 * conformance suite.
 *
 * One runner, no parallel suite. Everything the fourteen cases assert — the
 * supplier, the account, the agreement, the customer order, the purchase order,
 * the payment authorization, the attempt log, the convergence path, the
 * redaction — is built by `runSupplierAdapterConformanceSuite`, so this adapter
 * is measured against the same commercial setup the fake one is, against a REAL
 * Postgres server, through the REAL orchestration.
 *
 * The harness supplies a fake WIRE rather than a fake adapter. That is what
 * makes case 2's and case 3b's oracle meaningful: "did a second supplier order
 * get placed" is a question only the transport can answer.
 */

import { describe, expect, it } from 'vitest';
import {
  runSupplierAdapterConformanceSuite,
  type ConformanceScenario,
} from '../../supplier-orders/__tests__/adapter-conformance-suite.js';
import {
  createPrintfulOrderAdapter,
  PRINTFUL_CAPABILITIES,
  PRINTFUL_PROVIDER,
} from '../../supplier-orders/adapters/printful.js';
import { createFakePrintfulTransport } from './fake-printful-transport.js';

const transport = createFakePrintfulTransport();
const adapter = createPrintfulOrderAdapter(transport);

runSupplierAdapterConformanceSuite({
  provider: PRINTFUL_PROVIDER,
  adapter,
  credential: transport.credential,
  inject(clientReference: string, scenario: ConformanceScenario) {
    transport.inject(clientReference, scenario);
  },
  setIdempotencySupport(honours: boolean) {
    transport.setIdempotencySupport(honours);
  },
  reset() {
    transport.reset();
  },
  hasOrder(clientReference: string) {
    return transport.hasOrder(clientReference);
  },
  webhookDelivery(input) {
    // Shaped as Printful documents a callback: a type, a creation instant and
    // the order it is about. The `secret` is what this adapter verifies —
    // Printful's exact signing scheme is account-gated
    // (`docs/suppliers/printful.md` §15), and the adapter says so.
    const body = Buffer.from(
      JSON.stringify({
        secret: 'webhook-secret',
        type: input.providerState === 'fulfilled' ? 'package_shipped' : 'order_updated',
        created: Math.floor(input.observedAt.getTime() / 1_000),
        data: {
          order: {
            id: input.externalOrderId ?? 'pf-1',
            external_id: input.clientReference,
            status: input.providerState,
          },
        },
      }),
      'utf8',
    );
    return { body, headers: { 'content-type': 'application/json' } };
  },
});

describe('the Printful adapter declares only what Printful can do', () => {
  it('declares no reservation, no price guarantee and no quote expiry', () => {
    // Print-on-demand holds nothing and guarantees nothing. Each absence makes
    // the matching claim UNREPRESENTABLE at #122's boundary rather than merely
    // unused, so a later change that starts returning one is downgraded and
    // reported as a contract violation instead of quietly believed.
    expect(PRINTFUL_CAPABILITIES).not.toContain('inventory_reservation');
    expect(PRINTFUL_CAPABILITIES).not.toContain('price_guarantee');
    expect(PRINTFUL_CAPABILITIES).not.toContain('quote_expiry');
  });

  it('declares no partial acceptance, no tracking events and no RMA', () => {
    expect(PRINTFUL_CAPABILITIES).not.toContain('order_partial_acceptance');
    expect(PRINTFUL_CAPABILITIES).not.toContain('tracking_events');
    expect(PRINTFUL_CAPABILITIES).not.toContain('return_authorization');
    expect(PRINTFUL_CAPABILITIES).not.toContain('invoice_retrieval');
    expect(PRINTFUL_CAPABILITIES).not.toContain('credit_note_retrieval');
  });

  it('implements a method for every capability it DOES declare', () => {
    // The registry enforces this at registration; asserting it here names the
    // adapter rather than failing at boot in whichever deployment registers it
    // first. `order_reference_lookup` is the one that matters most: without it
    // an ambiguity cannot converge and every lost response becomes an
    // operator's row.
    expect(PRINTFUL_CAPABILITIES).toContain('order_reference_lookup');
    expect(typeof adapter.findOrderByClientReference).toBe('function');
    expect(typeof adapter.submitOrder).toBe('function');
    expect(typeof adapter.cancelOrder).toBe('function');
    expect(typeof adapter.readOrder).toBe('function');
    expect(typeof adapter.readShipments).toBe('function');
    expect(typeof adapter.verifyWebhook).toBe('function');
    expect(typeof adapter.pollChanges).toBe('function');
    // And the converse: it declares no reservation, so it offers no release.
    expect(adapter.releaseReservation).toBeUndefined();
  });

  it('maps an unrecognised Printful status to `unknown`, never a guess', () => {
    expect(adapter.mapProviderState('fulfilled')).toBe('shipped');
    expect(adapter.mapProviderState('pending')).toBe('accepted');
    // `returned` is deliberately unmapped: a parcel that came back is neither
    // delivered nor cancelled, and there is no normalized state that says it.
    expect(adapter.mapProviderState('returned')).toBe('unknown');
    expect(adapter.mapProviderState('something_printful_added_later')).toBe('unknown');
  });

  it('never produces `delivered`, because Printful never asserts delivery', () => {
    // Its lifecycle ends at handover to a carrier. An invented delivery would
    // start the return window from a date nobody observed.
    const produced = [
      'draft',
      'pending',
      'onhold',
      'inprocess',
      'partial',
      'fulfilled',
      'canceled',
      'failed',
    ].map((status) => adapter.mapProviderState(status));
    expect(produced).not.toContain('delivered');
  });
});
