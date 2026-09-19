/**
 * Seeding Mercaria's reference licences (#1015 Workstream 3 part 2, ADR 0010 D3).
 *
 * ## What was missing
 *
 * `MERCARIA_REFERENCE_LICENCES` is three licences' worth of terms in
 * `@mercaria/shared-types` and **nothing wrote them to a database**. A creator
 * picking "the platform's standard commercial terms" had nothing to point at, so
 * #1015 acceptance criterion 2 — *"at least personal and one commercial
 * licence"* — was satisfiable only by every creator drafting legal text, which is
 * the outcome the reference set exists to avoid.
 *
 * What it writes: an `asset_licences` row with `authorship: 'mercaria_reference'`
 * and `store_id NULL`, and version 1 of its terms, PUBLISHED. Three of each.
 *
 * ## Why `store_id` is NULL and why that is not "unowned"
 *
 * `asset_licences_authorship_store_check` is a biconditional — a
 * `mercaria_reference` licence has no store and a `creator` licence must have
 * one — so the NULL is not a missing value, it is the statement that these are
 * Mercaria's own and shared by every creator who picks them. Two partial unique
 * indexes carry the slug uniqueness, because Postgres treats NULLs as DISTINCT
 * and a plain UNIQUE would let `mercaria-personal` be published twice.
 *
 * ## How it converges, and what "twice" actually means
 *
 * A fresh deployment must be able to run this twice (#1015 W3), and there are
 * three distinguishable states a second run can meet:
 *
 * 1. **Nothing there.** Insert, publish.
 * 2. **Licence there, version 1 PUBLISHED.** Compare the stored terms against the
 *    published tuple and report `present` or `divergent`. Never correct: the
 *    terms are frozen by `asset_licence_versions_immutable_once_published`, so
 *    the only available "correction" would be a raise from the database.
 * 3. **Licence there, version 1 still `draft`.** The state a run interrupted
 *    between the two statements leaves. It is the case a naive implementation
 *    gets wrong — `findPublishedLicenceVersion` answers NULL for it, and a seed
 *    that read only that would try to insert version 1 again and die on
 *    `asset_licence_versions_licence_version_key`. So this module reads the
 *    version by `(licence, version)` REGARDLESS of state and publishes the draft
 *    it finds.
 *
 * That third case is why this reads `asset_licence_versions` directly instead of
 * going through `licenceRepository`, which publishes `findPublishedLicenceVersion`
 * and no by-version finder. The alternative was adding one to another
 * workstream's module; the precedent for a seed issuing its own read is
 * `scripts/seed-verticals/apply.ts`, which writes `attribute_value_localizations`
 * directly for the same reason — there is no repository function for the thing it
 * needs, and inventing one in passing is how a table acquires a second writer.
 * Every WRITE here still goes through the repository.
 *
 * `upsertAssetLicence` already converges on its own (`onConflictDoNothing` plus a
 * read back), and its docblock says why in as many words: *"seeding the Mercaria
 * reference licences runs on every boot of a fresh deployment and a second boot
 * must not fail"*. This module is the caller that sentence was written for.
 *
 * ## Why no feature lever gates it
 *
 * None of ADR 0010 D13's five levers is consulted, deliberately. A licence row
 * sells nothing, grants nothing and authorizes no download — the levers gate
 * uploads, publication, paid checkout, downloads and a vertical — and D15
 * requires the tax, provider and consumer-law sign-offs to happen BEFORE
 * `DIGITAL_PAID_CHECKOUT_ENABLED` goes on for a market. A seed that refused to
 * run until that flag was on would make preparing the licence catalogue
 * impossible until after the thing it is a prerequisite for.
 *
 * ## What it deliberately does NOT create
 *
 * An `asset_licence_options` row. An option is `(asset, package, licence version,
 * update policy)`, so it names a creator's asset and a creator's package — and
 * there are none. The suggested update policy per licence is recorded in the
 * package and in `docs/verticals/3d.md`; binding one to an offer is a creator's
 * act.
 */

import { and, eq } from 'drizzle-orm';

