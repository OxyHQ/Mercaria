/**
 * Webhook registration — ONE description of "make the subscriptions pointing at
 * OUR delivery address be exactly the topics this connector wants" (#218).
 *
 * ## Why this is shared rather than written twice
 *
 * Shopify and WooCommerce disagree about the URL, the body, the response shape
 * and how a subscription is authenticated, and they agree about every property
 * Mercaria depends on: no duplicates, no orphans, per-topic fault tolerance, and
 * a result that names both what exists and what will not arrive. Two copies of
 * that reasoning is how they diverge — and the direction they diverge in is
 * always the permissive one, because the cheapest way to make a stubborn
 * platform's registration "work" is to stop deleting first.
 *
 * The providers keep everything platform-shaped: {@link WebhookRegistrationPlan}
 * is four callbacks over their own transport, and they classify a status through
 * {@link classifyWebhookHttpStatus} so the two cannot disagree about what a 403
 * means either.
 *
 * ## The two reconcile modes, and why the choice is not a preference
 *
 * `adoptExisting` follows the provider's `webhookSecretStrategy` and nothing
 * else:
 *
 *  - **`app_secret` (Shopify) ADOPTS.** One app-wide secret verifies every
 *    delivery, so a subscription created by an earlier registration is still
 *    valid. Deleting and recreating it would spend two calls per topic and open
 *    a window where a delete succeeded and the create did not — strictly worse
 *    than keeping a working subscription.
 *  - **`per_connection` (WooCommerce) RECREATES.** The secret is chosen per
 *    webhook AT CREATION and the platform never discloses it again, so an
 *    adopted subscription is signed with a secret this registration does not
 *    hold. That is #218's worst half: every delivery 401s, permanently. Deleting
 *    first is what makes "the stored secret verifies every live subscription"
 *    true rather than likely.
 *
 * ## What a failure to LIST does, and why it is not "create anyway"
 *
 * Without the platform's list there is no way to tell an existing subscription
 * from an absent one, so creating would duplicate every topic on precisely the
 * shops that are already broken. The whole attempt is therefore refused and
 * EVERY desired topic is reported failed under the listing's own reason — which
 * is also the honest merchant-facing answer, since none of those events will
 * arrive.
 *
 * The result then says `outcome: 'unknown'` and carries NO subscription list.
 * The distinction is the whole of #218's first consequence: "I could not find
 * out what exists" and "nothing exists" are different facts, and writing the
 * second down where the first was true is what erased the ids of subscriptions
 * that were still delivering.
 *
 * ## Two ways a subscription is OURS, and only one of them delivers (#295)
 *
 * The delivery URL answers "is this live at the address we serve". It cannot
 * answer "did we create it", and after `CONNECTOR_OAUTH_REDIRECT_BASE_URL`
 * changes — a domain migration, a move between environments, a preview
 * deployment expiring — those stop being the same question: every subscription
 * this connection created is at an address nobody serves, invisible to an exact
 * comparison, and each later reconcile makes a second full set beside it. The
 * merchant's site accumulates dead subscriptions their platform has already
 * disabled, and every Mercaria-side signal stays green, because the REGISTRATION
 * succeeded — what failed was DELIVERY, days later, on the platform's side.
 *
 * `ownedSubscriptionIds` is the second channel, and it is used for REMOVAL only:
 * a displaced subscription is deleted and its topic created afresh, never
 * adopted or moved. Adoption on WooCommerce is unavailable for the reason it is
 * unavailable everywhere else here — the secret is fixed at creation and never
 * disclosed again, so the envelope Mercaria holds is not PROVABLY the one that
 * subscription carries — and an in-place address update would inherit exactly
 * that risk while looking like the gentler option.
 *
 * ## What it is best-effort about, stated rather than implied
 *
 * Deleting a DUPLICATE of an adopted topic, and deleting a subscription for a
 * topic this connector no longer wants, are both best-effort: neither decides
 * whether an event arrives, and a platform refusing the delete leaves a row the
 * next registration retries. A delete that must succeed — the one before a
 * recreate — is never best-effort: its failure is reported as that topic's
 * failure and no create follows it, because a create after a failed delete is
 * exactly how duplicates are born.
 *
 * Best-effort is about whether the reconcile PROCEEDS, never about whether the
 * id is reported: an undeleted subscription is named in `subscriptions` in every
 * one of those branches, because it is still live at our address.
 */

