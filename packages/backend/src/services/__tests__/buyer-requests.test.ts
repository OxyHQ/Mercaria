/**
 * The PURE halves of #110 — the eligibility policy, the redaction pass, the
 * authorization matrix and the two merchant projections.
 *
 * Everything here is a function with no database, no clock beyond the one
 * passed in and no configuration, which is what makes each of them a TABLE a
 * test can drive rather than a behaviour assembled from six routes. What needs
 * a real server — the CHECKs, the partial uniques, the append-only triggers —
 * is in `db/__tests__/buyer-requests.realdb.test.ts` and deliberately not
 * mocked here.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MERCHANT_BUYER_REQUEST_FIELDS,
  BUYER_REQUEST_FORBIDDEN_IDENTIFIERS,
  DEFAULT_RETURN_WINDOW_DAYS,
  RETURN_RESOLUTIONS,
  SUPPORTED_RETURN_RESOLUTIONS,
  SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES,
} from '@mercaria/shared-types';
import {
  cancellationEligibilityWithOpenRequest,
  resolveCancellationEligibility,
  resolveReturnEligibility,
  returnEligibilityWithOpenRequest,
  returnWindowAnchor,
  returnWindowDays,
  type BuyerRequestOrderFacts,
} from '../buyer-requests/policy.js';
import { redactSupportBody } from '../buyer-requests/redaction.js';
import {
  BUYER_REQUEST_ACTIONS,
  STEP_UP_REQUIRED_ACTIONS,
  authorizeBuyerRequest,
  denialIsAboutTheOrder,
  operatorDecisionActor,
  sellerDecisionActor,
  actorAuditColumns,
} from '../buyer-requests/authorization.js';
import {
  MERCHANT_REQUESTER_LABEL,
  toMerchantCancellationRequestView,
  toMerchantReturnRequestView,
} from '../buyer-requests/projection.js';
import type { OrderAccessFacts } from '../orders/order-access.service.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function orderFacts(overrides: Partial<BuyerRequestOrderFacts> = {}): BuyerRequestOrderFacts {
  return {
    id: 'order-1',
    status: 'paid',
    paymentStatus: 'paid',
    shippingMethod: 'standard',
    sourceExternalId: null,
    statusHistory: [{ status: 'paid', at: new Date('2026-05-01T00:00:00.000Z') }],
    storeReturnWindowDays: null,
    ...overrides,
  };
}

describe('cancellation eligibility', () => {
  it('is a REFUND once money has moved and a RELEASE before', () => {
    // The mode is decided by the PAYMENT state, never by the status: an order
    // can be `processing` and unpaid on a rail that captures late, and
    // cancelling that must release a reservation rather than refund nothing.
    const paid = resolveCancellationEligibility(orderFacts({ paymentStatus: 'paid' }));
    expect(paid).toEqual({ verdict: 'eligible', mode: 'refund' });
    const unpaid = resolveCancellationEligibility(
      orderFacts({ status: 'processing', paymentStatus: 'pending' }),
    );
    expect(unpaid).toEqual({ verdict: 'eligible', mode: 'release' });
  });

  it('closes once the goods have LEFT, read from the history and not the status', () => {
    // An order that shipped and was then partially refunded reads
    // `partially_refunded` today. Asking "is it shipped" of the current status
    // would answer no and offer a cancellation on goods already with the buyer.
    const shippedThenPartiallyRefunded = orderFacts({
      status: 'partially_refunded',
      statusHistory: [
        { status: 'paid', at: new Date('2026-05-01T00:00:00.000Z') },
        { status: 'shipped', at: new Date('2026-05-02T00:00:00.000Z') },
        { status: 'partially_refunded', at: new Date('2026-05-03T00:00:00.000Z') },
      ],
    });
    expect(resolveCancellationEligibility(shippedThenPartiallyRefunded)).toEqual({
      verdict: 'ineligible',
      reason: 'order_already_dispatched',
    });
  });

  it('refuses a closed order, an imported one and a pickup', () => {
    expect(resolveCancellationEligibility(orderFacts({ status: 'refunded' })).verdict).toBe(
      'ineligible',
    );
    expect(
      resolveCancellationEligibility(orderFacts({ sourceExternalId: 'shopify-1' })),
    ).toEqual({ verdict: 'ineligible', reason: 'external_order' });
    expect(resolveCancellationEligibility(orderFacts({ shippingMethod: 'pickup' }))).toEqual({
      verdict: 'ineligible',
      reason: 'pickup_not_supported',
    });
  });

  it('reports a live request as its own reason, not as a generic refusal', () => {
    // The buyer's remedy differs: "somebody already asked, read that request"
    // and "it already shipped, open a return" lead to opposite actions, which
    // is why this is not one `not_cancellable` code.
    expect(cancellationEligibilityWithOpenRequest(orderFacts(), true)).toEqual({
      verdict: 'ineligible',
      reason: 'request_already_open',
    });
  });
});

describe('return eligibility and its window', () => {
  const shipped = new Date('2026-05-20T00:00:00.000Z');
  const delivered = new Date('2026-05-25T00:00:00.000Z');

  it('anchors on DELIVERED when there is one, else on SHIPPED', () => {
    // A seller who never marks an order delivered must not be able to run a
    // buyer's return window out by inaction.
    expect(
      returnWindowAnchor(
        orderFacts({
          statusHistory: [
            { status: 'shipped', at: shipped },
            { status: 'delivered', at: delivered },
          ],
        }),
      ),
    ).toEqual(delivered);
    expect(returnWindowAnchor(orderFacts({ statusHistory: [{ status: 'shipped', at: shipped }] }))).toEqual(
      shipped,
    );
  });

  it('uses the STORE window when there is one and the generous default when not', () => {
    expect(returnWindowDays(orderFacts({ storeReturnWindowDays: 14 }))).toBe(14);
    // A P2P seller has no store row and has stated no policy, so inventing a
    // shorter window on their behalf would take a consumer right away by
    // omission.
    expect(returnWindowDays(orderFacts({ storeReturnWindowDays: null }))).toBe(
      DEFAULT_RETURN_WINDOW_DAYS,
    );
  });

  it('refuses a return before dispatch and offers a cancellation instead', () => {
    const undispatched = orderFacts();
    expect(resolveReturnEligibility(undispatched, NOW)).toEqual({
      verdict: 'ineligible',
      reason: 'order_not_delivered',
    });
  });

  it('closes exactly at the window and not a moment after', () => {
    const facts = orderFacts({
      storeReturnWindowDays: 10,
      statusHistory: [{ status: 'delivered', at: new Date('2026-05-01T00:00:00.000Z') }],
    });
    const inside = resolveReturnEligibility(facts, new Date('2026-05-10T23:59:00.000Z'));
    expect(inside.verdict).toBe('eligible');
    // A boundary case, because a window that is off by a day is a consumer
    // right silently shortened.
    const outside = resolveReturnEligibility(facts, new Date('2026-05-11T00:00:01.000Z'));
    expect(outside).toEqual({ verdict: 'ineligible', reason: 'return_window_closed' });
  });

  it('tells a buyer about the WINDOW before telling them there are no units left', () => {
    const expired = orderFacts({
      storeReturnWindowDays: 1,
      statusHistory: [{ status: 'delivered', at: new Date('2026-05-01T00:00:00.000Z') }],
    });
    // The deadline is the fact they can act on; "nothing left" would read as an
    // accusation and would be the less useful of the two.
    expect(
      returnEligibilityWithOpenRequest(
        expired,
        { hasOpenRequest: false, hasReturnableUnits: false },
        NOW,
      ),
    ).toEqual({ verdict: 'ineligible', reason: 'return_window_closed' });
  });
});

describe('support message redaction', () => {
  it('removes a card number, an IBAN, an email, a phone and a Mercaria token', () => {
    const cases: [string, string][] = [
      ['my card is 4111 1111 1111 1111', 'payment_card'],
      ['pay me at ES91 2100 0418 4502 0005 1332', 'iban'],
      ['write to me at someone@example.com', 'email_address'],
      ['call me on +34 600 123 456', 'phone_number'],
      ['my link was mgp_abcdefghijklmnopqrstuvwxyz012345', 'access_token'],
    ];
    for (const [body, kind] of cases) {
      const result = redactSupportBody(body);
      expect(result.redactions, `${body} was not recognised`).toContain(kind);
      expect(result.body).not.toBe(body);
    }
  });

  it('leaves an order number and a postal code alone', () => {
    // The fixture that makes the phone rule's MANDATORY separators load-bearing:
    // without them `order MRC-000123 4021 8899` reads as a phone number, and a
    // support channel that cannot quote a reference is useless for the thing it
    // exists for.
    const body = 'Order MRC-000123, postcode 08001, tracking 4021 8899 — where is it?';
    const result = redactSupportBody(body);
    expect(result.redactions).toEqual([]);
    expect(result.body).toBe(body);
  });

  it('returns the original text byte for byte when nothing matched', () => {
    const body = 'Hello, is my parcel on its way?';
    expect(redactSupportBody(body).body).toBe(body);
  });

  it('redacts every occurrence, not only the first', () => {
    // The `g` flag makes `lastIndex` stateful, so a module-level pattern reused
    // across two messages would skip the start of the second — a bug that
    // appears only under load and looks exactly like a leak.
    const result = redactSupportBody('a@b.com and c@d.com');
    expect(result.body).not.toContain('a@b.com');
    expect(result.body).not.toContain('c@d.com');
  });

  it('is stateless across calls', () => {
    const first = redactSupportBody('x@y.com');
    const second = redactSupportBody('x@y.com');
    expect(second.body).toBe(first.body);
    expect(second.redactions).toEqual(first.redactions);
  });
});

describe('authorization', () => {
  const order: OrderAccessFacts = {
    id: 'order-1',
    buyer: { origin: 'guest', guestCheckoutId: 'contact-1' },
    checkoutGroupId: 'group-1',
    sellerType: 'user',
    sellerOxyUserId: 'seller-1',
    storeId: null,
  };

  /** A live, email-verified portal grant over `group-1`. */
  function grant(overrides: Record<string, unknown> = {}) {
    return {
      id: 'grant-1',
      checkoutGroupId: 'group-1',
      scopes: ['orders:read', 'cancellations:request', 'returns:request', 'support:write'],
      emailVerifiedAt: new Date(NOW.getTime() - 60_000),
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      revokedAt: null,
      ...overrides,
    } as never;
  }

  it('authorizes a verified, fresh credential for a mutation', () => {
    const result = authorizeBuyerRequest({
      credential: { kind: 'guest_portal', grant: grant() },
      order,
      action: 'cancellation:submit',
      now: NOW,
    });
    expect(result.outcome).toBe('authorized');
    if (result.outcome !== 'authorized') return;
    expect(result.actor.kind).toBe('guest');
    expect(result.actor.grantId).toBe('grant-1');
    // The audit records the GRANT and never an Oxy id — invariant I1 reaching
    // the trail (ADR 0003 D16).
    expect(actorAuditColumns(result.actor)).toEqual({
      actorKind: 'guest',
      actorGrantId: 'grant-1',
    });
  });

  it('refuses a credential whose scope set lacks the action — rule 1', () => {
    // A read-only session. The whole point of #110 authorization rule 1.
    const result = authorizeBuyerRequest({
      credential: { kind: 'guest_portal', grant: grant({ scopes: ['orders:read'] }) },
      order,
      action: 'cancellation:submit',
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'scope_not_granted' });
    expect(denialIsAboutTheOrder('scope_not_granted')).toBe(false);
  });

  it('refuses a stale inbox proof for a SUBMIT and admits it for a WITHDRAW', () => {
    const stale = grant({ emailVerifiedAt: new Date(NOW.getTime() - 30 * 86_400_000) });
    expect(
      authorizeBuyerRequest({
        credential: { kind: 'guest_portal', grant: stale },
        order,
        action: 'cancellation:submit',
        now: NOW,
      }),
    ).toEqual({ outcome: 'refused', reason: 'step_up_required' });
    // The undo of a buyer's own mistake is the SAFE direction and must not sit
    // behind an email round trip.
    expect(
      authorizeBuyerRequest({
        credential: { kind: 'guest_portal', grant: stale },
        order,
        action: 'cancellation:withdraw',
        now: NOW,
      }).outcome,
    ).toBe('authorized');
  });

  it('refuses a credential for ANOTHER checkout group — rules 4 and 5', () => {
    const result = authorizeBuyerRequest({
      credential: { kind: 'guest_portal', grant: grant({ checkoutGroupId: 'group-2' }) },
      order,
      action: 'cancellation:submit',
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'grant_scope_mismatch' });
    // Answered 404 by the routes: "this order exists but is not yours" is a
    // fact about somebody else's purchase.
    expect(denialIsAboutTheOrder('grant_scope_mismatch')).toBe(true);
  });

  it('refuses an expired and a revoked credential', () => {
    expect(
      authorizeBuyerRequest({
        credential: {
          kind: 'guest_portal',
          grant: grant({ expiresAt: new Date(NOW.getTime() - 1) }),
        },
        order,
        action: 'support:write',
        now: NOW,
      }),
    ).toEqual({ outcome: 'refused', reason: 'grant_expired' });
    expect(
      authorizeBuyerRequest({
        credential: { kind: 'guest_portal', grant: grant({ revokedAt: NOW }) },
        order,
        action: 'support:write',
        now: NOW,
      }),
    ).toEqual({ outcome: 'refused', reason: 'grant_revoked' });
  });

  it('refuses an unverified credential BEFORE it looks at the scope', () => {
    // The order half runs first, so a credential that cannot see the order at
    // all never learns whether it had the scope — which is what keeps a scope
    // refusal from becoming an oracle over somebody else's order.
    const result = authorizeBuyerRequest({
      credential: {
        kind: 'guest_portal',
        grant: grant({ emailVerifiedAt: null, scopes: ['tracking:read'] }),
      },
      order,
      action: 'cancellation:submit',
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'grant_not_email_verified' });
  });

  it('refuses an Oxy account that is neither the buyer nor a claimant', () => {
    expect(
      authorizeBuyerRequest({
        credential: { kind: 'oxy_account', oxyUserId: 'somebody-else' },
        order,
        action: 'cancellation:submit',
        now: NOW,
      }),
    ).toEqual({ outcome: 'refused', reason: 'order_unclaimed' });
  });

  it('authorizes the CLAIMANT of a guest order — rule 7', () => {
    // "A claimed checkout may use authenticated Oxy authorization while
    // preserving the original guest audit": the claimant is authorized here,
    // and nothing in this path rewrites a request the guest filed.
    const claimed: OrderAccessFacts = {
      ...order,
      buyer: { origin: 'guest', guestCheckoutId: 'contact-1', claimedByOxyUserId: 'claimant-1' },
    };
    const result = authorizeBuyerRequest({
      credential: { kind: 'oxy_account', oxyUserId: 'claimant-1' },
      order: claimed,
      action: 'return:submit',
      now: NOW,
    });
    expect(result.outcome).toBe('authorized');
    if (result.outcome !== 'authorized') return;
    // An Oxy caller proves itself on every request, so there is no staleness to
    // measure and no scope set to consult.
    expect(result.actor.kind).toBe('oxy');
    expect(result.actor.grantId).toBeUndefined();
  });

  it('the action table and the step-up set agree with each other', () => {
    // A mutation self-test on the policy table: a step-up action that is not an
    // action at all, or an action whose `requiresStepUp` disagrees with the
    // set, is the shape that makes one of the two silently decorative.
    for (const action of STEP_UP_REQUIRED_ACTIONS) {
      expect(BUYER_REQUEST_ACTIONS[action].requiresStepUp).toBe(true);
    }
    for (const [action, policy] of Object.entries(BUYER_REQUEST_ACTIONS)) {
      expect(policy.requiresStepUp).toBe(
        STEP_UP_REQUIRED_ACTIONS.includes(action as keyof typeof BUYER_REQUEST_ACTIONS),
      );
    }
  });

  it('a DECIDER is always a named account', () => {
    expect(actorAuditColumns(sellerDecisionActor('member-1', 'cancellation:decide'))).toEqual({
      actorKind: 'oxy',
      actorOxyUserId: 'member-1',
    });
    expect(actorAuditColumns(operatorDecisionActor('op-1', 'return:refund'))).toEqual({
      actorKind: 'operator',
      actorOxyUserId: 'op-1',
    });
  });
});