import {
  MERCARIA_REFERENCE_LICENCES,
  unmetLicenceRightDependencies,
} from '@mercaria/shared-types';
import type { DigitalLicenceVersionTerms } from '@mercaria/shared-types';

import type { DatabaseOrTransaction } from '../../../db/postgres.js';
import { getDb } from '../../../db/postgres.js';
import { assetLicenceVersions } from '../../../db/schema/digitalRights.js';
import {
  findAssetLicenceBySlug,
  insertAssetLicenceVersion,
  publishAssetLicenceVersion,
  upsertAssetLicence,
  type AssetLicenceVersionRow,
} from '../../../db/digital/licenceRepository.js';
import type { ProfileStep, ProfileStepOutcome } from './apply.js';
import type { ThreeDProfilePackage } from './types.js';

/** One licence step, in the apply report's own shape. */
export type ReferenceLicenceStep = ProfileStep;

export interface ReferenceLicenceResult {
  readonly steps: readonly ReferenceLicenceStep[];
  readonly licenceIds: ReadonlyMap<string, string>;
  readonly licenceVersionIds: ReadonlyMap<string, string>;
}

/**
 * Whether a stored version says what the published tuple says.
 *
 * Field by field, and `rights` as a SET — `asset_licence_versions.rights` is a
 * `text[]` and nothing guarantees the order a driver returns it in, so a
 * positional comparison would report a permanent divergence the first time
 * Postgres handed the array back in a different order. Sorting both sides is
 * not laxity: a licence granting `{personal_use, modification}` and one granting
 * `{modification, personal_use}` are the same licence, and `rights` is read in
 * its entirety on every authorization rather than by position.
 */
export function licenceTermsDisagreements(
  stored: AssetLicenceVersionRow,
  expected: DigitalLicenceVersionTerms,
  expectedSummary: string,
): string[] {
  const problems: string[] = [];
  const storedRights = [...(stored.rights ?? [])].sort();
  const expectedRights = [...expected.rights].sort();
  if (storedRights.join(',') !== expectedRights.join(',')) {
    problems.push(`rights stored [${storedRights.join(', ')}], expected [${expectedRights.join(', ')}]`);
  }
  if (stored.attribution !== expected.attribution) {
    problems.push(`attribution stored '${stored.attribution}', expected '${expected.attribution}'`);
  }
  if ((stored.seatLimit ?? null) !== expected.seatLimit) {
    problems.push(`seatLimit stored ${String(stored.seatLimit)}, expected ${String(expected.seatLimit)}`);
  }
  if ((stored.revenueLimitAmount ?? null) !== expected.revenueLimitAmount) {
    problems.push(
      `revenueLimitAmount stored ${String(stored.revenueLimitAmount)}, expected ${String(expected.revenueLimitAmount)}`,
    );
  }
  if ((stored.revenueLimitCurrency ?? null) !== expected.revenueLimitCurrency) {
    problems.push(
      `revenueLimitCurrency stored ${String(stored.revenueLimitCurrency)}, expected ${String(expected.revenueLimitCurrency)}`,
    );
  }
  if ((stored.projectLimit ?? null) !== expected.projectLimit) {
    problems.push(
      `projectLimit stored ${String(stored.projectLimit)}, expected ${String(expected.projectLimit)}`,
    );
  }
  if ((stored.additionalTerms ?? null) !== expected.additionalTerms) {
    problems.push('additionalTerms differs from the published reference text');
  }
  if (stored.summary !== expectedSummary) {
    problems.push('summary differs from the published reference text');
  }
  return problems;
}

/**
 * What to do about one licence version, decided from what is stored.
 *
 * PURE, and separated from the writing for the reason every judgement in this
 * subtree is: the four states cannot all be reached through a database. A version
 * left in `draft` by an interrupted run is the interesting one, and
 * `asset_licence_versions_immutable_once_published` freezes `published_at`
 * itself — so a test cannot manufacture that state from a published row even
 * inside a rolled-back transaction, not even with a trigger window. Driving the
 * decision directly is the only arrangement in which the draft case has a
 * control at all, and `three-d-profiles.test.ts` drives all four.
 */
