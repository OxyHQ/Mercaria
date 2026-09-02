import { appCapabilityCatalogSchema } from '@oxyhq/contracts';

import { MERCARIA_CAPABILITY_CATALOG } from './capabilities/mercaria.catalog.js';
import { requiredOxyServiceToken } from './capabilities/oxy-service-client.js';

const OXY_API_URL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');

async function main(): Promise<void> {
  const catalog = appCapabilityCatalogSchema.parse(MERCARIA_CAPABILITY_CATALOG);
  const token = await requiredOxyServiceToken();
  const response = await fetch(`${OXY_API_URL}/capabilities/catalogs/register`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ catalog, deployedAt: new Date().toISOString() }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Mercaria capability catalog registration failed (${response.status})`);
  }
  const body = await response.json() as { registration?: { digest?: string } };
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