import type { ConnectorWebhookFailureReason } from '@mercaria/shared-types';
import type {
  PlatformWebhookSubscription,
  RegisteredWebhook,
  WebhookRegistrationFailure,
  WebhookRegistrationResult,
} from './types.js';

/**
 * The outcome of one platform call the reconciler makes.
 *
 * A STRING discriminant, not `ok: true | false`: this backend compiles with
 * `strict: false`, and without `strictNullChecks` TypeScript does not narrow a
 * union on a boolean-literal discriminant — the caller would be left holding
 * the whole union and reading `value` off a refusal.
 */
export type WebhookProbe<T> =
  | { readonly outcome: 'ok'; readonly value: T }
  | {
      readonly outcome: 'refused';
      readonly reason: ConnectorWebhookFailureReason;
      readonly httpStatus?: number;
    };

/** What one provider supplies to get the whole reconcile. */
export interface WebhookRegistrationPlan {
  /** The topics this connector wants, in the order it wants them registered. */
  readonly topics: readonly string[];
  /** The EXACT delivery URL this connector owns. Never a prefix — see below. */
  readonly deliveryUrl: string;
  /** Whether an existing subscription at {@link deliveryUrl} may be kept. */
  readonly adoptExisting: boolean;
  /**
   * The subscription ids Mercaria has RECORDED for this connection (#295).
   *
   * The second, disjoint ownership channel, and the only one that survives a
   * change of delivery address. `deliveryUrl` answers "is this live at the
   * address we serve"; this answers "did we create it", and after the base URL
   * moves those stop being the same question — the subscriptions this connection
   * created are all at an address nobody serves, invisible to an exact-URL
   * comparison, and every reconcile from then on makes a second full set beside
   * them.
   *
   * It is ids rather than a URL SHAPE because an id in `webhook_ids` was put
   * there by a registration on THIS connection, while a URL under some other
   * base says only that somebody's Mercaria is at that hostname — a staging
   * deployment, a sibling environment. Deleting on that evidence is the
   * cross-deployment version of the prefix bug the exact comparison exists to
   * prevent.
   */
  readonly ownedSubscriptionIds: readonly string[];
  /** Every subscription the platform currently holds for this shop. */
  list(): Promise<WebhookProbe<PlatformWebhookSubscription[]>>;
  /** Create one subscription for `topic`; resolves to the platform's id. */
  create(topic: string): Promise<WebhookProbe<string>>;
  /** Delete one subscription by its platform id. An absent one is a success. */
  remove(id: string): Promise<WebhookProbe<void>>;
}

/**
 * Classify the status a platform answered a webhook call.
 *
 * Deliberately narrower than the status space: anything that does not map to a
 * remedy lands on `unexpected_response` rather than on the nearest plausible
 * member. A 404 is the case worth naming — on both platforms it means the
 * webhook ROUTE was not found, which is a deployment or API-version fault and
 * not "this topic is unsupported", so it is not folded into
 * `topic_not_supported`.
 */
export function classifyWebhookHttpStatus(status: number): ConnectorWebhookFailureReason {
  if (status === 401 || status === 403) {
    return 'permission_denied';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status === 400 || status === 422) {
    return 'topic_not_supported';
  }
  if (status >= 500) {
    return 'platform_error';
  }
  return 'unexpected_response';
}

