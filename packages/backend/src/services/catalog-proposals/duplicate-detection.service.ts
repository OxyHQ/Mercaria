/**
 * Duplicate detection, run BEFORE a submission is stored (#367 step 6,
 * ADR 0007 D9).
 *
 * The failure this exists to prevent is not a duplicate slipping through. It is
 * a scan that reported nothing because it examined nothing — the same empty list
 * a clean result produces, in a report that reads as diligence. So the shape of
 * the answer is a {@link CatalogProposalDuplicateScan}, whose `population` is the
 * size of the set the probes actually read and is returned by the detector rather
 * than supplied to it. A caller cannot fabricate it and a `0` is a legible
 * answer, not a missing one.
 *
 * ## Three detectors, and only two of them may refuse anything
 *
 * `exact_normalized` and `recorded_alias` (`CATALOG_PROPOSAL_BLOCKING_DETECTORS`)
 * are facts: the thing already exists under that name, or somebody has already
 * recorded that spelling as meaning something else. `trigram_similarity` is a
 * score, and a score refusing a submission would mean a merchant with a
 * legitimately similar product name being told, with no remedy, that their
 * concept already exists. It is recorded as EVIDENCE the reviewer reads.
 *
 * ## An exact hit on an EXISTING ENTITY and one on an OPEN PROPOSAL are
 * different outcomes
 *
 * The first means "use this" and the submission is refused naming it. The second
 * means somebody already asked and the submitter now waits WITH them — the
 * convergence this whole domain is built around, and the reason
 * `catalog_proposals_open_convergence_key` exists. Collapsing them would make a
 * request that is already under way look like a refusal.
 */

import type {
  CatalogProposalDuplicateCandidate,
  CatalogProposalDuplicateScan,
  CatalogProposalType,
} from '@mercaria/shared-types';
import { uuidv7 } from '@oxyhq/db';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  probeControlledValues,
  probeNamedEntities,
  probeValueAliases,
  type DuplicateProbe,
} from '../../db/catalogProposals/duplicateRepository.js';
import { findOpenProposalByConvergenceKey } from '../../db/catalogProposals/proposalRepository.js';

/** Everything a scan is about. */
export interface DuplicateScanInput {
  readonly type: CatalogProposalType;
  readonly normalizedLabel: string;
  readonly searchLabel: string;
  readonly attributeDefinitionId: string | null;
  /** The convergence key the submission WOULD carry. See the module doc. */
  readonly convergenceKey: string;
  readonly nearLimit: number;
  readonly nearThreshold: number;
}

/**
 * Run every probe the type has and compose the verdict.
 *
 * The probes are additive: a `controlled_value` runs the value probe AND the
 * alias probe, and their populations SUM, because both sets are things the scan
 * genuinely compared against. Reporting only the larger would understate what was
 * examined; reporting the max would make the number un-derivable from anything.
 */
export async function scanForDuplicates(
  db: DatabaseOrTransaction,
  input: DuplicateScanInput,
): Promise<CatalogProposalDuplicateScan> {
  const probes: { readonly detector: CatalogProposalDuplicateCandidate['detector']; readonly probe: DuplicateProbe }[] =
    [];

  if (input.type === 'controlled_value' && input.attributeDefinitionId !== null) {
    probes.push({
      detector: 'exact_normalized',
      probe: await probeControlledValues(
        db,
        input.attributeDefinitionId,
        input.normalizedLabel,
        input.searchLabel,
        input.nearLimit,
      ),
    });
    probes.push({
      detector: 'recorded_alias',
      probe: await probeValueAliases(db, input.attributeDefinitionId, input.normalizedLabel),
    });
  } else {
    probes.push({
      detector: 'exact_normalized',
      probe: await probeNamedEntities(
        db,
        input.type,
        input.normalizedLabel,
        input.searchLabel,
        input.nearLimit,
      ),
    });
  }

  const candidates: CatalogProposalDuplicateCandidate[] = [];
  let population = 0;
  let blocking: CatalogProposalDuplicateCandidate | null = null;

  for (const entry of probes) {
    population += entry.probe.population;
    if (entry.probe.exact !== null) {
      const candidate: CatalogProposalDuplicateCandidate = {
        id: uuidv7(),
        kind: 'existing_entity',
        detector: entry.detector,
        ref: entry.probe.exact.ref,
        label: entry.probe.exact.label,
        similarity: null,
      };
      candidates.push(candidate);
      // The FIRST blocking hit wins and later ones are still recorded. Order is
      // the probe order — the value's own name before an alias for it — which is
      // the order a person would want to be told about them in.
      blocking = blocking ?? candidate;
    }
    for (const near of entry.probe.near) {
      // The threshold is applied HERE and not in SQL: the query is
      // `ORDER BY x <-> $1 LIMIT n`, the one shape a trigram index can serve
      // (#61), so it always returns n rows however unlike they are.
      if (near.similarity < input.nearThreshold) continue;
      candidates.push({
        id: uuidv7(),
        kind: 'existing_entity',
        detector: 'trigram_similarity',
        ref: near.ref,
        label: near.label,
        similarity: near.similarity,
      });
    }
  }

  // The open proposal covering this exact concept, if there is one. Read through
  // the SAME convergence key the partial unique holds, so "would this collide"
  // and "does it collide" are one question.
  const open = await findOpenProposalByConvergenceKey(db, input.convergenceKey);
  const convergesOnto: CatalogProposalDuplicateCandidate | null =
    open === null
      ? null
      : {
          id: uuidv7(),
          kind: 'open_proposal',
          detector: 'exact_normalized',
          ref: open.id,
          label: open.proposedLabel,
          similarity: null,
        };
  if (convergesOnto !== null) {
    candidates.push(convergesOnto);
    // The open proposal counts toward the population too: it is a label the scan
    // compared against, and leaving it out would let a scan that examined exactly
    // one thing — and matched it — report a population of zero.
    population += 1;
  }

  return { population, candidates, blocking, convergesOnto };
}
