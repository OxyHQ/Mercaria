/**
 * The 3D profile package and the one thing that applies it (#1015 Workstream 3).
 *
 * A barrel over five modules, and the split is by WHAT EACH ONE CAN BREAK rather
 * than by size: `types.ts` is the shape, `package.ts` is the data an operator
 * argues with, `apply.ts` is the only writer of the catalogue half, `licences.ts`
 * is the only writer of the licence half, and `census.ts` is the measurement that
 * refuses to believe either of them.
 *
 * `scripts/seed-digital-3d.ts` is the operator who chooses to run it.
 */

export * from './types.js';
export { THREE_D_PROFILE_PACKAGE } from './package.js';
export {
  applyThreeDProfilePackage,
  disagreementsWithPublishedVocabulary,
  namespaceFor,
  namespaceRule,
  nsCategoryKey,
  nsKey,
  nsSlug,
  profileVocabularyFingerprint,
  type ApplyProfilesOptions,
  type ProfileSeedHandles,
  type ProfileSeedReport,
  type ProfileSeedResult,
  type ProfileStep,
  type ProfileStepOutcome,
  type ThreeDNamespace,
} from './apply.js';
export {
  applyReferenceLicences,
  decideLicenceVersionStep,
  licenceTermsDisagreements,
  type LicenceVersionStep,
  type ReferenceLicenceResult,
  type ReferenceLicenceStep,
} from './licences.js';
export {
  censusThreeDProfiles,
  deriveExpectation,
  formatProfileCensus,
  judgeProfileCensus,
  PROFILE_CENSUS_POSITIVE_CONTROL_ENTITIES,
  type ProfileCensusLine,
  type ProfileCensusVerdict,
} from './census.js';
