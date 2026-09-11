/**
 * The re-upload sweep: which OTHER versions carry a fingerprint this one carries
 * (#1015 W8).
 *
 * ## It produces candidates. It never produces a finding
 *
 * `findMatchingProvenanceSignals`' docblock states the constraint this module is
 * built around: *"there is no `isStolen` to return and no confidence to compute,
 * so a caller cannot accuse anybody with it. What it feeds is a moderation review
 * a human decides."* This is that caller. It classifies a candidate by WHICH KIND
 * of evidence matched — which is a description of the evidence, not a judgement
 * about it — and it stops.
 *
 * Three things it therefore does not do, each of which would be one small function
 * away and each of which #1015 W8 forbids:
 *
 * - **It does not take an action.** Nothing here restricts, archives, withdraws,
 *   unlists or refuses a publication. `catalog-write.service` and
 *   `services/moderation/enforcement.service` are the only things that enforce,
 *   and they act on a DECISION.
 * - **It does not file anything.** `review.ts` files, and only when an operator
 *   passes their own id. There is no path from a fingerprint match to a report.
 * - **It does not notify anybody.** In particular it never tells the creator of a
 *   matched version that somebody's upload resembles theirs, because the honest
 *   form of that message contains a claim nobody has decided, aimed at a person
 *   nobody has judged.
 *
 * ## Nothing is STORED
 *
 * A sweep result is derived on demand and thrown away. That is not laziness about
 * a table: ADR 0010's evidence table *"deliberately holds no verdict, no
 * `duplicate_of` and no confidence score"*, and a persisted candidate list is a
 * verdict-shaped row wearing a different name — it would be read months later as
 * "the system flagged this", by somebody who never saw this docblock. Re-deriving
 * is cheap (one indexed equality read per signal) and it has a property a stored
 * list cannot have: it reflects the evidence as it stands TODAY, including
 * whatever the accused creator has since appended through `appeal.ts`.
 *
 * ## Same-store candidates are dropped, and that is the biggest false-positive cut
 *
 * A creator re-uploading their own mesh into a new asset, splitting a pack into
 * two products, or publishing a variant of their own model matches themselves on
 * every signal. That is not a re-upload in any sense #1015 W8 means, and it is by
 * a wide margin the most common way a fingerprint match happens.
 */

import type { AssetProvenanceSignalKind, AssetVersionState } from '@mercaria/shared-types';
import { ASSET_PROVENANCE_SIGNAL_KINDS } from '@mercaria/shared-types';
import {
  findDigitalAsset,
  findAssetVersion,
  findMatchingProvenanceSignals,
} from '../../../db/digital/assetRepository.js';
import type { DerivedProvenanceSignal } from './derive-signals.js';

/* -------------------------------------------------------------------------- */
/* Which kinds are comparable at all                                           */
/* -------------------------------------------------------------------------- */

/**
 * The signal kinds the sweep matches on.
 *
 * Three of the five, and the two omissions are a safety property rather than a
 * scope decision: `creator_declaration` and `prior_publication` are things a
 * PERSON wrote. Two creators who both type "my own work, modelled in Blender"
 * would match each other exactly, and an appeal — which is precisely a creator
 * writing one of these — would then create the candidate it exists to answer.
 *
 * So the kinds an appeal can write are exactly the kinds the sweep cannot match
 * on. `__tests__/provenance-boundaries.test.ts` asserts that in both directions
 * and asserts the union is the whole tuple, so a sixth kind must be classified
 * rather than defaulting into either half.
 */
export const SWEPT_PROVENANCE_SIGNAL_KINDS: readonly AssetProvenanceSignalKind[] = [
  'content_hash',
  'geometry_fingerprint',
  'preview_phash',
];

/** The complement — asserted to be the complement, never retyped as a list. */
export const UNSWEPT_PROVENANCE_SIGNAL_KINDS: readonly AssetProvenanceSignalKind[] =
  ASSET_PROVENANCE_SIGNAL_KINDS.filter((kind) => !SWEPT_PROVENANCE_SIGNAL_KINDS.includes(kind));

/* -------------------------------------------------------------------------- */
/* What a candidate is                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How strong the EVIDENCE is — a description of what matched, not a probability.
 *
 * Named after the mechanism rather than after a conclusion (`likely_stolen`,
 * `probable_duplicate`) on purpose: a reviewer reading `normalized_geometry`
 * learns what the machine did, and a reviewer reading `probable_duplicate` learns
 * what the machine thinks, which it is not entitled to think.
 */
export type ProvenanceMatchStrength =
  /** Byte-identical files. The strongest thing a machine can say here. */
  | 'exact_bytes'
  /** The normalised, quantised vertex sets agree. A re-export survives this. */
  | 'normalized_geometry'
  /** Generated previews hash alike. The weakest, and ordered last. */
  | 'preview_similarity';

const STRENGTH_ORDER: readonly ProvenanceMatchStrength[] = [
  'exact_bytes',
  'normalized_geometry',
  'preview_similarity',
];

