/**
 * The transactional-message transport — a NAMED, FAIL-CLOSED seam (#108).
 *
 * ## Mercaria has no outbound email, and this file says so out loud
 *
 * The registry below is EMPTY, and nothing in this repository registers a
 * transport. That is not an oversight and it is not a stub that lies: it is the
 * same honest refusal `role_email` makes in merchant claiming (#83) and the
 * supplier adapter registry makes in preflight (#122). Every message this
 * domain composes is enqueued durably, rendered from a real template, and then
 * fails its delivery attempt with `transport_unconfigured` — visibly, in the
 * operator trace, with the row still there to be sent the moment a transport
 * exists.
 *
 * The alternative was to write a `console.log` transport, or an SES client
 * against credentials nobody has provisioned. Both would have made "does mail
 * go out" unanswerable from the code: the first looks like a working feature in
 * every test and sends nothing in production, and the second looks like a
 * working feature in production and fails on a credential error that reads like
 * an outage rather than like an unfinished issue.
 *
 * **What closing this seam costs:** one module implementing
 * {@link GuestMessageTransport} and one call to {@link registerGuestMessageTransport}
 * at boot. Nothing else in #108 changes — not the queue, not the templates, not
 * the retry policy, not the suppression list, not a single test.
 *
 * ## The port takes a rendered message and a recipient, and returns an OUTCOME
 *
 * A transport cannot throw its way to a retry: it returns a bounded
 * {@link GuestPortalDeliveryFailure}, so the dispatcher decides retryability
 * from a code whose permanence is declared beside it rather than from a
 * provider's exception hierarchy. A thrown error is still handled — as
 * `transport_unavailable`, the retryable one — because a transport that throws
 * is a transport that is broken rather than a delivery that was refused.
 *
 * ## Privacy the port itself enforces
 *
 * `deliver` receives the plaintext address, because that is what sending means,
 * and it receives it as an ARGUMENT rather than reading it from anywhere — so
 * the set of code that can see a guest's address is the set of registered
 * transports, which is currently empty and is greppable when it is not. It
 * returns no recipient value in any form: the failure vocabulary is closed and
 * has no member that could carry one (#108 privacy rule 3).
 */

import type { GuestPortalDeliveryFailure, GuestPortalMessageKind } from '@mercaria/shared-types';
import { log } from '../../lib/logger.js';

/** What a transport is handed. Composed by `templates.ts`, never by a provider. */
export interface RenderedGuestMessage {
  /** The kind, so a transport may route or tag. Never a template body. */
  readonly kind: GuestPortalMessageKind;
  /** The plaintext recipient address. The only place one exists outside storage. */
  readonly to: string;
  /** BCP-47 the body was rendered in, so a transport can set a language header. */
  readonly locale: string;
  /**
   * The subject line. Deliberately item-free: #108 privacy rule 4 asks that
   * push previews and subjects minimise item detail, and a subject is the one
   * part of a message a lock screen shows a stranger.
   */
  readonly subject: string;
  /** The plain-text body. */
  readonly body: string;
}

/**
 * What a transport reports. Never an exception, never a provider string.
 *
 * Discriminated on a STRING rather than on a boolean, and every result union in
 * this domain follows suit: the backend compiles with `strict: false`, under
 * which TypeScript does not narrow a union by the truthiness of a boolean
 * literal discriminant — `if (!result.delivered)` leaves the full union and the
 * failure branch fails to compile. A string discriminant narrows under both
 * settings, so the shape is chosen to be correct rather than to read prettily
 * under a compiler flag this package does not set.
 */
export type GuestMessageDeliveryResult =
  | { readonly status: 'delivered' }
  | { readonly status: 'failed'; readonly failure: GuestPortalDeliveryFailure };

/** The port. One method, no lifecycle, no configuration surface. */
export interface GuestMessageTransport {
  /** A name for the operator trace and the boot log. Never a credential. */
  readonly name: string;
  deliver(message: RenderedGuestMessage): Promise<GuestMessageDeliveryResult>;
}

/**
 * The registry. A single slot rather than a map keyed by provider id.
 *
 * Deliberate: two transports would need a routing rule, and a routing rule for
 * transactional mail is a way for a message to be sent by the wrong sender
 * domain — which is how a domain's authentication reputation dies. One
 * deployment, one sender.
 */
let registered: GuestMessageTransport | undefined;

/**
 * Register the deployment's transport. Called at boot by whoever closes the
 * seam; called by NOTHING today.
 *
 * Refuses a second registration rather than replacing the first: a silent
 * replacement is how a test double reaches production, and the failure would be
 * "mail went somewhere else" rather than an error anyone could see.
 */
export function registerGuestMessageTransport(transport: GuestMessageTransport): void {
  if (registered !== undefined) {
    throw new Error(
      `A guest message transport is already registered ("${registered.name}"); ` +
        'refusing to replace it.',
    );
  }
  registered = transport;
  log.guest.info({ transport: transport.name }, '[GuestPortal] message transport registered');
}

/**
 * Forget the registered transport. TEST-ONLY, and named so that is obvious in
 * a grep — production has no reason to unregister a sender mid-process.
 */
export function resetGuestMessageTransportForTests(): void {
  registered = undefined;
}

/** Whether this deployment can send anything at all. */
export function hasGuestMessageTransport(): boolean {
  return registered !== undefined;
}

/**
 * Deliver one rendered message through the registered transport.
 *
 * With no transport registered this answers `transport_unconfigured`, which is
 * in `GUEST_PORTAL_PERMANENT_FAILURES` — so the message goes terminal rather
 * than retrying every five seconds forever against a seam that will not close
 * on its own. The row survives, the operator trace names the reason, and
 * re-sending after a transport lands is one explicit operator action.
 */
export async function deliverGuestMessage(
  message: RenderedGuestMessage,
): Promise<GuestMessageDeliveryResult> {
  const transport = registered;
  if (transport === undefined) {
    return { status: 'failed', failure: 'transport_unconfigured' };
  }
  try {
    return await transport.deliver(message);
  } catch (err) {
    // A THROW is a broken transport, not a refused delivery — so it is the
    // retryable code, and the error is logged rather than swallowed. The log
    // line carries the kind and the transport name; the message object, which
    // holds the recipient address, deliberately does not go into it.
    log.guest.error(
      { err, transport: transport.name, kind: message.kind },
      '[GuestPortal] message transport threw; treating as retryable',
    );
    return { status: 'failed', failure: 'transport_unavailable' };
  }
}
