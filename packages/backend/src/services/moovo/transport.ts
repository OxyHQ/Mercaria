/**
 * The Moovo transport REGISTRY, whose default refuses (#156).
 *
 * `services/guest-portal/transport.ts` (#108) and
 * `services/price-alerts/transport.ts` (#79) are the precedents, and the
 * argument is theirs verbatim: a `console.log` transport looks like a working
 * feature in every test and does nothing in production, while an unconfigured
 * real client fails like an outage. So nothing is registered, every call is
 * refused visibly, and the refusal NAMES what is missing.
 *
 * OxyServer.createServiceClient now supplies the own workload transport with
 * an explicit receiver audience (Oxy ADR 0049), without application keys or scopes.
 * The remaining blockers are Moovo's service receiver and versioned logistics
 * API (#27/#28). Its current logistics routes authenticate a user and require
 * the sender to be that user; this migration does not invent a booking API.
 *
 * ## Registering a transport is what makes Moovo booking AVAILABLE
 *
 * `registerMoovoLogisticsPort` is called by `register.ts` only once a transport
 * exists, and the reason is measured rather than stylistic:
 * `isMoovoBookingAvailable()` feeds `chooseFulfilmentMode`'s
 * `moovoBookingAvailable`, and a `true` there makes Mode A the CHOSEN mode. A
 * port registered over no transport would therefore route paid orders into a
 * booking path that always fails, instead of letting them fall back to Mode B —
 * a supplier booking its own carrier, which is a complete fulfilment path. The
 * fail-closed default has to be no port at all, not a port that refuses.
 */

import type { MoovoTransport } from './transport-contract.js';

/** Remaining product API dependencies; shared Oxy transport is already available. */
export const MOOVO_TRANSPORT_BLOCKERS: readonly string[] = [
  'OxyHQ/Moovo#27 (accept Oxy Application principals on Moovo service routes)',
  'OxyHQ/Moovo#28 (versioned Moovo logistics service API)',
];

/** One sentence naming every blocker, for a log line or an operator surface. */
export function moovoTransportBlockerSummary(): string {
  return MOOVO_TRANSPORT_BLOCKERS.join('; ');
}

let transport: MoovoTransport | null = null;

/**
 * Install the real transport.
 *
 * Re-registering REPLACES, matching every other port in this codebase and for
 * their reason: startup ordering across lazily imported modules is not
 * something a port should have an opinion about.
 */
export function registerMoovoTransport(next: MoovoTransport): void {
  transport = next;
}

/** Restore the unregistered state. Exists for tests, which must not leak one. */
export function resetMoovoTransport(): void {
  transport = null;
}

/**
 * The transport in force, or `null` when none is registered.
 *
 * `null` rather than a refusing object, because the caller's two situations are
 * genuinely different: with no transport there is no client to register at all,
 * and with one the client exists and its calls may still fail. Returning a
 * refusing stub here would erase exactly that distinction — the one
 * `isMoovoBookingAvailable` reads.
 */
export function moovoTransport(): MoovoTransport | null {
  return transport;
}

/** Whether a transport is installed. */
export function isMoovoTransportRegistered(): boolean {
  return transport !== null;
}
