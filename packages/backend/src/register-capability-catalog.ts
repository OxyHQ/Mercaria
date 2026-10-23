import { appCapabilityCatalogSchema } from '@oxy.so/contracts';

import { MERCARIA_CAPABILITY_CATALOG } from './capabilities/mercaria.catalog.js';
import { requiredOxyServiceClient } from './capabilities/oxy-service-client.js';

async function main(): Promise<void> {
  const catalog = appCapabilityCatalogSchema.parse(MERCARIA_CAPABILITY_CATALOG);
  const body = await requiredOxyServiceClient().serviceRequest<{
    registration?: { digest?: string };
  }>(
    'POST',
    '/capabilities/catalogs/register',
    { catalog, deployedAt: new Date().toISOString() },
    { timeout: 15_000, cache: false },
  );
  const digest = body.registration?.digest;
  if (typeof digest !== 'string' || digest.length === 0) {
    throw new Error('Mercaria capability catalog registration returned no digest');
  }
  process.stdout.write(`Registered Mercaria capability catalog ${catalog.version} (${digest})\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