export type LicenceVersionStep =
  /** Nothing stored. Insert the terms and publish them. */
  | { readonly action: 'insert_and_publish' }
  /**
   * Stored and still `draft` — what a run interrupted between the insert and the
   * publish leaves. Publishing it is the convergence; inserting again would hit
   * `asset_licence_versions_licence_version_key` and kill the seed for good.
   */
  | { readonly action: 'publish_existing_draft' }
  /** Stored, published, and saying exactly what the published tuple says. */
  | { readonly action: 'present' }
  /**
   * Stored and DISAGREEING. Reported, never corrected: the terms are frozen, so
   * the only available correction is a raise from the database.
   */
  | { readonly action: 'divergent'; readonly detail: string };

export function decideLicenceVersionStep(
  stored: AssetLicenceVersionRow | null,
  expected: DigitalLicenceVersionTerms,
  expectedSummary: string,
): LicenceVersionStep {
  if (stored === null) return { action: 'insert_and_publish' };
  if (stored.state === 'draft') return { action: 'publish_existing_draft' };
  const disagreements = licenceTermsDisagreements(stored, expected, expectedSummary);
  if (stored.state !== 'published') {
    disagreements.push(
      `state is '${stored.state}', and a reference licence version must be published`,
    );
  }
  return disagreements.length === 0
    ? { action: 'present' }
    : { action: 'divergent', detail: disagreements.join('; ') };
}

/**
 * The version row for `(licence, version)` whatever its state.
 *
 * A direct read rather than a repository call — see the module header for why,
 * and note it is the DRAFT case that makes it necessary rather than a
 * preference.
 */
async function findLicenceVersionByNumber(
  db: DatabaseOrTransaction,
  licenceId: string,
  version: number,
): Promise<AssetLicenceVersionRow | null> {
  const [row] = await db
    .select()
    .from(assetLicenceVersions)
    .where(and(eq(assetLicenceVersions.licenceId, licenceId), eq(assetLicenceVersions.version, version)))
    .limit(1);
  return row ?? null;
}

/**
 * Seed every reference licence the package names.
 *
 * `apply: false` reads the database and reports what it WOULD do, which is the
 * whole point of the dry run: a plan echoing the package would print the same
 * thing against a database holding all three licences and against one holding
 * none.
 */
