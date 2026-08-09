/**
 * Vendor extraction: grouping, ambiguity routing, and the two hard negatives.
 *
 * The repositories are mocked because what can regress here is the DECISION
 * LOGIC — how raw vendor strings group, which groups are flagged for review,
 * and what payload identity a re-run converges on. The negatives are the load-
 * bearing part: the mocked database exposes NO write surface except the
 * provenance writers, so a regression that tried to mint a brand, touch a
 * listing or update anything at all crashes the test rather than passing it —
 * and the assertions below additionally pin that only the expected calls
 * happened. Whether the real convergence unique behaves is pinned against a
 * real server in `canonical-graph.realdb.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface VendorCount {
  vendor: string | null;
  listingCount: number;
}

/** What the mocked `listings` aggregate returns — per-test input. */
let vendorRows: VendorCount[] = [];

/** Every observation the service recorded, in order. */
const recordedObservations: {
  sourceId: string;
  externalType: string;
  externalId: string;
  contentHash: string;
  payload: unknown;
}[] = [];

/** Content hashes already "stored", to simulate the convergence unique. */
const storedHashes = new Set<string>();

const ensureCatalogSource = vi.fn();
const findBrandsByNormalizedName = vi.fn();
const findBrandIdsByNormalizedAlias = vi.fn();

vi.mock('../../../db/postgres.js', () => {
  // The ONLY database surface the service gets: one select chain that answers
  // the vendor aggregate. Any other access — an update, a delete, an insert —
  // is a missing property and a loud TypeError.
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    groupBy: () => Promise.resolve(vendorRows),
  };
  return { getDb: () => ({ select: () => selectChain }) };
});

vi.mock('../../../db/canonical/provenanceRepository.js', () => ({
  ensureCatalogSource: (...args: unknown[]) => ensureCatalogSource(...args),
  recordSourceObservation: (
    _db: unknown,
    input: {
      sourceId: string;
      externalType: string;
      externalId: string;
      contentHash: string;
      payload?: unknown;
    },
  ) => {
    recordedObservations.push({
      sourceId: input.sourceId,
      externalType: input.externalType,
      externalId: input.externalId,
      contentHash: input.contentHash,
      payload: input.payload,
    });
    const inserted = !storedHashes.has(input.contentHash);
    storedHashes.add(input.contentHash);
    return Promise.resolve({ record: { id: `record-${input.contentHash.slice(0, 8)}` }, inserted });
  },
}));

vi.mock('../../../db/canonical/brandRepository.js', () => ({
  findBrandsByNormalizedName: (...args: unknown[]) => findBrandsByNormalizedName(...args),
  findBrandIdsByNormalizedAlias: (...args: unknown[]) => findBrandIdsByNormalizedAlias(...args),
}));

const { extractVendorBrandCandidates, VENDOR_BACKFILL_SOURCE } = await import(
  '../vendor-brand-candidate.service.js'
);

beforeEach(() => {
  vi.clearAllMocks();
  vendorRows = [];
  recordedObservations.length = 0;
  storedHashes.clear();
  ensureCatalogSource.mockResolvedValue({ id: 'source-1', ...VENDOR_BACKFILL_SOURCE });
  findBrandsByNormalizedName.mockResolvedValue([]);
  findBrandIdsByNormalizedAlias.mockResolvedValue([]);
});

describe('extractVendorBrandCandidates', () => {
  it('groups conservatively by exact normalized equality and sums listing counts', async () => {
    vendorRows = [
      { vendor: 'Apple', listingCount: 3 },
      { vendor: ' apple ', listingCount: 2 },
      { vendor: 'APPLE Inc.', listingCount: 1 },
      { vendor: 'Samsung', listingCount: 5 },
    ];

    const result = await extractVendorBrandCandidates();

    expect(result.totalVendorValues).toBe(4);
    expect(result.candidates).toHaveLength(2);

    const apple = result.candidates.find((entry) => entry.normalizedName === 'apple');
    expect(apple).toBeDefined();
    expect(apple?.displayForms).toEqual(['APPLE Inc.', 'Apple', 'apple']);
    expect(apple?.listingCount).toBe(6);
    // Several distinct spellings collapsing together is a review decision —
    // which display form is canonical is not this service's call.
    expect(apple?.ambiguous).toBe(true);
    expect(apple?.reviewReasons).toEqual(['multiple_display_forms']);

    const samsung = result.candidates.find((entry) => entry.normalizedName === 'samsung');
    expect(samsung?.ambiguous).toBe(false);
    expect(samsung?.reviewReasons).toEqual([]);
  });

  it('routes un-normalizable values to review instead of guessing', async () => {
    vendorRows = [{ vendor: '###', listingCount: 1 }];

    const result = await extractVendorBrandCandidates();

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.normalizedName).toBe('');
    expect(result.candidates[0]?.ambiguous).toBe(true);
    expect(result.candidates[0]?.reviewReasons).toContain('unnormalizable_value');
    // The observation still has a deterministic identity.
    expect(recordedObservations[0]?.externalId).toBe('unnormalizable:###');
  });

  it('flags collisions with existing brands and aliases as review input, never attaching', async () => {
    vendorRows = [{ vendor: 'Apple', listingCount: 2 }];
    findBrandsByNormalizedName.mockResolvedValue([{ id: 'brand-apple' }]);
    findBrandIdsByNormalizedAlias.mockResolvedValue(['brand-alias-apple']);

    const result = await extractVendorBrandCandidates();

    const candidate = result.candidates[0];
    expect(candidate?.ambiguous).toBe(true);
    expect(candidate?.reviewReasons).toEqual(
      expect.arrayContaining(['matches_existing_brand', 'matches_existing_alias']),
    );
    expect(candidate?.existingBrandIds).toEqual(['brand-alias-apple', 'brand-apple']);
  });

  it('records provenance under the backfill source and nothing else', async () => {
    vendorRows = [{ vendor: 'Solo', listingCount: 1 }];

    const result = await extractVendorBrandCandidates();

    expect(ensureCatalogSource).toHaveBeenCalledTimes(1);
    expect(ensureCatalogSource.mock.calls[0]?.[1]).toEqual(VENDOR_BACKFILL_SOURCE);
    expect(recordedObservations).toHaveLength(1);
    expect(recordedObservations[0]).toMatchObject({
      sourceId: 'source-1',
      externalType: 'brand',
      externalId: 'solo',
    });
    expect(result.recorded).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it('re-runs converge: identical catalogue content produces the identical hash', async () => {
    vendorRows = [
      { vendor: 'Apple', listingCount: 3 },
      { vendor: ' apple ', listingCount: 2 },
    ];

    const first = await extractVendorBrandCandidates();
    const firstHash = recordedObservations[0]?.contentHash;
    const second = await extractVendorBrandCandidates();
    const secondHash = recordedObservations[1]?.contentHash;

    expect(first.recorded).toBe(1);
    expect(firstHash).toBe(secondHash);
    expect(second.recorded).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it('a changed catalogue is a genuinely new observation, not a suppressed one', async () => {
    vendorRows = [{ vendor: 'Apple', listingCount: 3 }];
    await extractVendorBrandCandidates();

    vendorRows = [{ vendor: 'Apple', listingCount: 4 }];
    const second = await extractVendorBrandCandidates();

    expect(second.recorded).toBe(1);
    expect(recordedObservations[0]?.contentHash).not.toBe(recordedObservations[1]?.contentHash);
  });
});