const STRENGTH_OF_KIND: Readonly<Record<string, ProvenanceMatchStrength>> = Object.freeze({
  content_hash: 'exact_bytes',
  geometry_fingerprint: 'normalized_geometry',
  preview_phash: 'preview_similarity',
});

/**
 * One other version carrying at least one of this version's fingerprints.
 *
 * **Operator-facing.** It names the other asset, because an operator deciding
 * whether to open a review has to be able to look at it. What LEAVES Mercaria is
 * `ProvenanceReviewPacket` in `review.ts`, which names none of this — the same
 * two-shape device `MerchantAnalyticsSummary` uses, where the projection is the
 * enforcement rather than a filter somebody has to keep correct.
 */
export interface ProvenanceMatchCandidate {
  readonly candidateVersionId: string;
  readonly candidateAssetId: string;
  readonly candidateStoreId: string;
  readonly candidateVersionState: AssetVersionState;
  /** When the candidate was first published, or `null` if it never was. */
  readonly candidatePublishedAt: Date | null;
  /** When the candidate version row was created — always present. */
  readonly candidateCreatedAt: Date;
  readonly strength: ProvenanceMatchStrength;
  /** Every kind that matched, in tuple order. Deduped. */
  readonly matchedKinds: readonly AssetProvenanceSignalKind[];
  /** How many of the subject's signals this candidate matched. */
  readonly matchedSignalCount: number;
}

/** The whole result of one sweep. There is no verdict field and never will be. */
export interface ProvenanceSweep {
  readonly subjectVersionId: string;
  readonly subjectAssetId: string;
  readonly subjectStoreId: string;
  /** When the subject was first published, or `null` while it is unpublished. */
  readonly subjectPublishedAt: Date | null;
  /** How many signals were actually compared. Zero means "we looked at nothing". */
  readonly sweptSignalCount: number;
  /** Candidates, strongest evidence first, then oldest first. */
  readonly candidates: readonly ProvenanceMatchCandidate[];
  /**
   * Matches against the subject's OWN store, dropped.
   *
   * Reported rather than silently discarded so an operator reading an empty
   * candidate list can tell "nothing matched" from "everything that matched was
   * yours", which are different facts about a creator.
   */
  readonly ownStoreMatchCount: number;
}

/* -------------------------------------------------------------------------- */
/* The reads, as a port                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Everything the sweep reads.
 *
 * Injected for the reason `ranking-surface.ts` gives for its directory reader: the
 * interesting cases are POPULATIONS — a candidate in the same store, a candidate
 * whose version row has vanished, three signals landing on one version — and
 * building each of those in a shared Postgres database costs a fixture per case
 * and gives the sweep's own logic no better coverage than a stub does. The
 * repository functions underneath are exercised against a real server by
 * `db/digital/__tests__/digital-commerce.realdb.test.ts`, which is where the SQL
 * belongs.
 */
export interface ProvenanceSweepReader {
  matchingSignals(
    kind: AssetProvenanceSignalKind,
    value: string,
    excludeVersionId: string,
  ): Promise<readonly { versionId: string; fileId: string | null }[]>;
  version(versionId: string): Promise<{
    readonly id: string;
    readonly assetId: string;
    readonly state: AssetVersionState;
    readonly publishedAt: Date | null;
    readonly createdAt: Date;
  } | null>;
  asset(assetId: string): Promise<{ readonly id: string; readonly storeId: string } | null>;
}

/** The production reader: the existing repository, and nothing new. */
export const repositoryProvenanceSweepReader: ProvenanceSweepReader = {
  matchingSignals: (kind, value, excludeVersionId) =>
    findMatchingProvenanceSignals(kind, value, excludeVersionId),
  version: async (versionId) => {
    const row = await findAssetVersion(versionId);
    return row === null
      ? null
      : {
          id: row.id,
          assetId: row.assetId,
          state: row.state,
          publishedAt: row.publishedAt,
          createdAt: row.createdAt,
        };
  },
  asset: async (assetId) => {
    const row = await findDigitalAsset(assetId);
    return row === null ? null : { id: row.id, storeId: row.storeId };
  },
};

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Sweep one version's derived fingerprints for probable re-uploads.
 *
 * The subject's store is READ rather than taken as a parameter. A caller that
 * passed the wrong one would silently disable the same-store cut — the single
 * largest false-positive filter here — and nothing would fail, which is the shape
 * of defect this codebase asks callers not to be able to write.
 *
 * @throws when the subject version, or the asset it belongs to, does not exist.
 *   A sweep of nothing is a programming error, not an empty result: returning an
 *   empty candidate list for a bad id would read as "we checked and it is clean".
 */
