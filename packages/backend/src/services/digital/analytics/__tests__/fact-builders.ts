/**
 * Fact builders for the digital analytics tests.
 *
 * Builders rather than literals for one reason that matters: every fact type here
 * is a CLOSED allow-list, so a field added to one of them without a decision should
 * fail the boundaries gate — and a test suite built from inline object literals
 * would have to be edited field by field to keep compiling, which is the pressure
 * that makes somebody widen the type instead.
 */

import type {
  AssetProcessingFact,
  DigitalAnalyticsFacts,
  DigitalAssetPublicationFact,
  DigitalDownloadFact,
  DigitalPriceClass,
  DigitalRightFact,
  DigitalSaleFact,
  DigitalViewFact,
} from '../facts.js';

export function sale(overrides: Partial<DigitalSaleFact> = {}): DigitalSaleFact {
  return {
    assetId: 'asset-1',
    vertical: 'three_d',
    packageId: 'pkg-1',
    licenceVersionId: 'lv-personal',
    updatePolicy: 'purchased_version_only',
    priceClass: 'paid',
    currency: 'EUR',
    grossAmount: 2_500,
    realizedFeeAmount: 250,
    creatorEarningsAmount: 2_250,
    supplyCountry: 'ES',
    refunded: false,
    disputed: false,
    ...overrides,
  };
}

export function download(overrides: Partial<DigitalDownloadFact> = {}): DigitalDownloadFact {
  return {
    assetId: 'asset-1',
    kind: 'completed',
    refusalReason: null,
    priceClass: 'paid',
    ...overrides,
  };
}

export function right(overrides: Partial<DigitalRightFact> = {}): DigitalRightFact {
  return { assetId: 'asset-1', status: 'active', priceClass: 'paid', ...overrides };
}

export function processing(overrides: Partial<AssetProcessingFact> = {}): AssetProcessingFact {
  return { assetId: 'asset-1', verdict: 'measured', latencyMs: 1_200, ...overrides };
}

export function publication(
  overrides: Partial<DigitalAssetPublicationFact> = {},
): DigitalAssetPublicationFact {
  return { assetId: 'asset-1', vertical: 'three_d', priceClass: 'paid', ...overrides };
}

export function view(priceClass: DigitalPriceClass = 'paid', assetId = 'asset-1'): DigitalViewFact {
  return { assetId, priceClass };
}

/** A fact set from whichever parts a test cares about. */
export function facts(parts: Partial<DigitalAnalyticsFacts> = {}): DigitalAnalyticsFacts {
  return {
    sales: [],
    downloads: [],
    rights: [],
    processing: [],
    publications: [],
    views: [],
    ...parts,
  };
}

/** `count` identical facts, for driving a cohort floor across its edge. */
export function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}
