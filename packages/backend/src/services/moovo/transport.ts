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
 * ## What is missing is TWO things, and the refusal says both
 *
 * #156 cannot be finished by this repository alone, which is why
 * {@link MOOVO_TRANSPORT_BLOCKERS} is a list rather than a sentence:
 *
 *  - **`OxyHQ/oxy#878`** — `@oxyhq/core` has no audience-aware service client.
 *    Measured on the installed 19.1.0 and on `OxyHQServices@origin/main`:
 *    `createServiceClient` does not exist, and `getServiceToken()` POSTs
 *    `{apiKey, apiSecret}` to `/auth/service-token` with no parameter that
 *    could name a target application. Every token it mints carries the
 *    hardcoded audience `oxy-api`.
 *  - **`OxyHQ/Moovo#27` and `#28`** — Moovo has no service-authenticated
 *    surface and no logistics service API. Every logistics route there is
 *    `authenticateToken` (a real Oxy USER) plus "the caller IS the sender";
 *    `oxyServiceAuth` is exported and mounted on nothing.
 *
 * The second is why registering a transport built on today's SDK would be
 * worse than refusing: the only token Mercaria can mint is audience `oxy-api`,
 * and the only credential Moovo accepts is an end user's own bearer. Forwarding
 * a buyer's session to book their parcel is precisely the impersonation #156
 * acceptance 3 forbids, and it is the shortcut that is actually available.
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

/**
 * The issues that owe a working Moovo transport, in the order they unblock.
 *
 * Carried as a VALUE and rendered into every refusal, so an operator trace
 * reads "the SDK cannot mint an audience-bound token yet" rather than
 * "logistics failed" — #48's `deferred: #NN` device, which #126 already applied
 * to the logistics port and this extends to the reason it is unregistered.
 */
export const MOOVO_TRANSPORT_BLOCKERS: readonly string[] = [
  'OxyHQ/oxy#878 (audience-aware service client in @oxyhq/core)',
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