export async function sweepVersionForReUploads(
  input: {
    readonly subjectVersionId: string;
    readonly signals: readonly DerivedProvenanceSignal[];
  },
  reader: ProvenanceSweepReader = repositoryProvenanceSweepReader,
): Promise<ProvenanceSweep> {
  const subjectVersion = await reader.version(input.subjectVersionId);
  if (subjectVersion === null) {
    throw new Error(`sweepVersionForReUploads: version ${input.subjectVersionId} does not exist.`);
  }
  const subjectAsset = await reader.asset(subjectVersion.assetId);
  if (subjectAsset === null) {
    throw new Error(
      `sweepVersionForReUploads: asset ${subjectVersion.assetId} does not exist.`,
    );
  }

  const swept = input.signals.filter((signal) =>
    SWEPT_PROVENANCE_SIGNAL_KINDS.includes(signal.kind),
  );

  /** versionId → the kinds that matched it, and how many signals did. */
  const hits = new Map<string, { kinds: Set<AssetProvenanceSignalKind>; signals: number }>();
  for (const signal of swept) {
    const matches = await reader.matchingSignals(
      signal.kind,
      signal.value,
      input.subjectVersionId,
    );
    // One signal may match a version through several of its files. That is ONE
    // signal matching, not several: counting rows would let a candidate that
    // happened to ship the same texture in twelve packages look twelve times as
    // suspicious as one that shipped the whole mesh.
    for (const versionId of new Set(matches.map((match) => match.versionId))) {
      const entry = hits.get(versionId) ?? { kinds: new Set(), signals: 0 };
      entry.kinds.add(signal.kind);
      entry.signals += 1;
      hits.set(versionId, entry);
    }
  }

  const assetCache = new Map<string, { readonly id: string; readonly storeId: string } | null>();
  const candidates: ProvenanceMatchCandidate[] = [];
  let ownStoreMatchCount = 0;

  for (const [versionId, entry] of hits) {
    const version = await reader.version(versionId);
    // A signal outliving the version row is the `ON DELETE SET NULL` case the
    // evidence table documents for files, one level up: the evidence remains and
    // there is nothing left to review. Skipped, not reported as a candidate with
    // holes in it.
    if (version === null) continue;

    if (!assetCache.has(version.assetId)) {
      assetCache.set(version.assetId, await reader.asset(version.assetId));
    }
    const asset = assetCache.get(version.assetId);
    if (asset === null || asset === undefined) continue;

    if (asset.storeId === subjectAsset.storeId) {
      ownStoreMatchCount += 1;
      continue;
    }

    const matchedKinds = ASSET_PROVENANCE_SIGNAL_KINDS.filter((kind) => entry.kinds.has(kind));
    candidates.push({
      candidateVersionId: version.id,
      candidateAssetId: version.assetId,
      candidateStoreId: asset.storeId,
      candidateVersionState: version.state,
      candidatePublishedAt: version.publishedAt,
      candidateCreatedAt: version.createdAt,
      strength: strongestOf(matchedKinds),
      matchedKinds,
      matchedSignalCount: entry.signals,
    });
  }

  candidates.sort(compareCandidates);

  return {
    subjectVersionId: subjectVersion.id,
    subjectAssetId: subjectAsset.id,
    subjectStoreId: subjectAsset.storeId,
    subjectPublishedAt: subjectVersion.publishedAt,
    sweptSignalCount: swept.length,
    candidates,
    ownStoreMatchCount,
  };
}

/** The strongest evidence among the kinds that matched. */
function strongestOf(kinds: readonly AssetProvenanceSignalKind[]): ProvenanceMatchStrength {
  let best: ProvenanceMatchStrength = 'preview_similarity';
  let bestRank = STRENGTH_ORDER.length;
  for (const kind of kinds) {
    const strength = STRENGTH_OF_KIND[kind];
    if (strength === undefined) continue;
    const rank = STRENGTH_ORDER.indexOf(strength);
    if (rank < bestRank) {
      bestRank = rank;
      best = strength;
    }
  }
  return best;
}

/**
 * Strongest evidence first, then EARLIEST first.
 *
 * The second key is a chronology, not a score. Sorting by "how much matched"
 * would be a confidence ranking in everything but name, and the table refuses to
 * carry one for a reason; sorting by when the other version appeared puts the
 * question a reviewer actually has to answer — which of these two came first —
 * at the top of the list without answering it. A candidate that was never
 * published sorts last, because an unpublished version cannot have been what
 * anybody copied from.
 */
function compareCandidates(
  left: ProvenanceMatchCandidate,
  right: ProvenanceMatchCandidate,
): number {
  const byStrength =
    STRENGTH_ORDER.indexOf(left.strength) - STRENGTH_ORDER.indexOf(right.strength);
  if (byStrength !== 0) return byStrength;

  const leftAt = left.candidatePublishedAt;
  const rightAt = right.candidatePublishedAt;
  if (leftAt !== null && rightAt !== null && leftAt.getTime() !== rightAt.getTime()) {
    return leftAt.getTime() - rightAt.getTime();
  }
  if (leftAt === null && rightAt !== null) return 1;
  if (leftAt !== null && rightAt === null) return -1;

  // A total order, so two runs over one population produce one list. An unstable
  // tail would make a reviewer's "the second one" mean something different on a
  // refresh.
  return left.candidateVersionId < right.candidateVersionId ? -1 : 1;
}
