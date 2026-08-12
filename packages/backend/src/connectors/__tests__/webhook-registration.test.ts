/**
 * Unit tests for the shared webhook reconcile (#218) — the algorithm both
 * providers drive, with no transport, no provider and no database.
 *
 * The contract suite measures it end to end through each real provider against
 * a real Postgres server; these cases pin the branches a platform is hard to
 * push into from there: a listing refusal, a delete that will not delete, an
 * unclassifiable status, and the exact-URL comparison that keeps one
 * connection's reconcile away from another's subscriptions.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyWebhookHttpStatus,
  reconcileWebhookSubscriptions,
  type WebhookProbe,
  type WebhookRegistrationPlan,
} from '../webhook-registration.js';
import type { PlatformWebhookSubscription } from '../types.js';

const OURS = 'https://api.mercaria.test/channels/webhooks/shopify';
const TOPICS = ['products/create', 'products/update', 'orders/create'] as const;

/** A recording plan over an in-memory subscription set. */
function makePlan(options: {
  existing?: PlatformWebhookSubscription[];
  adoptExisting: boolean;
  listRefusal?: Extract<WebhookProbe<never>, { outcome: 'refused' }>;
  refuseCreate?: (topic: string) => Extract<WebhookProbe<never>, { outcome: 'refused' }> | undefined;
  refuseRemove?: (id: string) => Extract<WebhookProbe<never>, { outcome: 'refused' }> | undefined;
}): {
  plan: WebhookRegistrationPlan;
  created: string[];
  removed: string[];
} {
  const existing = [...(options.existing ?? [])];
  const created: string[] = [];
  const removed: string[] = [];
  let nextId = 100;
  const plan: WebhookRegistrationPlan = {
    topics: TOPICS,
    deliveryUrl: OURS,
    adoptExisting: options.adoptExisting,
    list: () =>
      Promise.resolve(
        options.listRefusal ? options.listRefusal : { outcome: 'ok', value: [...existing] },
      ),
    create: (topic) => {
      const refusal = options.refuseCreate?.(topic);
      if (refusal) {
        return Promise.resolve(refusal);
      }
      created.push(topic);
      nextId += 1;
      const id = `new-${nextId}`;
      existing.push({ id, topic, deliveryUrl: OURS });
      return Promise.resolve({ outcome: 'ok', value: id });
    },
    remove: (id) => {
      const refusal = options.refuseRemove?.(id);
      if (refusal) {
        return Promise.resolve(refusal);
      }
      removed.push(id);
      const index = existing.findIndex((subscription) => subscription.id === id);
      if (index >= 0) {
        existing.splice(index, 1);
      }
      return Promise.resolve({ outcome: 'ok', value: undefined });
    },
  };
  return { plan, created, removed };
}

describe('classifyWebhookHttpStatus', () => {
  it('maps each status onto the remedy it implies, and nothing else onto a plausible one', () => {
    expect(classifyWebhookHttpStatus(401)).toBe('permission_denied');
    expect(classifyWebhookHttpStatus(403)).toBe('permission_denied');
    expect(classifyWebhookHttpStatus(429)).toBe('rate_limited');
    expect(classifyWebhookHttpStatus(400)).toBe('topic_not_supported');
    expect(classifyWebhookHttpStatus(422)).toBe('topic_not_supported');
    expect(classifyWebhookHttpStatus(500)).toBe('platform_error');
    expect(classifyWebhookHttpStatus(503)).toBe('platform_error');
    // A 404 is the webhook ROUTE missing — a deployment or API-version fault,
    // and NOT evidence about the topic. Folding it into `topic_not_supported`
    // would tell a merchant their platform does not send an event it sends
    // perfectly well.
    expect(classifyWebhookHttpStatus(404)).toBe('unexpected_response');
    expect(classifyWebhookHttpStatus(418)).toBe('unexpected_response');
  });
});