export async function applyReferenceLicences(
  pkg: ThreeDProfilePackage,
  options: { readonly apply: boolean },
  handle?: DatabaseOrTransaction,
): Promise<ReferenceLicenceResult> {
  const db = handle ?? getDb();
  const steps: ReferenceLicenceStep[] = [];
  const licenceIds = new Map<string, string>();
  const licenceVersionIds = new Map<string, string>();

  const record = (
    entity: string,
    identity: string,
    outcome: ProfileStepOutcome,
    detail?: string,
  ): void => {
    steps.push(detail === undefined ? { entity, identity, outcome } : { entity, identity, outcome, detail });
  };

  for (const seed of pkg.licences) {
    const reference = MERCARIA_REFERENCE_LICENCES.find((licence) => licence.slug === seed.slug);
    if (reference === undefined) {
      // The package cannot supply terms it does not have, and guessing them
      // would be the seed authoring legal text. `disagreementsWithPublishedVocabulary`
      // catches this before a run starts; this is the belt for a direct caller.
      throw new Error(
        `The package seeds licence '${seed.slug}', which MERCARIA_REFERENCE_LICENCES does not define.`,
      );
    }

    // The write-time rule, applied AT the write (`unmetLicenceRightDependencies`
    // is deliberately not a CHECK — a constraint over two array elements of one
    // column reads as an accident and gets simplified away). Redistributing a
    // derivative you may not create is not a licence, it is a contradiction, and
    // a seed is exactly the caller that could ship one to every deployment at
    // once.
    const unmet = unmetLicenceRightDependencies(reference.terms.rights);
    if (unmet.length > 0) {
      throw new Error(
        `Reference licence '${seed.slug}' grants ${unmet
          .map(([right, requires]) => `'${right}' without '${requires}'`)
          .join(', ')}.`,
      );
    }

    if (!options.apply) {
      // A dry run READS. It resolves the licence and its version and reports
      // `create` or `present` without writing, because a plan that echoed the
      // package would print the same three lines against a database holding all
      // three licences and against one holding none — the measurement failure
      // the whole dry-run/apply split exists to avoid.
      const existing = await findAssetLicenceBySlug(null, seed.slug, db);
      record('asset_licence', seed.slug, existing === null ? 'create' : 'present');
      if (existing === null) {
        record('asset_licence_version', `${seed.slug}@${seed.version}`, 'create');
        continue;
      }
      const version = await findLicenceVersionByNumber(db, existing.id, seed.version);
      record(
        'asset_licence_version',
        `${seed.slug}@${seed.version}`,
        version === null ? 'create' : version.state === 'published' ? 'present' : 'create',
        version === null || version.state === 'published'
          ? undefined
          : `stored version is '${version.state}'; an apply would publish it`,
      );
      continue;
    }

    // Read BEFORE the upsert, so the report can tell a create from a present.
    // `upsertAssetLicence` converges with `onConflictDoNothing` plus a read back
    // and returns the row either way, which is exactly right for the caller and
    // useless for a report — and a seed whose output said `present` on a fresh
    // deployment would make the first run indistinguishable from the second.
    const before = await findAssetLicenceBySlug(null, reference.slug, db);
    const licence = await upsertAssetLicence(
      {
        storeId: null,
        authorship: 'mercaria_reference',
        slug: reference.slug,
        // The NAME comes from the published tuple, never from the seed: a
        // reference licence's name is part of what a buyer was shown, and a
        // second spelling of it in a backend constant is the drift this whole
        // domain is arranged against.
        name: reference.name,
      },
      db,
    );
    licenceIds.set(seed.slug, licence.id);
    const nameAgrees = licence.name === reference.name;
    record(
      'asset_licence',
      seed.slug,
      before === null ? 'create' : nameAgrees ? 'present' : 'divergent',
      nameAgrees
        ? undefined
        : `stored name '${licence.name}' differs from the published '${reference.name}'`,
    );

    const stored = await findLicenceVersionByNumber(db, licence.id, seed.version);
    const step = decideLicenceVersionStep(stored, reference.terms, reference.summary);
    if (step.action === 'insert_and_publish') {
      const inserted = await insertAssetLicenceVersion(
        {
          licenceId: licence.id,
          version: seed.version,
          summary: reference.summary,
          rights: reference.terms.rights,
          attribution: reference.terms.attribution,
          seatLimit: reference.terms.seatLimit,
          revenueLimitAmount: reference.terms.revenueLimitAmount,
          revenueLimitCurrency: reference.terms.revenueLimitCurrency,
          projectLimit: reference.terms.projectLimit,
          additionalTerms: reference.terms.additionalTerms,
        },
        db,
      );
      // Publishing is a CAS on `draft`, so a replay converges; `false` here means
      // somebody else published it between the two statements, which is the
      // right outcome and not an error.
      await publishAssetLicenceVersion(inserted.id, new Date(), db);
      licenceVersionIds.set(seed.slug, inserted.id);
      record('asset_licence_version', `${seed.slug}@${seed.version}`, 'create');
      continue;
    }

    // Unreachable with `stored === null`: that is the branch above, and the
    // narrowing is the compiler's rather than a comment's.
    if (stored === null) continue;
    licenceVersionIds.set(seed.slug, stored.id);

    if (step.action === 'publish_existing_draft') {
      // The interrupted-run case, and the only state transition this module
      // performs. `false` from the CAS means another caller published it between
      // the read and the write, which is the right outcome and not an error.
      const published = await publishAssetLicenceVersion(stored.id, new Date(), db);
      record(
        'asset_licence_version',
        `${seed.slug}@${seed.version}`,
        'create',
        published
          ? 'a previous run left this version in draft; published'
          : 'a previous run left this version in draft and another caller published it first',
      );
      continue;
    }

    record(
      'asset_licence_version',
      `${seed.slug}@${seed.version}`,
      step.action === 'present' ? 'present' : 'divergent',
      step.action === 'divergent' ? step.detail : undefined,
    );
  }

  return { steps, licenceIds, licenceVersionIds };
}
