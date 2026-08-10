/**
 * The EMAIL transport seam — a named contract that FAILS CLOSED (#79
 * notification 2).
 *
 * The issue asks that email be supported "only through an explicit user
 * preference and available email address". The preference is real
 * (`price_alerts.email_opt_in`) and the address is not: **Mercaria has no
 * outbound mail transport**, and it stores no email address for an Oxy buyer at
 * all — copying one out of an Oxy profile would create exactly the profile
 * mirror ADR 0003 D15 says does not exist.
 *
 * So the registry below is EMPTY, and every attempt fails
 * `transport_unconfigured` VISIBLY with the delivery row intact. #108 made the
 * same call for the guest portal and the reasoning is quoted rather than
 * rediscovered:
 *
 * > A `console.log` transport looks like a working feature in every test and
 * > sends nothing in production; an SES client against unprovisioned
 * > credentials looks like one in production and fails like an outage.
 *
 * Closing it is ONE module plus one {@link registerPriceAlertEmailTransport}
 * call — and it needs a decision about where the address comes from, which is
 * why it is not merely a missing dependency. Nothing else in #79 changes: the
 * opt-in column, the queue row, the retry, the failure code and the operator
 * metric all exist and all work today.
 */

import type { PriceAlertNotificationPayload } from '@mercaria/shared-types';

/** What a transport is handed. No address — resolving one is the transport's job. */
export interface PriceAlertEmailMessage {
  /** The Oxy account the alert belongs to. */
  readonly oxyUserId: string;
  readonly subject: string;
  readonly body: string;
  readonly payload: PriceAlertNotificationPayload;
}

/**
 * A transport's answer.
 *
 * A STRING discriminant, not a boolean: `@mercaria/backend` compiles with
 * `strict: false`, and without `strictNullChecks` a boolean-literal discriminant
 * does not narrow — the finding #68 recorded and #110 hit again. The caller must
 * act on the difference between "no address" and "the provider refused", so
 * losing the narrowing here would lose the distinction.
 */
export type PriceAlertEmailOutcome =
  | { readonly outcome: 'sent' }
  /** Permanent: this buyer has no deliverable address. Suppress, do not retry. */
  | { readonly outcome: 'no_address' }
  /** Transient: retry with backoff. */
  | { readonly outcome: 'unavailable' }
  /** Permanent: the provider refused this message. */
  | { readonly outcome: 'rejected' };

export type PriceAlertEmailTransport = (
  message: PriceAlertEmailMessage,
) => Promise<PriceAlertEmailOutcome>;

/**
 * The registry — deliberately a mutable module singleton with no member.
 *
 * `let` rather than a Map, because there is exactly one email channel and a map
 * would invite a per-deployment fan-out nobody asked for. A registration
 * REPLACES, so a deployment cannot end up with two transports silently sending
 * two copies of one alert.
 */
let transport: PriceAlertEmailTransport | undefined;

/** Register the one email transport. Called by NOTHING today — see the docblock. */
export function registerPriceAlertEmailTransport(next: PriceAlertEmailTransport): void {
  transport = next;
}

/** Forget it again. Exists for tests, which must not leak a transport between files. */
export function clearPriceAlertEmailTransport(): void {
  transport = undefined;
}

/** The registered transport, or `undefined` — which is the shipped state. */
export function resolvePriceAlertEmailTransport(): PriceAlertEmailTransport | undefined {
  return transport;
}
