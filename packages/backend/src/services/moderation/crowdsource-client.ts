/** One workload client; CrowdSource resolves its tenant from the verified identity. */
import { type CrowdSource, crowdSourceForOxyService } from '@crowdsource.you/core';
import { oxyClient } from '../../middleware/auth.js';
import { config } from '../../config/index.js';

let client: CrowdSource | undefined;

/** Disabled delivery retains the durable moderation outbox for later processing. */
export function getCrowdSourceClient(): CrowdSource | undefined {
  if (!config.crowdSource.enabled) return undefined;
  client ??= crowdSourceForOxyService({
    oxy: oxyClient,
    ...(config.crowdSource.baseUrl === undefined ? {} : { baseUrl: config.crowdSource.baseUrl }),
  });
  return client;
}

export function resetCrowdSourceClient(): void {
  client?.dispose();
  client = undefined;
}
