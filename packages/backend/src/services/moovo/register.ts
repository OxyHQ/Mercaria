/**
 * Validating the Moovo client's configuration and installing it (#156
 * §"Environment and readiness").
 *
 * Two decisions here carry the issue's safety properties, and both are the
 * opposite of what the shortest implementation would do.
 *
 * **A misconfiguration THROWS.** #156 item 7 is "wrong audience/environment is
 * a hard configuration failure", and the reason it must be hard is that every
 * softer answer is silent: a client that logs a warning and carries on with an
 * unset `resourceApplicationId` is a client that would mint a token for nothing
 * in particular, and a deployment that reads a typo'd `MOOVO_ENVIRONMENT` as
 * `development` addresses a rehearsal while shipping real parcels. The refusal
 * names every problem it found at once, because fixing one variable per restart
 * is how a deploy window is spent.
 *
 * **No transport means no port, not a port that refuses.** Measured, not
 * stylistic: `isMoovoBookingAvailable()` (`services/retail-fulfilment/moovo.port.ts`)
 * is identity-compared against the refusing default and feeds
 * `chooseFulfilmentMode`'s `moovoBookingAvailable`. A `true` there makes Mode A
 * the CHOSEN mode, so registering a client over no transport would route paid
 * orders into a booking path that always fails instead of letting them fall
 * back to Mode B — a supplier booking its own carrier, which #126 calls "a
 * complete fulfilment path" rather than a degradation. The honest fail-closed
 * state is that nothing is registered at all.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { registerMoovoLogisticsPort } from '../retail-fulfilment/moovo.port.js';
import { createMoovoLogisticsClient } from './client.js';
import {
  isMoovoTransportRegistered,
  moovoTransport,
  moovoTransportBlockerSummary,
} from './transport.js';

/** Everything wrong with the current configuration. Empty means it is usable. */
export function moovoConfigurationProblems(): readonly string[] {
  const problems: string[] = [];
  const moovo = config.moovo;

  if (moovo.resourceApplicationId === '') {
    problems.push(
      'MOOVO_RESOURCE_APPLICATION_ID is required: it names the Moovo Oxy Application a ' +
        'service token must be bound to, and an unbound token is one any resource would accept.',
    );
  }

  if (moovo.environment === null) {
    const raw = process.env.MOOVO_ENVIRONMENT?.trim() ?? '';
    problems.push(
      raw === ''
        ? 'MOOVO_ENVIRONMENT is required: development, staging or production.'
        : `MOOVO_ENVIRONMENT=${JSON.stringify(raw)} is not one of development, staging, production. ` +
          'It is not defaulted, because reading a typo as a default points a deployment at the wrong Moovo.',
    );
  } else if (process.env.NODE_ENV === 'production' && moovo.environment !== 'production') {
    // #156 environment rule 1: development credentials call only development
    // resources. The check runs in this direction only — a rehearsal host
    // pointed at production is caught by the credential Oxy issues it, while a
    // production host pointed at a rehearsal would silently succeed.
    problems.push(
      `MOOVO_ENVIRONMENT=${moovo.environment} on a production deployment: a production host ` +
        'must not address a rehearsal Moovo, because the parcels it books are real.',
    );
  }

  if (moovo.baseUrl === '') {
    problems.push('MOOVO_BASE_URL is required and has no default.');
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(moovo.baseUrl);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      problems.push('MOOVO_BASE_URL is not a URL.');
    } else if (parsed.protocol !== 'https:') {
      // No localhost exemption. A plaintext base URL is one a service token
      // crosses the network in the clear on, and the development deployment is
      // exactly where somebody would leave it configured.
      problems.push('MOOVO_BASE_URL must be https.');
    }
  }

  if (moovo.timeoutMs <= 0) problems.push('MOOVO_TIMEOUT_MS must be positive.');
  if (moovo.maxAttempts < 1) problems.push('MOOVO_MAX_ATTEMPTS must be at least 1.');

  return problems;
}

/**
 * Refuse to proceed on a bad configuration.
 *
 * Exported separately from {@link registerMoovoClient} so a readiness surface
 * can ask the question without installing anything.
 */
export function assertMoovoClientConfigured(): void {
  const problems = moovoConfigurationProblems();
  if (problems.length === 0) return;
  // The message carries variable NAMES and never their values, except for the
  // environment word, which is a member of a published closed set and cannot be
  // a secret. `MOOVO_RESOURCE_APPLICATION_ID`'s value is never echoed: it is not
  // a credential, but it is an identifier of somebody else's tenant.
  throw new Error(`Moovo client is enabled and misconfigured:\n- ${problems.join('\n- ')}`);
}

/**
 * Install the Moovo logistics client, if there is anything to install.
 *
 * Called unconditionally at boot. The three outcomes are deliberately
 * different, and only one of them is silent:
 *
 *  - disabled — nothing happens, no log. This is the shipped default.
 *  - enabled and misconfigured — THROWS. See the module docblock.
 *  - enabled, configured, no transport — the client is NOT registered and the
 *    blockers are logged once at startup, so the reason is in the log of the
 *    deployment that expected Moovo to work rather than in an issue tracker.
 */
export function registerMoovoClient(): void {
  if (!config.moovo.enabled) return;
  assertMoovoClientConfigured();

  const transport = moovoTransport();
  if (transport === null || !isMoovoTransportRegistered()) {
    log.general.info(
      { blockers: moovoTransportBlockerSummary() },
      '[Moovo] client is configured and no transport is registered; Moovo booking stays unavailable',
    );
    return;
  }

  registerMoovoLogisticsPort(
    createMoovoLogisticsClient(transport, {
      timeoutMs: config.moovo.timeoutMs,
      maxAttempts: config.moovo.maxAttempts,
      retryBaseDelayMs: config.moovo.retryBaseDelayMs,
      retryMaxDelayMs: config.moovo.retryMaxDelayMs,
    }),
  );
  log.general.info(
    { environment: config.moovo.environment, scopes: config.moovo.scopes.length },
    '[Moovo] logistics client registered',
  );
}
