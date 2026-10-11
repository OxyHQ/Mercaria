/**
 * The wall around open-data providers, and the catalogue's own invariants.
 *
 * A provider descriptor is the same kind of thing as a module in
 * `services/ingestion/adapters/` — somebody else's data, read and normalized —
 * and gets the same wall: it may not reach a repository, a database handle, a
 * canonical write, the offer domain or the matcher. `ingestion-isolation.test.ts`
 * scans `adapters/` only one level deep, so the descriptors live behind this
 * scan of their own rather than slipping past that one in a subdirectory.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPEN_DATA_LICENCES, OPEN_DATA_PROVIDER_ROLES } from '@mercaria/shared-types';
import { OPEN_DATA_PROVIDERS, summarizeOpenDataProviders } from '../catalogue.js';

const OPEN_DATA_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  { name: 'a repository', pattern: /db\/[a-zA-Z-]+\/[a-zA-Z]+Repository/ },
  { name: 'a database handle', pattern: /db\/postgres|getDb\(|drizzle-orm/ },
  {
    name: 'a canonical write service',
    pattern:
      /canonical-product\.service|canonical-variant\.service|product-family\.service|brand\.service|organization\.service|product-identifier\.service/,
  },
  {
    name: 'the offer domain',
    pattern: /offers\/offer\.service|offerRepository|recordExternalOffer/,
  },
  { name: 'the matching pipeline', pattern: /matching\/match\.service|runMatch/ },
];

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

describe('an open-data module reaches nothing in the commerce graph', () => {
  it('no provider, reader or transport imports a repository, a database, a canonical write, an offer or the matcher', () => {
    // `register.ts` is the composition root: it supplies the demand read as a
    // function and is the one module here that may reach Postgres.
    const files = [
      ...readdirSync(OPEN_DATA_ROOT).filter(
        (entry) => entry.endsWith('.ts') && entry !== 'register.ts',
      ),
      ...readdirSync(join(OPEN_DATA_ROOT, 'providers'))
        .filter((entry) => entry.endsWith('.ts'))
        .map((entry) => `providers/${entry}`),
    ];
    // The floor, read off the real tree: an empty walk passes vacuously.
    expect(files.length).toBeGreaterThanOrEqual(11);
    for (const file of files) {
      const source = withoutComments(readFileSync(join(OPEN_DATA_ROOT, file), 'utf8'));
      for (const { name, pattern } of FORBIDDEN) {
        expect(pattern.test(source), `open-data/${file} reaches ${name}`).toBe(false);
      }
    }
  });

  it('every provider module is in the catalogue', () => {
    const modules = readdirSync(join(OPEN_DATA_ROOT, 'providers')).filter((entry) =>
      entry.endsWith('.ts'),
    );
    const catalogue = readFileSync(join(OPEN_DATA_ROOT, 'catalogue.ts'), 'utf8');
    for (const module of modules) {
      expect(catalogue, `providers/${module} is not imported by catalogue.ts`).toContain(
        `./providers/${module.replace(/\.ts$/u, '.js')}`,
      );
    }
  });
});

describe('the provider catalogue', () => {
  it('has unique, stable snake_case slugs', () => {
    const slugs = OPEN_DATA_PROVIDERS.map((provider) => provider.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z][a-z0-9_]{2,47}$/u);
  });

  it('states a licence, a role, an attribution and its refresh modes for every provider', () => {
    for (const provider of OPEN_DATA_PROVIDERS) {
      expect(OPEN_DATA_LICENCES, provider.slug).toContain(provider.licence);
      expect(OPEN_DATA_PROVIDER_ROLES, provider.slug).toContain(provider.role);
      expect(provider.attribution.length, provider.slug).toBeGreaterThan(10);
      expect(provider.refreshModes.length, provider.slug).toBeGreaterThan(0);
      expect(provider.homepage, provider.slug).toMatch(/^https:\/\//u);
      // A provider that needs a sub-feed must say what it is.
      if (provider.accountRefRequired)
        expect(provider.accountRefMeaning, provider.slug).not.toBeNull();
    }
  });

  it('declares full_snapshot only where a pass reads the whole source', () => {
    // A snapshot authorises retiring what a pass did not see. Only dump-backed
    // providers read everything; a paged API over a moving listing cannot.
    const snapshot = OPEN_DATA_PROVIDERS.filter((provider) =>
      provider.refreshModes.includes('full_snapshot'),
    );
    expect(snapshot.map((provider) => provider.slug).sort()).toEqual([
      'miteco_fuel',
      'open_prices',
    ]);
    for (const provider of snapshot) expect(provider.kind).toBe('feed');
  });

  it('summarizes what this deployment registered', () => {
    const summary = summarizeOpenDataProviders(new Set(['open_prices']));
    expect(summary.find((entry) => entry.slug === 'open_prices')?.registered).toBe(true);
    expect(summary.find((entry) => entry.slug === 'scryfall')?.registered).toBe(false);
    expect(summary).toHaveLength(OPEN_DATA_PROVIDERS.length);
  });
});