/**
 * Drive one registration to completion, per topic, never abandoning an id.
 *
 * The delivery URL is compared EXACTLY. A prefix or `startsWith` test would let
 * a WooCommerce reconcile for connection A delete connection B's subscriptions,
 * since B's URL is A's base plus a different id — a cross-store deletion dressed
 * as tidying up.
 *
 * ## The one invariant every branch below upholds
 *
 * A subscription is left out of `subscriptions` ONLY when it is provably gone.
 * Everything still live at `plan.deliveryUrl` when this returns is named, with
 * `origin: 'retained'` if this attempt did not create it — an adopted topic, a
 * duplicate the platform would not delete, the survivors of a blocked recreate,
 * a retired topic that would not go. Every one of those is a subscription that
 * keeps DELIVERING, and the platform's id is the only handle by which a later
 * reconcile or a disconnect can remove it. Dropping one is #218's first
 * consequence in miniature: an orphan nobody holds a handle for.
 *
 * A DISPLACED subscription the platform would not delete is named for the same
 * reason and not the same one: it delivers nowhere, so nothing depends on it —
 * but Mercaria still holds the only id it can ever be deleted by, and forgetting
 * that id is what makes it permanent.
 */
export async function reconcileWebhookSubscriptions(
  plan: WebhookRegistrationPlan,
): Promise<WebhookRegistrationResult> {
  const listed = await plan.list();
  if (listed.outcome === 'refused') {
    return {
      outcome: 'unknown',
      reason: listed.reason,
      ...(listed.httpStatus === undefined ? {} : { httpStatus: listed.httpStatus }),
      failures: plan.topics.map((topic) => failure(topic, listed.reason, listed.httpStatus)),
    };
  }

  // DEDUPLICATED BY ID, because one subscription listed twice is not the same
  // fact as two subscriptions. A platform can repeat a row — page-number
  // pagination over a list that shifted between requests is the way it happens —
  // and the adopt branch would then keep `existing[0]` while `existing.slice(1)`
  // DELETED that same id, leaving `subscriptions` naming a subscription that no
  // longer exists and the topic with nothing live at all.
  //
  // TWO buckets, because a subscription can be ours in two different ways and
  // only one of them is a thing that delivers. `ours` is live at the address we
  // serve; `displaced` is one we created that the address moved away from (#295).
  const owned = new Set(plan.ownedSubscriptionIds);
  const ours: PlatformWebhookSubscription[] = [];
  const displaced: PlatformWebhookSubscription[] = [];
  const seenIds = new Set<string>();
  for (const subscription of listed.value) {
    if (seenIds.has(subscription.id)) {
      continue;
    }
    if (subscription.deliveryUrl === plan.deliveryUrl) {
      seenIds.add(subscription.id);
      ours.push(subscription);
      continue;
    }
    if (owned.has(subscription.id)) {
      seenIds.add(subscription.id);
      displaced.push(subscription);
    }
  }

  const subscriptions: RegisteredWebhook[] = [];
  const failures: WebhookRegistrationFailure[] = [];

  // DISPLACED FIRST, before a single topic is created, so "a base URL change
  // must not leave a second set" is true at every instant rather than true once
  // the loop below finishes. Nothing is lost by going first: a subscription at an
  // address this deployment does not serve delivers nowhere, so removing it
  // withdraws no coverage that existed.
  //
  // It is NEVER adopted, on either reconcile mode. Adoption means "this one is
  // still good"; one pointing at a hostname nobody answers satisfies a topic
  // with something that delivers nothing, and the registration would report a
  // healthy channel forever.
  //
  // BEST-EFFORT, unlike the delete before a recreate: that one is load-bearing
  // because leaving a same-address subscription behind means the topic delivers
  // TWICE, once under a secret this attempt does not hold. A displaced one
  // cannot double-deliver, so a platform that will not remove it must not also
  // stop the topic being registered. Its id is RETAINED, because Mercaria holds
  // the only handle by which a later reconcile or a disconnect can reach it.
  for (const subscription of displaced) {
    const removed = await plan.remove(subscription.id);
    if (removed.outcome === 'refused') {
      subscriptions.push({
        id: subscription.id,
        topic: subscription.topic,
        origin: 'retained',
      });
    }
  }

  const byTopic = new Map<string, PlatformWebhookSubscription[]>();
  for (const subscription of ours) {
    const bucket = byTopic.get(subscription.topic);
    if (bucket) {
      bucket.push(subscription);
    } else {
      byTopic.set(subscription.topic, [subscription]);
    }
  }

  for (const topic of plan.topics) {
    const existing = byTopic.get(topic) ?? [];

    if (plan.adoptExisting && existing.length > 0) {
      subscriptions.push({ id: existing[0].id, topic, origin: 'retained' });
      // Duplicates of a topic that already delivers correctly. Best-effort: the
      // event arrives either way, and every upsert on the receiving side is
      // idempotent, so a stubborn delete costs a repeated delivery and not a
      // wrong one — but the duplicate that SURVIVES is still delivering, so its
      // id is retained rather than discarded. A discarded one is an orphan the
      // next reconcile finds again and disconnect cannot reach at all.
      for (const duplicate of existing.slice(1)) {
        const removed = await plan.remove(duplicate.id);
        if (removed.outcome === 'refused') {
          subscriptions.push({ id: duplicate.id, topic, origin: 'retained' });
        }
      }
      continue;
    }

    // RECREATE. The delete is load-bearing rather than tidy: leaving the old
    // subscription behind means the topic delivers twice, once signed with a
    // secret this registration does not hold. A refusal therefore stops this
    // topic — creating anyway is how a duplicate is made.
    const removal = await removeAll(plan, existing);
    if (removal.outcome === 'blocked') {
      failures.push(failure(topic, removal.reason, removal.httpStatus));
      // The subscriptions the platform would not delete are STILL DELIVERING,
      // under the secret they were created with rather than this attempt's. On a
      // `per_connection` provider that means those deliveries will 401 — which
      // the merchant is told, because this topic is in `failures`. Retaining the
      // ids is what makes it recoverable: it is what the next reconcile deletes
      // before it recreates, and what disconnect deletes. Dropping them to keep
      // the id list "clean" leaves a live subscription nobody holds a handle
      // for, which is the state #218 is about.
      for (const surviving of removal.surviving) {
        subscriptions.push({ id: surviving.id, topic, origin: 'retained' });
      }
      continue;
    }

    const created = await plan.create(topic);
    if (created.outcome === 'refused') {
      failures.push(failure(topic, created.reason, created.httpStatus));
      continue;
    }
    subscriptions.push({ id: created.value, topic, origin: 'created' });
  }

  // Subscriptions pointing at OUR endpoint for a topic this connector no longer
  // wants — a previous version's topic set, or a rename. Best-effort for the
  // same reason the duplicates above are: nothing here decides whether a wanted
  // event arrives. One that will not go is retained for the same reason too.
  const wanted = new Set(plan.topics);
  for (const subscription of ours) {
    if (!wanted.has(subscription.topic)) {
      const removed = await plan.remove(subscription.id);
      if (removed.outcome === 'refused') {
        subscriptions.push({
          id: subscription.id,
          topic: subscription.topic,
          origin: 'retained',
        });
      }
    }
  }

  return { outcome: 'reconciled', subscriptions, failures };
}

