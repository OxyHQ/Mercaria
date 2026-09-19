/**
 * The false-positive appeal path (#1015 W8).
 *
 * What is being defended here is a property of the SHAPE of the appeal rather than
 * of any message it produces: an appeal appends the creator's side to an
 * append-only table, it cannot remove the machine's evidence, and the two kinds it
 * may write are exactly the two the sweep refuses to match on — so an appeal can
 * never manufacture the candidate it exists to answer.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const findAssetVersion = vi.fn();
const findDigitalAsset = vi.fn();
const recordProvenanceSignal = vi.fn();
const findMatchingProvenanceSignals = vi.fn();
const findStoreById = vi.fn();

vi.mock('../../../../db/digital/assetRepository.js', () => ({
  findAssetVersion: (...args: unknown[]) => findAssetVersion(...args),
  findDigitalAsset: (...args: unknown[]) => findDigitalAsset(...args),
  recordProvenanceSignal: (...args: unknown[]) => recordProvenanceSignal(...args),
  findMatchingProvenanceSignals: (...args: unknown[]) => findMatchingProvenanceSignals(...args),
}));

vi.mock('../../../../db/stores/storeRepository.js', () => ({
  findStoreById: (...args: unknown[]) => findStoreById(...args),
}));

import {
  PROVENANCE_APPEAL_SIGNAL_KINDS,
  PROVENANCE_APPEAL_STATEMENT_MAX_LENGTH,
  recordProvenanceAppeal,
} from '../appeal.js';
import { SWEPT_PROVENANCE_SIGNAL_KINDS } from '../sweep.js';
import { assertEachOf } from '../../../../__tests__/assert-each-of.js';

beforeEach(() => {
  findAssetVersion.mockReset().mockResolvedValue({ id: 'v-1', assetId: 'a-1' });
  findDigitalAsset.mockReset().mockResolvedValue({ id: 'a-1', storeId: 's-1' });
  recordProvenanceSignal.mockReset().mockResolvedValue(undefined);
  findStoreById
    .mockReset()
    .mockResolvedValue({ id: 's-1', members: [{ oxyUserId: 'u-owner', role: 'owner' }] });
});

describe('#1015 W8 — an appeal adds evidence and can never remove any', () => {
  it('appends one append-only signal about the version as a whole', async () => {
    const recorded = await recordProvenanceAppeal({
      versionId: 'v-1',
      appellantOxyUserId: 'u-owner',
      kind: 'prior_publication',
      statement: '  https://example.invalid/my-model, published 2024-02-01  ',
    });

    expect(recordProvenanceSignal).toHaveBeenCalledTimes(1);
    expect(recordProvenanceSignal.mock.calls[0][0]).toEqual({
      versionId: 'v-1',
      // NULL means "about the version as a whole", which the column's own docblock
      // states. Attaching a declaration to one file would read as an assertion
      // about those bytes.
      fileId: null,
      kind: 'prior_publication',
      value: 'https://example.invalid/my-model, published 2024-02-01',
    });
    expect(recorded.statement).toBe('https://example.invalid/my-model, published 2024-02-01');
  });

  it('the appealable kinds are exactly the kinds the sweep will not match on', () => {
    expect([...PROVENANCE_APPEAL_SIGNAL_KINDS].sort()).toEqual([
      'creator_declaration',
      'prior_publication',
    ]);
    assertEachOf([...PROVENANCE_APPEAL_SIGNAL_KINDS], 2, (kind) => {
      expect(SWEPT_PROVENANCE_SIGNAL_KINDS).not.toContain(kind);
    });
  });

  it('a machine-derived fingerprint cannot be asserted by a person', async () => {
    const swept = [...SWEPT_PROVENANCE_SIGNAL_KINDS];
    // The floor for the loop below, which is what `assertEachOf` provides for a
    // synchronous body and cannot provide for an awaited one.
    expect(swept.length, 'the swept kinds list shrank — this loop now defends less').toBe(3);
    for (const kind of swept) {
      await expect(
        recordProvenanceAppeal({
          versionId: 'v-1',
          appellantOxyUserId: 'u-owner',
          kind,
          statement: 'gfp1:q1024:deadbeef',
        }),
      ).rejects.toThrow(/cannot be asserted by a person/);
    }
    expect(recordProvenanceSignal).not.toHaveBeenCalled();
  });
});

describe('#1015 W8 — only the store that published the version may append to its record', () => {
  it('a member of the store may appeal', async () => {
    findStoreById.mockResolvedValue({
      id: 's-1',
      members: [{ oxyUserId: 'u-staff', role: 'staff' }],
    });
    await expect(
      recordProvenanceAppeal({
        versionId: 'v-1',
        appellantOxyUserId: 'u-staff',
        kind: 'creator_declaration',
        statement: 'I modelled this.',
      }),
    ).resolves.toMatchObject({ kind: 'creator_declaration' });
  });

  it('a stranger may not — the table is append-only, so a forgery is permanent', async () => {
    await expect(
      recordProvenanceAppeal({
        versionId: 'v-1',
        appellantOxyUserId: 'u-stranger',
        kind: 'prior_publication',
        statement: 'actually mine',
      }),
    ).rejects.toThrow(/only a member of the store/);
    expect(recordProvenanceSignal).not.toHaveBeenCalled();
  });

  it('a missing version, asset or store is a refusal rather than an orphan signal', async () => {
    findAssetVersion.mockResolvedValue(null);
    await expect(
      recordProvenanceAppeal({
        versionId: 'v-gone',
        appellantOxyUserId: 'u-owner',
        kind: 'creator_declaration',
        statement: 'mine',
      }),
    ).rejects.toThrow(/does not exist/);

    findAssetVersion.mockResolvedValue({ id: 'v-1', assetId: 'a-gone' });
    findDigitalAsset.mockResolvedValue(null);
    await expect(
      recordProvenanceAppeal({
        versionId: 'v-1',
        appellantOxyUserId: 'u-owner',
        kind: 'creator_declaration',
        statement: 'mine',
      }),
    ).rejects.toThrow(/does not exist/);

    findAssetVersion.mockResolvedValue({ id: 'v-1', assetId: 'a-1' });
    findDigitalAsset.mockResolvedValue({ id: 'a-1', storeId: 's-gone' });
    findStoreById.mockResolvedValue(null);
    await expect(
      recordProvenanceAppeal({
        versionId: 'v-1',
        appellantOxyUserId: 'u-owner',
        kind: 'creator_declaration',
        statement: 'mine',
      }),
    ).rejects.toThrow(/only a member of the store/);
    expect(recordProvenanceSignal).not.toHaveBeenCalled();
  });
});

describe('#1015 W8 — the statement is bounded where the column is not', () => {
  it('an empty statement is refused', async () => {
    await expect(
      recordProvenanceAppeal({
        versionId: 'v-1',
        appellantOxyUserId: 'u-owner',
        kind: 'creator_declaration',
        statement: '   ',
      }),
    ).rejects.toThrow(/statement is required/);
  });

  it('the longest statement the report surface accepts is accepted here too', async () => {
    await expect(
      recordProvenanceAppeal({
        versionId: 'v-1',
        appellantOxyUserId: 'u-owner',
        kind: 'creator_declaration',
        statement: 'x'.repeat(PROVENANCE_APPEAL_STATEMENT_MAX_LENGTH),
      }),
    ).resolves.toBeTruthy();
  });

  it('and one character more is refused — `value` is unbounded `text`', async () => {
    await expect(
      recordProvenanceAppeal({
        versionId: 'v-1',
        appellantOxyUserId: 'u-owner',
        kind: 'creator_declaration',
        statement: 'x'.repeat(PROVENANCE_APPEAL_STATEMENT_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow(/at most/);
    expect(recordProvenanceSignal).not.toHaveBeenCalled();
  });

  it('the bound matches `abuse_reports_details_length_check`', () => {
    // Same kind of statement by the same kind of person. A creator must not
    // discover that one surface accepts what the other refuses.
    expect(PROVENANCE_APPEAL_STATEMENT_MAX_LENGTH).toBe(2_000);
  });
});
