/**
 * The two endpoint subscription lists, pinned against ADR 0001.
 *
 * These lists are not an implementation detail: they are what gets typed into
 * the Stripe dashboard when the endpoints are registered, and they are what
 * decides whether an authentic delivery is refused as wrong-scope. A silent
 * divergence between the ADR and the code means either an event Mercaria never
 * receives, or one it receives and refuses — and both fail in production,
 * quietly, months after the change.
 *
 * Written out verbatim here rather than imported from the source, deliberately.
 * A test that asserted `STRIPE_PLATFORM_EVENT_TYPES` equals itself would pass
 * forever; the value of this file is that the expected lists were transcribed
 * from the ADR by hand, so changing the source alone breaks it.
 */

import { describe, it, expect } from 'vitest';
import {
  isWrongScope,
  STRIPE_CONNECT_EVENT_TYPES,
  STRIPE_PLATFORM_EVENT_TYPES,
} from '../event-scopes.js';
import { routedStripeEventTypes } from '../stripe-event-router.js';
import { STRIPE_API_VERSION } from '../client.js';

/** ADR 0001, "Stripe configuration" — platform scope (`connect=false`). */
const ADR_PLATFORM = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.canceled',
  'charge.succeeded',
  'charge.updated',
  'charge.refunded',
  'charge.refund.updated',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'transfer.created',
  'transfer.updated',
  'transfer.reversed',
];

/** ADR 0001, "Stripe configuration" — connect scope (`connect=true`). */
const ADR_CONNECT = [
  'account.updated',
  'account.application.deauthorized',
  'account.external_account.updated',
  'payout.paid',
  'payout.failed',
];

describe('the subscription lists match ADR 0001', () => {
  it('platform scope', () => {
    expect([...STRIPE_PLATFORM_EVENT_TYPES]).toEqual(ADR_PLATFORM);
  });

  it('connect scope', () => {
    expect([...STRIPE_CONNECT_EVENT_TYPES]).toEqual(ADR_CONNECT);
  });

  it('the two scopes are disjoint', () => {
    /**
     * The scope check is built on the assumption that a type belongs to at most
     * one endpoint. A type in both would make `isWrongScope` refuse a delivery
     * at BOTH paths — an endpoint that rejects everything it subscribes to.
     */
    const overlap = ADR_PLATFORM.filter((type) => ADR_CONNECT.includes(type));
    expect(overlap).toEqual([]);
  });

  it('the API version is the one the ADR pins', () => {
    // ADR 0001: "API version pinned in code (SDK constant, not env):
    // 2026-07-29.dahlia". Bumping the `stripe` dependency changes the SDK's
    // `LatestApiVersion` literal, which makes `client.ts` fail to compile until
    // this constant is deliberately moved with it — this pins the ADR's half.
    expect(STRIPE_API_VERSION).toBe('2026-07-29.dahlia');
  });
});

describe('every subscribed type has a handler', () => {
  it('no type is subscribed to that this version cannot route', () => {
    /**
     * An unrouted subscribed type is stored with "no handler in this version",
     * which is safe but is not what the ADR promises. This catches a list being
     * extended without its handler — the direction that produces silent
     * non-handling of an event someone deliberately turned on.
     */
    const routed = new Set(routedStripeEventTypes());
    const unrouted = [...ADR_PLATFORM, ...ADR_CONNECT].filter((type) => !routed.has(type));
    expect(unrouted).toEqual([]);
  });

  it('routes exactly the subscribed types plus the one documented extra', () => {
    /**
     * The reverse direction, and the vacuity guard for the test above: a router
     * that handled every string would satisfy it. `payment_intent.requires_action`
     * is the ONE type routed without being subscribed — see the router's
     * `HANDLERS` docblock — and naming it here means a second undocumented
     * addition has to be justified rather than just added.
     */
    expect([...routedStripeEventTypes()].sort()).toEqual(
      [...ADR_PLATFORM, ...ADR_CONNECT, 'payment_intent.requires_action'].sort(),
    );
  });
});

describe('isWrongScope', () => {
  it('refuses the other endpoint\'s types, at both endpoints', () => {
    expect(isWrongScope('platform', 'payout.paid')).toBe(true);
    expect(isWrongScope('connect', 'payment_intent.succeeded')).toBe(true);
  });

  it('accepts an endpoint\'s own types', () => {
    expect(isWrongScope('platform', 'payment_intent.succeeded')).toBe(false);
    expect(isWrongScope('connect', 'account.updated')).toBe(false);
  });

  it('accepts a type in NEITHER list, at both endpoints', () => {
    /**
     * An unrecognised type is STORED as evidence rather than refused (#45's
     * rule, restated in `event-scopes.ts`): refusing it would make an endpoint
     * someone subscribed to `*` retry into a 400 until Stripe disabled it.
     */
    expect(isWrongScope('platform', 'invoice.paid')).toBe(false);
    expect(isWrongScope('connect', 'invoice.paid')).toBe(false);
  });
});
