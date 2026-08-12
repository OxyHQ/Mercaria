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
 * ## What it is best-effort about, stated rather than implied
 *
 * Deleting a DUPLICATE of an adopted topic, and deleting a subscription for a
 * topic this connector no longer wants, are both best-effort: neither decides
 * whether an event arrives, and a platform refusing the delete leaves a row the
 * next registration retries. A delete that must succeed — the one before a
 * recreate — is never best-effort: its failure is reported as that topic's
 * failure and no create follows it, because a create after a failed delete is
 * exactly how duplicates are born.
 */

import type { ConnectorWebhookFailureReason } from '@mercaria/shared-types';
import type {
  PlatformWebhookSubscription,
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
 */
export async function reconcileWebhookSubscriptions(
  plan: WebhookRegistrationPlan,
): Promise<WebhookRegistrationResult> {
  const listed = await plan.list();
  if (listed.outcome === 'refused') {
    return {
      subscriptions: [],
      failures: plan.topics.map((topic) => failure(topic, listed.reason, listed.httpStatus)),
    };
  }

  const ours = listed.value.filter(
    (subscription) => subscription.deliveryUrl === plan.deliveryUrl,
  );
  const byTopic = new Map<string, PlatformWebhookSubscription[]>();
  for (const subscription of ours) {
    const bucket = byTopic.get(subscription.topic);
    if (bucket) {
      bucket.push(subscription);
    } else {
      byTopic.set(subscription.topic, [subscription]);
    }
  }

  const subscriptions: { id: string; topic: string }[] = [];
  const failures: WebhookRegistrationFailure[] = [];

  for (const topic of plan.topics) {
    const existing = byTopic.get(topic) ?? [];

    if (plan.adoptExisting && existing.length > 0) {
      subscriptions.push({ id: existing[0].id, topic });
      // Duplicates of a topic that already delivers correctly. Best-effort: the
      // event arrives either way, and every upsert on the receiving side is
      // idempotent, so a stubborn delete costs a repeated delivery and not a
      // wrong one.
      for (const duplicate of existing.slice(1)) {
        await plan.remove(duplicate.id);
      }
      continue;
    }

    // RECREATE. The delete is load-bearing rather than tidy: leaving the old
    // subscription behind means the topic delivers twice, once signed with a
    // secret this registration does not hold. A refusal therefore stops this
    // topic — creating anyway is how a duplicate is made.
    const blocked = await removeAll(plan, existing);
    if (blocked) {
      failures.push(failure(topic, blocked.reason, blocked.httpStatus));
      continue;
    }

    const created = await plan.create(topic);
    if (created.outcome === 'refused') {
      failures.push(failure(topic, created.reason, created.httpStatus));
      continue;
    }
    subscriptions.push({ id: created.value, topic });
  }

  // Subscriptions pointing at OUR endpoint for a topic this connector no longer
  // wants — a previous version's topic set, or a rename. Best-effort for the
  // same reason the duplicates above are: nothing here decides whether a wanted
  // event arrives.
  const wanted = new Set(plan.topics);
  for (const subscription of ours) {
    if (!wanted.has(subscription.topic)) {
      await plan.remove(subscription.id);
    }
  }

  return { subscriptions, failures };
}

/** Delete every subscription in `existing`, stopping at the first refusal. */
async function removeAll(
  plan: WebhookRegistrationPlan,
  existing: readonly PlatformWebhookSubscription[],
): Promise<{ reason: ConnectorWebhookFailureReason; httpStatus?: number } | undefined> {
  for (const subscription of existing) {
    const removed = await plan.remove(subscription.id);
    if (removed.outcome === 'refused') {
      return removed.httpStatus === undefined
        ? { reason: removed.reason }
        : { reason: removed.reason, httpStatus: removed.httpStatus };
    }
  }
  return undefined;
}

/** Build one failure, omitting `httpStatus` when the call never reached the platform. */
function failure(
  topic: string,
  reason: ConnectorWebhookFailureReason,
  httpStatus: number | undefined,
): WebhookRegistrationFailure {
  return httpStatus === undefined ? { topic, reason } : { topic, reason, httpStatus };
}
