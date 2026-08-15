/**
 * The EMAIL transport seam — a named contract that FAILS CLOSED
 * (#97 notification 7).
 *
 * The issue asks that an agent respect "quiet hours, locale and channel
 * preferences". The preference is real (`shopping_agents.notification_channels`
 * may contain `email`) and the address is not: **Mercaria has no outbound mail
 * transport**, and it stores no email address for an Oxy account at all —
 * copying one out of an Oxy profile would create exactly the profile mirror
 * ADR 0003 D15 says does not exist.
 *
 * So the registry below is EMPTY, and every attempt fails
 * `transport_unconfigured` VISIBLY with the delivery row intact. #79 and #108
 * made the same call and the reasoning is quoted rather than rediscovered:
 *
 * > A `console.log` transport looks like a working feature in every test and
 * > sends nothing in production; an SES client against unprovisioned
 * > credentials looks like one in production and fails like an outage.
 *
 * Closing it is ONE module plus one {@link registerShoppingAgentEmailTransport}
 * call — and it needs a decision about where the address comes from, which is
 * why it is not merely a missing dependency. Nothing else in #97 changes: the
 * channel value, the queue row, the retry, the failure code and the operator
 * metric all exist and all work today.
 */

import type { ShoppingAgentNotificationPayload } from '@mercaria/shared-types';

/** What a transport is handed. No address — resolving one is the transport's job. */
export interface ShoppingAgentEmailMessage {
  /** The Oxy account the agent belongs to. */
  readonly oxyUserId: string;
  readonly subject: string;
  readonly body: string;
  readonly payload: ShoppingAgentNotificationPayload;
}

/**
 * A transport's answer.
 *
 * A STRING discriminant, not a boolean: `@mercaria/backend` compiles with
 * `strict: false`, and without `strictNullChecks` a boolean-literal discriminant
 * does not narrow — the finding #68 recorded and #110 hit again. The caller
 * must act on the difference between "no address" and "the provider refused",
 * so losing the narrowing here would lose the distinction.
 */
export type ShoppingAgentEmailOutcome =
  | { readonly outcome: 'sent' }
  /** Permanent: this owner has no deliverable address. Suppress, do not retry. */
  | { readonly outcome: 'no_address' }
  /** Transient: retry with backoff. */
  | { readonly outcome: 'unavailable' }
  /** Permanent: the provider refused this message. */
  | { readonly outcome: 'rejected' };

export type ShoppingAgentEmailTransport = (
  message: ShoppingAgentEmailMessage,
) => Promise<ShoppingAgentEmailOutcome>;

/**
 * The registry — deliberately a mutable module singleton with no member.
 *
 * `let` rather than a Map, because there is exactly one email channel and a map
 * would invite a per-deployment fan-out nobody asked for. A registration
 * REPLACES, so a deployment cannot end up with two transports silently sending
 * two copies of one notification.
 */
let transport: ShoppingAgentEmailTransport | undefined;

/** Register the one email transport. Called by NOTHING today — see the docblock. */
export function registerShoppingAgentEmailTransport(next: ShoppingAgentEmailTransport): void {
  transport = next;
}

/** Forget it again. Exists for tests, which must not leak a transport between files. */
export function clearShoppingAgentEmailTransport(): void {
  transport = undefined;
}

/** The registered transport, or `undefined` — which is the shipped state. */
export function resolveShoppingAgentEmailTransport(): ShoppingAgentEmailTransport | undefined {
  return transport;
}
