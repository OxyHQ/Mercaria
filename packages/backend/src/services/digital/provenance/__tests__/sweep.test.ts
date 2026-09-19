/**
 * The re-upload sweep and the review it feeds (#1015 W8).
 *
 * The sweep's reads go through an injected port, so the interesting cases here are
 * POPULATIONS rather than fixtures: a match in the creator's own store, a match
 * whose version row has gone, three signals landing on one version, a version that
 * was never published. Each of those is a paragraph in `sweep.ts`' docblock and
 * each is a way the feature would accuse the wrong person.
 *
 * The SQL underneath the port — `findMatchingProvenanceSignals`' indexed equality
 * read and the append-only trigger over it — is exercised against a real server by
 * `db/digital/__tests__/digital-commerce.realdb.test.ts`, which is where a CHECK
 * and a trigger can actually fail.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AssetProvenanceSignalKind, AssetVersionState } from '@mercaria/shared-types';

const createAbuseReport = vi.fn();
const findListingById = vi.fn();

vi.mock('../../../moderation/report-intake.service.js', () => ({
  createAbuseReport: (...args: unknown[]) => createAbuseReport(...args),
}));

vi.mock('../../../../db/catalog/listingRepository.js', () => ({
  findListingById: (...args: unknown[]) => findListingById(...args),
}));

import {
  SWEPT_PROVENANCE_SIGNAL_KINDS,
  UNSWEPT_PROVENANCE_SIGNAL_KINDS,
  sweepVersionForReUploads,
  type ProvenanceSweepReader,
} from '../sweep.js';
import {
  PROVENANCE_REVIEW_CATEGORY,
  buildProvenanceReviewPacket,
  fileProvenanceReview,
  renderProvenanceReviewDetails,
} from '../review.js';
import { assertEachOf } from '../../../../__tests__/assert-each-of.js';

/* -------------------------------------------------------------------------- */
/* A reader built from plain rows                                              */
/* -------------------------------------------------------------------------- */

interface FakeVersion {
  readonly id: string;
  readonly assetId: string;
  readonly state?: AssetVersionState;
  readonly publishedAt?: Date | null;
  readonly createdAt?: Date;
}

interface FakeWorld {
  readonly versions: readonly FakeVersion[];
  readonly assets: readonly { id: string; storeId: string }[];
  /** kind → value → the `{versionId, fileId}` rows the table holds. */
  readonly signals: Readonly<
    Record<string, Readonly<Record<string, readonly { versionId: string; fileId: string | null }[]>>>
  >;
}

/** Which kinds the sweep actually asked about — the decoy test reads this. */
let asked: AssetProvenanceSignalKind[] = [];

function readerFor(world: FakeWorld): ProvenanceSweepReader {
  return {
    matchingSignals: (kind, value, excludeVersionId) => {
      asked.push(kind);
      const rows = world.signals[kind]?.[value] ?? [];
      return Promise.resolve(rows.filter((row) => row.versionId !== excludeVersionId));
    },
    version: (versionId) => {
      const found = world.versions.find((version) => version.id === versionId);
      return Promise.resolve(
        found === undefined
          ? null
          : {
              id: found.id,
              assetId: found.assetId,
              state: found.state ?? 'published',
              publishedAt: found.publishedAt === undefined ? new Date('2026-01-01') : found.publishedAt,
              createdAt: found.createdAt ?? new Date('2025-12-01'),
            },
      );
    },
    asset: (assetId) =>
      Promise.resolve(world.assets.find((asset) => asset.id === assetId) ?? null),
  };
}

/** The subject: version `v-subject`, asset `a-subject`, store `s-mine`. */
const BASE_WORLD: FakeWorld = {
  versions: [{ id: 'v-subject', assetId: 'a-subject' }],
  assets: [{ id: 'a-subject', storeId: 's-mine' }],
  signals: {},
};

