import { describe, expect, it } from 'vitest';
import type { CatalogSourcePolicyRow } from '../../../db/ingestion/catalogSourcePolicyRepository.js';
import { findOpenDataProvider } from '../../open-data/catalogue.js';
import { OPEN_FACTS_DEMAND_ONLY } from '../../open-data/providers/open-facts.js';
import { DECLARED_OPEN_DATA_SOURCES, type DeclaredSourceRights } from '../../open-data/sources.js';
import { CATALOG_AUTOPILOT_ACTOR } from '../actor.js';
import { policyMatchesDeclaration, shouldPublishDeclaredPolicy } from '../sources.js';

describe('the declared open-data sources', () => {
  it('declares the Open Facts catalogues and the Spanish Open Prices chains', () => {
    const providers = new Set(DECLARED_OPEN_DATA_SOURCES.map((source) => source.provider));
    expect([...providers].sort()).toEqual([
      'gog_catalog',
      'open_beauty_facts',
      'open_food_facts',
      'open_pet_food_facts',
      'open_prices',
      'open_products_facts',
      'scryfall',
      'shopify_storefront',
      'tcgdex',
    ]);
    const chains = DECLARED_OPEN_DATA_SOURCES.filter((source) => source.provider === 'open_prices').map((source) => source.accountRef);
    for (const chain of ['mercadona', 'lidl', 'carrefour', 'alcampo', 'supeco', 'dia']) expect(chains).toContain(chain);
  });

  it('has unique names, and one source per (provider, account ref)', () => {
    const names = DECLARED_OPEN_DATA_SOURCES.map((source) => source.name);
    expect(new Set(names).size).toBe(names.length);
    const feeds = DECLARED_OPEN_DATA_SOURCES.map((source) => `${source.provider}:${source.accountRef ?? ''}`);
    expect(new Set(feeds).size).toBe(feeds.length);
  });

  it('names only real providers, with an account ref exactly where the provider needs one', () => {
    for (const source of DECLARED_OPEN_DATA_SOURCES) {
      const provider = findOpenDataProvider(source.provider);
      expect(provider, source.name).toBeDefined();
      if (provider?.accountRefRequired === true) expect(source.accountRef, source.name).not.toBeNull();
      expect(source.territories, source.name).toEqual(['ES']);
    }
  });

  it('binds every priced source to a merchant and no catalogue to one; catalogues seed', () => {
    for (const source of DECLARED_OPEN_DATA_SOURCES) {
      const role = findOpenDataProvider(source.provider)?.role;
      if (role === 'catalogue_and_prices') {
        // ADR 0016: it seeds products by its own key AND prices them.
        expect(source.merchant, source.name).not.toBeNull();
        expect(source.rights.maySeedCatalog, source.name).toBe(true);
        expect(source.rights.mayDisplayPrice, source.name).toBe(true);
      } else if (role === 'catalogue') {
        // Demand-only: a declared catalogue never walks a country's whole
        // catalogue into the shared database (ADR 0015).
        expect(source.accountRef, source.name).toBe(OPEN_FACTS_DEMAND_ONLY);
        expect(source.merchant, source.name).toBeNull();
        expect(source.rights.maySeedCatalog, source.name).toBe(true);
        expect(source.rights.mayDisplayPrice, source.name).toBe(false);
      } else {
        expect(source.merchant, source.name).not.toBeNull();
        expect(source.rights.maySeedCatalog, source.name).toBe(false);
        expect(source.rights.mayDisplayPrice, source.name).toBe(true);
      }
    }
  });

  it('declares rights the policy service accepts, with attribution under the licence', () => {
    for (const { name, rights } of DECLARED_OPEN_DATA_SOURCES) {
      // `publishIngestionSourcePolicy`'s own refusals, restated.
      expect(rights.mayCache && rights.cacheTtlSeconds > 0, name).toBe(true);
      expect(rights.mayDisplay || (!rights.mayDisplayPrice && !rights.mayDisplayMedia), name).toBe(true);
      expect(rights.mayLinkOut || !rights.mayAppendAffiliateParams, name).toBe(true);
      expect(rights.maySeedCatalog ? rights.mayStore : true, name).toBe(true);
      const extraction = findOpenDataProvider(DECLARED_OPEN_DATA_SOURCES.find((s) => s.name === name)?.provider ?? '')?.extraction === true;
      // An extraction provider runs only under a robots-respecting policy with
      // a budget and an agent; nothing else extracts at all.
      expect(rights.extractionMode, name).toBe(extraction ? 'robots_respecting' : 'disallowed');
      if (extraction) {
        expect(rights.extractionMaxRequestsPerDay, name).toBeGreaterThan(0);
        expect(rights.extractionUserAgent, name).toMatch(/^Mercaria\//u);
      }
      expect(rights.attributionRequired, name).toBe(true);
      expect(rights.termsVersion, name).toBe(findOpenDataProvider(DECLARED_OPEN_DATA_SOURCES.find((s) => s.name === name)?.provider ?? '')?.licence);
    }
  });

  it('uses merchant slugs that are stable URL identities', () => {
    for (const { merchant } of DECLARED_OPEN_DATA_SOURCES) {
      if (merchant !== null) expect(merchant.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/u);
    }
  });
});

describe('whether the autopilot republishes a policy', () => {
  const declared = DECLARED_OPEN_DATA_SOURCES[0]?.rights as DeclaredSourceRights;

  function activePolicy(overrides: Partial<CatalogSourcePolicyRow>): CatalogSourcePolicyRow {
    return {
      ...declared,
      // A stored row says NULL where the declaration says nothing.
      extractionMaxRequestsPerDay: declared.extractionMaxRequestsPerDay ?? null,
      extractionUserAgent: declared.extractionUserAgent ?? null,
      reviewedByOxyUserId: CATALOG_AUTOPILOT_ACTOR,
      ...overrides,
    } as CatalogSourcePolicyRow;
  }

  it('publishes when no policy is active', () => {
    expect(shouldPublishDeclaredPolicy(undefined, declared)).toBe(true);
  });

  it('leaves its own policy alone while it still matches the declaration', () => {
    expect(policyMatchesDeclaration(activePolicy({}), declared)).toBe(true);
    expect(shouldPublishDeclaredPolicy(activePolicy({}), declared)).toBe(false);
  });

  it('replaces its own policy once the declaration changed', () => {
    expect(shouldPublishDeclaredPolicy(activePolicy({ mayIndex: !declared.mayIndex }), declared)).toBe(true);
  });

  it("never replaces an operator's policy, even one that grants nothing", () => {
    const suspended = activePolicy({ reviewedByOxyUserId: 'operator-1', mayDisplay: false, mayDisplayPrice: false });
    expect(shouldPublishDeclaredPolicy(suspended, declared)).toBe(false);
  });
});