describe('merchant projections', () => {
  const cancellationRow = {
    id: 'req-1',
    orderId: 'order-1',
    state: 'submitted' as const,
    reason: 'changed_my_mind' as const,
    note: 'sorry',
    completionMode: 'refund' as const,
    wholeOrder: true,
    decisionNote: null,
    completionFailure: null,
    decidedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    refundId: null,
    idempotencyKey: null,
    requestedByActorKind: 'guest' as const,
    decidedByActorKind: null,
    decidedByOxyUserId: null,
  };

  const returnRow = {
    ...cancellationRow,
    state: 'requested' as const,
    reason: 'arrived_damaged' as const,
    resolution: 'refund' as const,
    returnInstructions: null,
    returnWindowEndsAt: NOW,
    shipBackDeadlineAt: null,
    receivedAt: null,
  };

  it('emits ONLY allow-listed fields — a runtime walk, not a type', () => {
    // The gate a type cannot give: a field forwarded through an `any`-shaped
    // boundary, or added to the row and spread into a serializer, would still
    // appear. `Omit<T, never>` was the first spelling of this rule and could
    // never fail, which is why the allow-list is a VALUE.
    const views = [
      toMerchantCancellationRequestView(cancellationRow as never, []),
      toMerchantReturnRequestView(returnRow as never, [], []),
    ];
    expect(views.length).toBe(2);
    for (const view of views) {
      const keys = Object.keys(view);
      // A vacuity floor: an empty projection would satisfy the loop below.
      expect(keys.length).toBeGreaterThan(8);
      for (const key of keys) {
        expect(
          (MERCHANT_BUYER_REQUEST_FIELDS as readonly string[]).includes(key),
          `the merchant projection emits an unlisted field: ${key}`,
        ).toBe(true);
      }
    }
  });

  it('labels every requester `Buyer` and never leaks a buyer-origin discriminant', () => {
    const view = toMerchantCancellationRequestView(cancellationRow as never, []);
    expect(view.requesterLabel).toBe(MERCHANT_REQUESTER_LABEL);
    expect(view.requesterLabel).toBe('Buyer');
    // Merchant rule 7: nothing in the projection says whether an Oxy account
    // exists behind this purchase, so a seller cannot treat a guest's request
    // differently even if they wanted to.
    const serialized = JSON.stringify(view);
    for (const word of ['guest', 'oxy', 'Guest #']) {
      expect(serialized.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe('the domain vocabularies', () => {
  it('offers only the resolutions this deployment can carry out', () => {
    // `replacement` is REPRESENTABLE and unsupported — the `role_email`
    // decision from #83. Deleting the value would make the gap invisible and
    // turn enabling it into a migration.
    expect(RETURN_RESOLUTIONS).toContain('replacement');
    expect(SUPPORTED_RETURN_RESOLUTIONS).not.toContain('replacement');
    expect(SUPPORTED_RETURN_RESOLUTIONS).toEqual(['refund']);
  });

  it('names its prohibitions as values a gate can assert against', () => {
    expect(BUYER_REQUEST_FORBIDDEN_IDENTIFIERS).toContain('buyer_email');
    expect(BUYER_REQUEST_FORBIDDEN_IDENTIFIERS).toContain('cart_session_token');
    expect(SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES).toContain('public_review');
    expect(SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES).toContain('crowdsource_case');
  });

  it('the notification helpers return void, so a failure cannot roll anything back', async () => {
    // Communication rule 6, held by the SIGNATURE: there is nothing to await,
    // so a caller who tried would get a `tsc` error and a queue failure can
    // never join a money transaction.
    const notifications = await import('../buyer-requests/notifications.js');
    const spy = vi.fn();
    for (const [name, fn] of Object.entries(notifications)) {
      if (typeof fn !== 'function') continue;
      spy(name, fn.length);
    }
    expect(spy).toHaveBeenCalled();
    // Every exported notifier is a plain function returning `undefined`.
    expect(
      notifications.notifyCancellationReceived({ id: 'o', checkoutGroupId: null }, 'r'),
    ).toBeUndefined();
    expect(notifications.notifyRefundPending({ id: 'o', checkoutGroupId: null }, 'r')).toBeUndefined();
  });
});