beforeEach(() => {
  asked = [];
  createAbuseReport.mockReset();
  findListingById.mockReset();
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — which signal kinds the sweep may compare', () => {
  it('the swept and unswept kinds partition the whole tuple, with nothing defaulting', () => {
    const union = [...SWEPT_PROVENANCE_SIGNAL_KINDS, ...UNSWEPT_PROVENANCE_SIGNAL_KINDS].sort();
    // Imported fresh rather than through the module under test, so a mistake in
    // the filter cannot agree with itself.
    const tuple = [
      'content_hash',
      'creator_declaration',
      'geometry_fingerprint',
      'preview_phash',
      'prior_publication',
    ];
    expect(union).toEqual(tuple);
    expect(SWEPT_PROVENANCE_SIGNAL_KINDS.length).toBe(3);
    expect(UNSWEPT_PROVENANCE_SIGNAL_KINDS.length).toBe(2);
  });

  it('the kinds a PERSON asserts are exactly the ones the sweep will not match on', () => {
    assertEachOf(['creator_declaration', 'prior_publication'] as const, 2, (kind) => {
      expect(UNSWEPT_PROVENANCE_SIGNAL_KINDS).toContain(kind);
      expect(SWEPT_PROVENANCE_SIGNAL_KINDS).not.toContain(kind);
    });
  });

  it('a human assertion is never even looked up — two creators both saying "my own work"', () => {
    return sweepVersionForReUploads(
      {
        subjectVersionId: 'v-subject',
        signals: [
          { kind: 'creator_declaration', value: 'my own work, modelled in Blender' },
          { kind: 'prior_publication', value: 'https://example.invalid/my-model' },
        ],
      },
      readerFor(BASE_WORLD),
    ).then((sweep) => {
      expect(sweep.sweptSignalCount).toBe(0);
      expect(sweep.candidates).toEqual([]);
      // The decoy: no read was issued at all, so the filter is not merely
      // discarding results after asking.
      expect(asked).toEqual([]);
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — the evidence a candidate carries', () => {
  const world: FakeWorld = {
    versions: [
      { id: 'v-subject', assetId: 'a-subject' },
      { id: 'v-theirs', assetId: 'a-theirs' },
    ],
    assets: [
      { id: 'a-subject', storeId: 's-mine' },
      { id: 'a-theirs', storeId: 's-theirs' },
    ],
    signals: {
      content_hash: { 'hash-a': [{ versionId: 'v-theirs', fileId: 'f-1' }] },
      geometry_fingerprint: { 'gfp1:q1024:abc': [{ versionId: 'v-theirs', fileId: 'f-1' }] },
      preview_phash: { 'phash1:0000000000000001': [{ versionId: 'v-theirs', fileId: 'f-2' }] },
    },
  };

  it('an identical-bytes match is `exact_bytes`', async () => {
    const sweep = await sweepVersionForReUploads(
      { subjectVersionId: 'v-subject', signals: [{ kind: 'content_hash', value: 'hash-a' }] },
      readerFor(world),
    );
    expect(sweep.candidates).toHaveLength(1);
    expect(sweep.candidates[0].strength).toBe('exact_bytes');
    expect(sweep.candidates[0].matchedKinds).toEqual(['content_hash']);
  });

  it('a geometry-only match is `normalized_geometry`', async () => {
    const sweep = await sweepVersionForReUploads(
      {
        subjectVersionId: 'v-subject',
        signals: [{ kind: 'geometry_fingerprint', value: 'gfp1:q1024:abc' }],
      },
      readerFor(world),
    );
    expect(sweep.candidates[0].strength).toBe('normalized_geometry');
  });

  it('a preview-only match is `preview_similarity`, the weakest', async () => {
    const sweep = await sweepVersionForReUploads(
      {
        subjectVersionId: 'v-subject',
        signals: [{ kind: 'preview_phash', value: 'phash1:0000000000000001' }],
      },
      readerFor(world),
    );
    expect(sweep.candidates[0].strength).toBe('preview_similarity');
  });

  it('several kinds matching one version report the strongest, and list them all', async () => {
    const sweep = await sweepVersionForReUploads(
      {
        subjectVersionId: 'v-subject',
        signals: [
          { kind: 'preview_phash', value: 'phash1:0000000000000001' },
          { kind: 'geometry_fingerprint', value: 'gfp1:q1024:abc' },
          { kind: 'content_hash', value: 'hash-a' },
        ],
      },
      readerFor(world),
    );
    expect(sweep.candidates).toHaveLength(1);
    expect(sweep.candidates[0].strength).toBe('exact_bytes');
    // Tuple order, not the order the caller happened to pass.
    expect(sweep.candidates[0].matchedKinds).toEqual([
      'content_hash',
      'geometry_fingerprint',
      'preview_phash',
    ]);
    expect(sweep.candidates[0].matchedSignalCount).toBe(3);
  });

  it('one signal matching through several files counts ONCE', async () => {
    const manyFiles: FakeWorld = {
      ...world,
      signals: {
        content_hash: {
          'hash-a': [
            { versionId: 'v-theirs', fileId: 'f-1' },
            { versionId: 'v-theirs', fileId: 'f-2' },
            { versionId: 'v-theirs', fileId: 'f-3' },
          ],
        },
      },
    };
    const sweep = await sweepVersionForReUploads(
      { subjectVersionId: 'v-subject', signals: [{ kind: 'content_hash', value: 'hash-a' }] },
      readerFor(manyFiles),
    );
    // Three rows, one signal. Counting rows would make a candidate that ships one
    // shared texture in three packages look three times as suspicious.
    expect(sweep.candidates[0].matchedSignalCount).toBe(1);
  });

  it('carries no verdict, no confidence and no `duplicateOf` — asserted by key', () => {
    const keys = Object.keys({
      candidateVersionId: '',
      candidateAssetId: '',
      candidateStoreId: '',
      candidateVersionState: 'published',
      candidatePublishedAt: null,
      candidateCreatedAt: new Date(),
      strength: 'exact_bytes',
      matchedKinds: [],
      matchedSignalCount: 0,
    });
    return sweepVersionForReUploads(
      { subjectVersionId: 'v-subject', signals: [{ kind: 'content_hash', value: 'hash-a' }] },
      readerFor(world),
    ).then((sweep) => {
      expect(Object.keys(sweep.candidates[0]).sort()).toEqual(keys.sort());
      for (const forbidden of ['verdict', 'confidence', 'score', 'duplicateOf', 'isStolen']) {
        expect(Object.keys(sweep.candidates[0])).not.toContain(forbidden);
      }
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — the false-positive cuts', () => {
  it("a creator matching their OWN other asset is dropped, and counted", async () => {
    const world: FakeWorld = {
      versions: [
        { id: 'v-subject', assetId: 'a-subject' },
        { id: 'v-my-other', assetId: 'a-my-other' },
      ],
      assets: [
        { id: 'a-subject', storeId: 's-mine' },
        // Same store. Splitting a pack into two products does this every time.
        { id: 'a-my-other', storeId: 's-mine' },
      ],
      signals: { content_hash: { 'hash-a': [{ versionId: 'v-my-other', fileId: null }] } },
    };
    const sweep = await sweepVersionForReUploads(
      { subjectVersionId: 'v-subject', signals: [{ kind: 'content_hash', value: 'hash-a' }] },
      readerFor(world),
    );
    expect(sweep.candidates).toEqual([]);
    // Reported rather than silently discarded: "nothing matched" and "everything
    // that matched was yours" are different facts about a creator.
    expect(sweep.ownStoreMatchCount).toBe(1);
  });

  it('a signal whose version row is gone is skipped, not reported with holes', async () => {
    const world: FakeWorld = {
      ...BASE_WORLD,
      signals: { content_hash: { 'hash-a': [{ versionId: 'v-vanished', fileId: null }] } },
    };
    const sweep = await sweepVersionForReUploads(
      { subjectVersionId: 'v-subject', signals: [{ kind: 'content_hash', value: 'hash-a' }] },
      readerFor(world),
    );
    expect(sweep.candidates).toEqual([]);
    expect(sweep.ownStoreMatchCount).toBe(0);
  });

  it('a sweep of a version that does not exist throws rather than reporting "clean"', async () => {
    await expect(
      sweepVersionForReUploads(
        { subjectVersionId: 'v-nope', signals: [{ kind: 'content_hash', value: 'hash-a' }] },
        readerFor(BASE_WORLD),
      ),
    ).rejects.toThrow(/does not exist/);
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — the ordering is a chronology, never a confidence', () => {
  const world: FakeWorld = {
    versions: [
      { id: 'v-subject', assetId: 'a-subject' },
      { id: 'v-old', assetId: 'a-old', publishedAt: new Date('2024-03-01') },
      { id: 'v-new', assetId: 'a-new', publishedAt: new Date('2026-05-01') },
      { id: 'v-draft', assetId: 'a-draft', state: 'draft', publishedAt: null },
      { id: 'v-exact', assetId: 'a-exact', publishedAt: new Date('2026-08-01') },
    ],
    assets: [
      { id: 'a-subject', storeId: 's-mine' },
      { id: 'a-old', storeId: 's-1' },
      { id: 'a-new', storeId: 's-2' },
      { id: 'a-draft', storeId: 's-3' },
      { id: 'a-exact', storeId: 's-4' },
    ],
    signals: {
      geometry_fingerprint: {
        'gfp1:q1024:abc': [
          { versionId: 'v-new', fileId: null },
          { versionId: 'v-draft', fileId: null },
          { versionId: 'v-old', fileId: null },
        ],
      },
      content_hash: { 'hash-a': [{ versionId: 'v-exact', fileId: null }] },
    },
  };

  it('strongest evidence first, then earliest published, then never-published last', async () => {
    const sweep = await sweepVersionForReUploads(
      {
        subjectVersionId: 'v-subject',
        signals: [
          { kind: 'geometry_fingerprint', value: 'gfp1:q1024:abc' },
          { kind: 'content_hash', value: 'hash-a' },
        ],
      },
      readerFor(world),
    );
    expect(sweep.candidates.map((candidate) => candidate.candidateVersionId)).toEqual([
      // exact_bytes wins on strength even though it is the NEWEST of the four.
      'v-exact',
      'v-old',
      'v-new',
      // Never published: nobody copied from it, so it sorts last.
      'v-draft',
    ]);
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — the review packet shares no files and no other creator', () => {
  const world: FakeWorld = {
    versions: [
      { id: 'v-subject', assetId: 'a-subject', publishedAt: new Date('2026-09-02T11:22:33Z') },
      { id: 'v-theirs', assetId: 'a-theirs', publishedAt: new Date('2025-07-04T05:06:07Z') },
      { id: 'v-also', assetId: 'a-also', publishedAt: new Date('2026-02-02T00:00:00Z') },
    ],
    assets: [
      { id: 'a-subject', storeId: 's-mine' },
      { id: 'a-theirs', storeId: 's-theirs' },
      { id: 'a-also', storeId: 's-other' },
    ],
    signals: {
      geometry_fingerprint: {
        'gfp1:q1024:abc': [
          { versionId: 'v-theirs', fileId: 'f-secret' },
          { versionId: 'v-also', fileId: 'f-secret-2' },
        ],
      },
    },
  };

  async function sweep() {
    return sweepVersionForReUploads(
      {
        subjectVersionId: 'v-subject',
        signals: [{ kind: 'geometry_fingerprint', value: 'gfp1:q1024:abc' }],
      },
      readerFor(world),
    );
  }

  it('the packet has a field for the subject and counts, and for nothing else', async () => {
    const packet = buildProvenanceReviewPacket(await sweep());
    expect(Object.keys(packet).sort()).toEqual(
      [
        'earliestOtherPublishedOn',
        'matchedKinds',
        'methods',
        'otherVersionCount',
        'strength',
        'subjectPublishedOn',
        'subjectVersionId',
      ].sort(),
    );
    assertEachOf(
      [
        'candidateVersionId',
        'candidateAssetId',
        'candidateStoreId',
        'storeId',
        'fileId',
        'fileName',
        'storageKey',
        'contentHash',
        'url',
      ],
      9,
      (field) => {
        expect(Object.keys(packet)).not.toContain(field);
      },
    );
  });

  it('the earliest matching publication is a DATE, and the timestamp is gone', async () => {
    const packet = buildProvenanceReviewPacket(await sweep());
    expect(packet.earliestOtherPublishedOn).toBe('2025-07-04');
    expect(packet.subjectPublishedOn).toBe('2026-09-02');
    expect(packet.otherVersionCount).toBe(2);
  });

  it('the rendered details name no id but the subject version, and fit the column', async () => {
    const rendered = renderProvenanceReviewDetails(buildProvenanceReviewPacket(await sweep()));
    // `abuse_reports_details_length_check` is 2000 characters.
    expect(rendered.length).toBeLessThanOrEqual(2_000);
    expect(rendered).toContain('EVIDENCE, not a finding');
    expect(rendered).toContain('v-subject');
    assertEachOf(['v-theirs', 'v-also', 'a-theirs', 's-theirs', 'f-secret'], 5, (secret) => {
      expect(rendered).not.toContain(secret);
    });
    // And the method is stated, so a decision is reproducible.
    expect(rendered).toContain('gfp1');
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W8 — filing goes through the EXISTING abuse-report path', () => {
  const world: FakeWorld = {
    versions: [
      { id: 'v-subject', assetId: 'a-subject' },
      { id: 'v-theirs', assetId: 'a-theirs' },
    ],
    assets: [
      { id: 'a-subject', storeId: 's-mine' },
      { id: 'a-theirs', storeId: 's-theirs' },
    ],
    signals: { content_hash: { 'hash-a': [{ versionId: 'v-theirs', fileId: null }] } },
  };

  async function matchingSweep() {
    return sweepVersionForReUploads(
      { subjectVersionId: 'v-subject', signals: [{ kind: 'content_hash', value: 'hash-a' }] },
      readerFor(world),
    );
  }

  it('files one report about the LISTING, with the operator as the reporter', async () => {
    findListingById.mockResolvedValue({ id: 'l-1', ownerType: 'store', storeId: 's-mine' });
    createAbuseReport.mockResolvedValue({ report: { id: 'r-1' }, outboxEventId: 'o-1' });

    const filed = await fileProvenanceReview({
      operatorOxyUserId: 'op-7',
      listingId: 'l-1',
      sweep: await matchingSweep(),
    });

    expect(createAbuseReport).toHaveBeenCalledTimes(1);
    const args = createAbuseReport.mock.calls[0][0] as Record<string, unknown>;
    expect(args.reporterOxyUserId).toBe('op-7');
    expect(args.reportedType).toBe('listing');
    expect(args.reportedId).toBe('l-1');
    expect(args.categories).toEqual([PROVENANCE_REVIEW_CATEGORY]);
    expect(filed.reportId).toBe('r-1');
    expect(filed.outboxEventId).toBe('o-1');
  });

  it('refuses a sweep with no candidates — the absence of evidence is not a report', async () => {
    findListingById.mockResolvedValue({ id: 'l-1', ownerType: 'store', storeId: 's-mine' });
    const empty = await sweepVersionForReUploads(
      { subjectVersionId: 'v-subject', signals: [] },
      readerFor(world),
    );
    await expect(
      fileProvenanceReview({ operatorOxyUserId: 'op-7', listingId: 'l-1', sweep: empty }),
    ).rejects.toThrow(/nothing to review/);
    expect(createAbuseReport).not.toHaveBeenCalled();
  });

  it('refuses a missing operator id — there is no platform principal', async () => {
    await expect(
      fileProvenanceReview({ operatorOxyUserId: '', listingId: 'l-1', sweep: await matchingSweep() }),
    ).rejects.toThrow(/operator id is required/);
    expect(createAbuseReport).not.toHaveBeenCalled();
  });

  it("refuses a listing belonging to anybody but the subject version's own store", async () => {
    findListingById.mockResolvedValue({ id: 'l-2', ownerType: 'store', storeId: 's-theirs' });
    await expect(
      fileProvenanceReview({
        operatorOxyUserId: 'op-7',
        listingId: 'l-2',
        sweep: await matchingSweep(),
      }),
      // Without this, the operator surface is a "report any listing as stolen"
      // button with a machine-generated justification attached.
    ).rejects.toThrow(/does not belong to the store/);
    expect(createAbuseReport).not.toHaveBeenCalled();
  });

  it('refuses a P2P listing, which a digital asset can never be behind', async () => {
    findListingById.mockResolvedValue({ id: 'l-3', ownerType: 'user', oxyUserId: 'u-1', storeId: null });
    await expect(
      fileProvenanceReview({
        operatorOxyUserId: 'op-7',
        listingId: 'l-3',
        sweep: await matchingSweep(),
      }),
    ).rejects.toThrow(/does not belong to the store/);
  });

  it('refuses a listing that does not exist', async () => {
    findListingById.mockResolvedValue(null);
    await expect(
      fileProvenanceReview({
        operatorOxyUserId: 'op-7',
        listingId: 'l-gone',
        sweep: await matchingSweep(),
      }),
    ).rejects.toThrow(/does not exist/);
  });
});
