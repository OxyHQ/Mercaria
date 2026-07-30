/**
 * The one CrowdSource client this process uses.
 *
 * Lazily constructed and memoised, because the constructor PARSES the service
 * credential and throws on a bad one. Building it at module load would take the
 * whole API down at boot over a misconfigured moderation integration — the
 * catalogue, checkout and orders have nothing to do with CrowdSource and must not
 * share its fate.
 *
 * `applicationId` is read OFF the credential by the SDK and is deliberately not
 * configurable. There is no `CROWDSOURCE_APP_ID` anywhere in this repository, and
 * adding one would be a security regression rather than a convenience: any surface
 * able to carry an `applicationId` independently of the credential that proves it
 * is a cross-tenant IDOR, and the tenancy model exists precisely to prevent one
 * application from opening cases in another's name.
 */

import { CrowdSource } from '@oxyhq/crowdsource';
import { config } from '../../config/index.js';

let client: CrowdSource | undefined;

/**
 * The client, or `undefined` when the integration is not configured.
 *
 * `undefined` rather than a throw: every caller is a background worker that must
 * degrade quietly, and "not configured" is an ordinary state for a deployment that
 * has not switched CrowdSource on yet.
 */
export function getCrowdSourceClient(): CrowdSource | undefined {
  if (!config.crowdSource.enabled) return undefined;
  if (client === undefined) {
    client = new CrowdSource({
      serviceKey: config.crowdSource.serviceKey,
      ...(config.crowdSource.baseUrl === undefined
        ? {}
        : { baseUrl: config.crowdSource.baseUrl }),
    });
  }
  return client;
}

/** Test seam: drop the memoised client so a new config can take effect. */
export function resetCrowdSourceClient(): void {
  client = undefined;
}