/**
 * Delete every subscription in `existing`, stopping at the first refusal.
 *
 * A blocked removal reports the subscriptions that are STILL THERE — the one the
 * platform refused plus every one after it, which was never attempted. The
 * caller needs that set rather than a bare reason: they are live at our delivery
 * URL, and an id nobody holds cannot be deleted later.
 */
async function removeAll(
  plan: WebhookRegistrationPlan,
  existing: readonly PlatformWebhookSubscription[],
): Promise<
  | { readonly outcome: 'removed' }
  | {
      readonly outcome: 'blocked';
      readonly reason: ConnectorWebhookFailureReason;
      readonly httpStatus?: number;
      readonly surviving: readonly PlatformWebhookSubscription[];
    }
> {
  for (let index = 0; index < existing.length; index += 1) {
    const removed = await plan.remove(existing[index].id);
    if (removed.outcome === 'refused') {
      return {
        outcome: 'blocked',
        reason: removed.reason,
        ...(removed.httpStatus === undefined ? {} : { httpStatus: removed.httpStatus }),
        surviving: existing.slice(index),
      };
    }
  }
  return { outcome: 'removed' };
}

/** Build one failure, omitting `httpStatus` when the call never reached the platform. */
function failure(
  topic: string,
  reason: ConnectorWebhookFailureReason,
  httpStatus: number | undefined,
): WebhookRegistrationFailure {
  return httpStatus === undefined ? { topic, reason } : { topic, reason, httpStatus };
}
