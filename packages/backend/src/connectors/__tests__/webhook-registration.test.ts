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
import type {
  PlatformWebhookSubscription,
  WebhookReconciliation,
  WebhookRegistrationResult,
} from '../types.js';

const OURS = 'https://api.mercaria.test/channels/webhooks/shopify';
/** The base this deployment served BEFORE somebody moved it (#295). */
const MOVED_FROM = 'https://api-preview.mercaria.test/channels/webhooks';
const TOPICS = ['products/create', 'products/update', 'orders/create'] as const;

/**
 * Narrow a result to the branch that read the platform's list.
 *
 * A THROW rather than a cast: `subscriptions` does not exist on the other
 * branch, so every case below is stating "the list was readable here" as part of
 * its own premise instead of asserting against a shape TypeScript had to be told
 * to believe in.
 */
function expectReconciled(result: WebhookRegistrationResult): WebhookReconciliation {
  if (result.outcome !== 'reconciled') {
    throw new Error(`expected a reconciled result, got outcome=${result.outcome}`);
  }
  return result;
}

/** A recording plan over an in-memory subscription set. */
function makePlan(options: {
  existing?: PlatformWebhookSubscription[];
  adoptExisting: boolean;
  /** Ids Mercaria has recorded for this connection (#295). */
  owned?: readonly string[];
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
    ownedSubscriptionIds: options.owned ?? [],
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

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(created).toEqual([...TOPICS]);
    expect(removed).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.subscriptions.map((subscription) => subscription.topic)).toEqual([...TOPICS]);
    // Every one was made HERE, which is what lets the caller store the secret it
    // passed in. A registration that created nothing must not replace it.
    expect(result.subscriptions.every((subscription) => subscription.origin === 'created')).toBe(
      true,
    );
  });

  it('ADOPTS an existing subscription and deletes only its DUPLICATES', async () => {
    const { plan, created, removed } = makePlan({
      adoptExisting: true,
      existing: [
        { id: 'keep', topic: 'products/create', deliveryUrl: OURS },
        { id: 'dup', topic: 'products/create', deliveryUrl: OURS },
      ],
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(created).toEqual(['products/update', 'orders/create']);
    expect(removed).toEqual(['dup']);
    expect(result.subscriptions).toContainEqual({
      id: 'keep',
      topic: 'products/create',
      origin: 'retained',
    });
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

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

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

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(created).not.toContain('products/update');
    expect(result.failures).toEqual([
      { topic: 'products/update', reason: 'permission_denied', httpStatus: 403 },
    ]);
    expect(result.subscriptions.map((subscription) => subscription.topic).sort()).toEqual([
      'orders/create',
      'products/create',
      'products/update',
    ]);
  });

  it('RETAINS the id of a subscription the platform would not delete', async () => {
    // #218 again, one layer down. `stuck` is still live at OUR delivery URL and
    // still delivering — signed, on a `per_connection` platform, with a secret
    // this attempt is about to replace. Dropping its id makes it an orphan
    // nobody holds a handle for: the next reconcile finds it and disconnect
    // cannot reach it at all. `everything-after` is the one the loop never even
    // attempted, and it is live for the same reason.
    const { plan } = makePlan({
      adoptExisting: false,
      existing: [
        { id: 'stuck', topic: 'products/update', deliveryUrl: OURS },
        { id: 'everything-after', topic: 'products/update', deliveryUrl: OURS },
      ],
      refuseRemove: (id) =>
        id === 'stuck' ? { outcome: 'refused', reason: 'permission_denied', httpStatus: 403 } : undefined,
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(result.subscriptions).toContainEqual({
      id: 'stuck',
      topic: 'products/update',
      origin: 'retained',
    });
    expect(result.subscriptions).toContainEqual({
      id: 'everything-after',
      topic: 'products/update',
      origin: 'retained',
    });
    // RETAINED, never `created`: nothing was made with this attempt's secret for
    // this topic, so the caller must not read them as evidence to store one.
    expect(
      result.subscriptions
        .filter((subscription) => subscription.topic === 'products/update')
        .every((subscription) => subscription.origin === 'retained'),
    ).toBe(true);
  });

  it('does not treat ONE subscription listed twice as a duplicate of itself', async () => {
    // A platform may repeat a row — page-number pagination over a list that
    // shifted between requests is the way it happens. Read naively the adopt
    // branch keeps `existing[0]` and then DELETES `existing.slice(1)`, which is
    // the same id: the topic ends with nothing live and `subscriptions` names a
    // subscription that no longer exists, so the caller stores a dead id and the
    // events stop arriving. One id is one subscription.
    const { plan, created, removed } = makePlan({
      adoptExisting: true,
      existing: [
        { id: 'listed-twice', topic: 'products/create', deliveryUrl: OURS },
        { id: 'listed-twice', topic: 'products/create', deliveryUrl: OURS },
      ],
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(removed, 'the one live subscription must not be deleted as its own duplicate').toEqual(
      [],
    );
    expect(created).toEqual(['products/update', 'orders/create']);
    expect(result.subscriptions).toContainEqual({
      id: 'listed-twice',
      topic: 'products/create',
      origin: 'retained',
    });
    expect(
      result.subscriptions.filter((subscription) => subscription.id === 'listed-twice'),
    ).toHaveLength(1);
  });

  it('RETAINS a DUPLICATE it could not delete, beside the one it adopted', async () => {
    const { plan } = makePlan({
      adoptExisting: true,
      existing: [
        { id: 'keep', topic: 'products/create', deliveryUrl: OURS },
        { id: 'stubborn-dup', topic: 'products/create', deliveryUrl: OURS },
      ],
      refuseRemove: (id) =>
        id === 'stubborn-dup' ? { outcome: 'refused', reason: 'rate_limited', httpStatus: 429 } : undefined,
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    // Best-effort is about whether the reconcile PROCEEDS — the topic still
    // delivers, so it is no failure — never about whether the id is reported.
    expect(result.failures).toEqual([]);
    expect(result.subscriptions).toContainEqual({
      id: 'stubborn-dup',
      topic: 'products/create',
      origin: 'retained',
    });
  });

  it('RETAINS a RETIRED topic it could not delete', async () => {
    const { plan } = makePlan({
      adoptExisting: true,
      existing: [{ id: 'retired', topic: 'products/retired-topic', deliveryUrl: OURS }],
      refuseRemove: () => ({ outcome: 'refused', reason: 'platform_error', httpStatus: 500 }),
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(result.failures).toEqual([]);
    expect(result.subscriptions).toContainEqual({
      id: 'retired',
      topic: 'products/retired-topic',
      origin: 'retained',
    });
  });

  it('reports every topic refused when the platform will not LIST, and claims NO subscriptions', async () => {
    // Without the list there is no way to tell an existing subscription from an
    // absent one, so creating would duplicate every topic on precisely the shops
    // already broken. None of these events will arrive, and all of them say so.
    const { plan, created } = makePlan({
      adoptExisting: true,
      listRefusal: { outcome: 'refused', reason: 'permission_denied', httpStatus: 403 },
    });

    const result = await reconcileWebhookSubscriptions(plan);

    expect(created).toEqual([]);
    expect(result.failures).toEqual(
      TOPICS.map((topic) => ({ topic, reason: 'permission_denied', httpStatus: 403 })),
    );
    // The branch carries NO subscription list, which is the whole point: an
    // empty array is the claim "there are none", and the caller writing that
    // claim over a populated `webhook_ids` is #218's first consequence. There is
    // nothing here for a `?? []` to turn into one.
    expect(result.outcome).toBe('unknown');
    expect('subscriptions' in result).toBe(false);
    expect(result).toEqual({
      outcome: 'unknown',
      reason: 'permission_denied',
      httpStatus: 403,
      failures: TOPICS.map((topic) => ({ topic, reason: 'permission_denied', httpStatus: 403 })),
    });
  });

  it('omits the LISTING status too when the list call never reached the platform', async () => {
    const { plan } = makePlan({
      adoptExisting: true,
      listRefusal: { outcome: 'refused', reason: 'transport_error' },
    });

    const result = await reconcileWebhookSubscriptions(plan);

    expect(result.outcome).toBe('unknown');
    expect('httpStatus' in result).toBe(false);
  });

  it('carries a refusal with NO status when the call never reached the platform', async () => {
    const { plan } = makePlan({
      adoptExisting: true,
      refuseCreate: (topic) =>
        topic === 'orders/create' ? { outcome: 'refused', reason: 'transport_error' } : undefined,
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

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

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(removed).toEqual([]);
    expect(result.subscriptions.map((subscription) => subscription.id)).not.toContain(
      'other-connection',
    );
  });

  it('REMOVES a subscription of ours the delivery address moved away from (#295)', async () => {
    // The base URL changed — a domain migration, an environment move, an expired
    // preview deployment. `moved` is a subscription THIS connection created, now
    // pointing at a hostname this deployment no longer serves. It matches no
    // topic (the comparison is exact and must stay exact), so before #295 it was
    // simply invisible: every topic was created again and the merchant's site
    // kept a second, dead set forever.
    //
    // The id is the evidence, and it is the only evidence there is: a URL under
    // a base nobody serves says nothing about who created it, while an id in
    // `webhook_ids` was put there by a registration on THIS connection.
    const { plan, created, removed } = makePlan({
      adoptExisting: false,
      owned: ['moved'],
      existing: [{ id: 'moved', topic: 'products/create', deliveryUrl: `${MOVED_FROM}/shopify` }],
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(removed, 'the displaced subscription is ours and must go').toEqual(['moved']);
    expect(created).toEqual([...TOPICS]);
    expect(result.subscriptions.map((subscription) => subscription.id)).not.toContain('moved');
    // Not a failure: nothing about the wanted topics failed to arrive.
    expect(result.failures).toEqual([]);
  });

  it('does NOT adopt a displaced subscription, on either reconcile mode', async () => {
    // The adopt branch is where this would go wrong quietly. An `app_secret`
    // provider may keep a subscription at OUR address; keeping one at an address
    // nobody serves would satisfy the topic with something that delivers
    // nowhere, and the reconcile would report a healthy registration forever.
    const { plan, created, removed } = makePlan({
      adoptExisting: true,
      owned: ['moved'],
      existing: [{ id: 'moved', topic: 'products/create', deliveryUrl: `${MOVED_FROM}/shopify` }],
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(removed).toEqual(['moved']);
    expect(created, 'the topic must be created afresh at the address we serve').toEqual([...TOPICS]);
    expect(result.subscriptions.map((subscription) => subscription.id)).not.toContain('moved');
  });

  it('RETAINS a displaced subscription it could not delete', async () => {
    // The #218 invariant one address over: the platform still holds it, Mercaria
    // still holds the only handle, and dropping the id makes it unreachable by
    // the next reconcile AND by disconnect. It is no failure — it delivers
    // nowhere, so no wanted event is lost — and the topic is created regardless,
    // which is why the removal is best-effort where a same-address delete is not.
    const { plan, created } = makePlan({
      adoptExisting: false,
      owned: ['stubborn'],
      existing: [{ id: 'stubborn', topic: 'products/create', deliveryUrl: `${MOVED_FROM}/shopify` }],
      refuseRemove: (id) =>
        id === 'stubborn' ? { outcome: 'refused', reason: 'platform_error', httpStatus: 500 } : undefined,
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(created).toEqual([...TOPICS]);
    expect(result.failures).toEqual([]);
    expect(result.subscriptions).toContainEqual({
      id: 'stubborn',
      topic: 'products/create',
      origin: 'retained',
    });
  });

  it('leaves a subscription at a foreign address that Mercaria holds NO id for', async () => {
    // The other half of the id rule, and the reason it is an id rather than a
    // URL shape. This one sits under a base nobody here serves — a sibling
    // deployment, a staging environment, another app entirely — and nothing
    // says it is Mercaria's. Deleting it would be exactly the cross-deployment
    // deletion the exact-URL comparison exists to prevent.
    const { plan, removed } = makePlan({
      adoptExisting: false,
      owned: [],
      existing: [
        { id: 'not-ours', topic: 'products/create', deliveryUrl: `${MOVED_FROM}/shopify` },
      ],
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(removed).toEqual([]);
    expect(result.subscriptions.map((subscription) => subscription.id)).not.toContain('not-ours');
  });

  it('deletes a subscription of OURS for a topic this connector no longer wants', async () => {
    const { plan, removed } = makePlan({
      adoptExisting: true,
      existing: [{ id: 'retired', topic: 'products/retired-topic', deliveryUrl: OURS }],
    });

    const result = expectReconciled(await reconcileWebhookSubscriptions(plan));

    expect(removed).toEqual(['retired']);
    // Not a failure: nothing wanted it, so no event fails to arrive.
    expect(result.failures).toEqual([]);
    // And gone from the list — a subscription is omitted only when it is
    // provably deleted, which this one is.
    expect(result.subscriptions.map((subscription) => subscription.id)).not.toContain('retired');
  });
});