describe('reconcileWebhookSubscriptions', () => {
  it('creates every topic on an empty platform', async () => {
    const { plan, created, removed } = makePlan({ adoptExisting: true });

    const result = await reconcileWebhookSubscriptions(plan);

    expect(created).toEqual([...TOPICS]);
    expect(removed).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.subscriptions.map((subscription) => subscription.topic)).toEqual([...TOPICS]);
  });

  it('ADOPTS an existing subscription and deletes only its DUPLICATES', async () => {
    const { plan, created, removed } = makePlan({
      adoptExisting: true,
      existing: [
        { id: 'keep', topic: 'products/create', deliveryUrl: OURS },
        { id: 'dup', topic: 'products/create', deliveryUrl: OURS },
      ],
    });

    const result = await reconcileWebhookSubscriptions(plan);

    expect(created).toEqual(['products/update', 'orders/create']);
    expect(removed).toEqual(['dup']);
    expect(result.subscriptions).toContainEqual({ id: 'keep', topic: 'products/create' });
    expect(result.failures).toEqual([]);
  });

  it('RECREATES rather than adopting when the secret is per-subscription', async () => {
    // A WooCommerce subscription is signed with a secret chosen at creation and
    // never disclosed again, so keeping one means keeping a subscription this
    // registration cannot verify. The delete is what makes the stored secret
    // true of every id beside it.
    const { plan, created, removed } = makePlan({
      adoptExisting: false,
      existing: [{ id: 'stale', topic: 'products/create', deliveryUrl: OURS }],
    });

    const result = await reconcileWebhookSubscriptions(plan);

    expect(removed).toEqual(['stale']);
    expect(created).toEqual([...TOPICS]);
    expect(result.subscriptions.map((subscription) => subscription.id)).not.toContain('stale');
  });

  it('does NOT create when the delete before a recreate is refused', async () => {
    // The duplicate this would produce delivers under a secret Mercaria does not
    // hold, beside one it does — so the honest outcome is a refused TOPIC, not a
    // second subscription.
    const { plan, created } = makePlan({
      adoptExisting: false,
      existing: [{ id: 'stuck', topic: 'products/update', deliveryUrl: OURS }],
      refuseRemove: (id) =>
        id === 'stuck' ? { outcome: 'refused', reason: 'permission_denied', httpStatus: 403 } : undefined,
    });

    const result = await reconcileWebhookSubscriptions(plan);

    expect(created).not.toContain('products/update');
    expect(result.failures).toEqual([
      { topic: 'products/update', reason: 'permission_denied', httpStatus: 403 },
    ]);
    expect(result.subscriptions.map((subscription) => subscription.topic)).toEqual([
      'products/create',
      'orders/create',
    ]);
  });

  it('reports every topic refused when the platform will not LIST', async () => {
    // Without the list there is no way to tell an existing subscription from an
    // absent one, so creating would duplicate every topic on precisely the shops
    // already broken. None of these events will arrive, and all of them say so.
    const { plan, created } = makePlan({
      adoptExisting: true,
      listRefusal: { outcome: 'refused', reason: 'permission_denied', httpStatus: 403 },
    });

    const result = await reconcileWebhookSubscriptions(plan);

    expect(created).toEqual([]);
    expect(result.subscriptions).toEqual([]);
    expect(result.failures).toEqual(
      TOPICS.map((topic) => ({ topic, reason: 'permission_denied', httpStatus: 403 })),
    );
  });

  it('carries a refusal with NO status when the call never reached the platform', async () => {
    const { plan } = makePlan({
      adoptExisting: true,
      refuseCreate: (topic) =>
        topic === 'orders/create' ? { outcome: 'refused', reason: 'transport_error' } : undefined,
    });

    const result = await reconcileWebhookSubscriptions(plan);

    // `httpStatus` ABSENT rather than zero: a transport error has no status, and
    // a zero is a status nobody answered.
    expect(result.failures).toEqual([{ topic: 'orders/create', reason: 'transport_error' }]);
    expect('httpStatus' in result.failures[0]).toBe(false);
  });

  it('touches NOTHING delivering anywhere but our exact URL', async () => {
    // A prefix comparison would delete the first of these — another connection's
    // subscription, whose URL is ours plus an id. That is a cross-store deletion
    // dressed as tidying up, and it is why the comparison is exact.
    const foreign: PlatformWebhookSubscription[] = [
      { id: 'other-connection', topic: 'products/create', deliveryUrl: `${OURS}/conn-2` },
      { id: 'someone-elses-app', topic: 'products/create', deliveryUrl: 'https://elsewhere.test/hook' },
    ];
    const { plan, removed } = makePlan({ adoptExisting: false, existing: [...foreign] });

    const result = await reconcileWebhookSubscriptions(plan);

    expect(removed).toEqual([]);
    expect(result.subscriptions.map((subscription) => subscription.id)).not.toContain(
      'other-connection',
    );
  });

  it('deletes a subscription of OURS for a topic this connector no longer wants', async () => {
    const { plan, removed } = makePlan({
      adoptExisting: true,
      existing: [{ id: 'retired', topic: 'products/retired-topic', deliveryUrl: OURS }],
    });

    const result = await reconcileWebhookSubscriptions(plan);

    expect(removed).toEqual(['retired']);
    // Not a failure: nothing wanted it, so no event fails to arrive.
    expect(result.failures).toEqual([]);
  });
});
