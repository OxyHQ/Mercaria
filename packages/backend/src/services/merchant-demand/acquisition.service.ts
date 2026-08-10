/**
 * The operator merchant-acquisition pipeline (#86 §"Operator acquisition
 * pipeline").
 *
 * ## Read, plus a CLOSED set of writes, and every attempt audited
 *
 * `MERCHANT_ACQUISITION_ACTIONS` is the whole write surface. There is no "set
 * this merchant claimed", no "override this score", no "set this figure" and no
 * delete: the first would put a second answer beside a verdict #83 owns, the
 * second would make a score a thing somebody types rather than a function of
 * evidence, and the third and fourth would let the pipeline rewrite the record
 * it exists to keep. Every action calls `recordAcquisitionAudit` on BOTH
 * branches — `payment_repairs`' posture, because a surface whose audit records
 * only what succeeded cannot answer who tried.
 *
 * ## The conversion funnel is DERIVED and stored nowhere
 *
 * `merchants.claim_state` (#83), an active `native_store_links` row (#54/#84),
 * `provider_accounts.onboarding_state` (#46) and the presence of an active
 * native offer (#57) are four verdicts four other domains own. A copy on the
 * candidate row would be the one that goes stale the moment a claim is revoked,
 * and it would go stale on the operator's screen — so `deriveConversionStage`
 * reads all four live, and a revocation removes the merchant from the "claimed"
 * stage with no sweep in between.
 *
 * ## Scoring cannot reach ranking, in either direction
 *
 * `MerchantAcquisitionFacts` has one field per allowed input and none for any
 * forbidden one, so a scorer cannot READ a commission, a rank or a relevance
 * score whatever any weight is set to. The other direction — no ranking, search
 * or feed module may reach this domain — is a scanned gate with a vacuity floor
 * and a mutation self-test, because a score that could be read by an ordering
 * is a score that would eventually be one.
 */

import { and, eq } from 'drizzle-orm';
import {
  MERCHANT_ACQUISITION_SCORE_VERSION,
  scoreMerchantAcquisition,
  type MerchantAcquisitionAction,
  type MerchantAcquisitionCandidateView,
  type MerchantAcquisitionContactSourceKind,
  type MerchantAcquisitionConversionStage,
  type MerchantAcquisitionExclusionReason,
  type MerchantAcquisitionFacts,
  type MerchantAcquisitionOutreachChannel,
  type MerchantAcquisitionOutreachOutcome,
  type MerchantAcquisitionScoreInput,
  type MerchantAcquisitionSignal,
  type MerchantAcquisitionState,
  type MerchantDemandUnavailableReason,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  assignAcquisitionCandidate,
  clearAcquisitionExclusion,
  ensureAcquisitionCandidate,
  excludeAcquisitionCandidate,
  findAcquisitionCandidate,
  listAcquisitionCandidates,
  listContactSources,
  listOutreach,
  recordAcquisitionAudit,
  recordContactSource,
  recordOutreach,
  setAcquisitionDoNotContact,
  setAcquisitionNextAction,
  storeAcquisitionScore,
  type AcquisitionCandidateWithMerchant,
} from '../../db/merchantDemand/merchantAcquisitionRepository.js';
import { findProviderAccountByOwner } from '../../db/payments/providerAccountRepository.js';
import { merchants, nativeStoreLinks } from '../../db/schema/merchants.js';
import { offers } from '../../db/schema/offers.js';
import { notFound } from '../../lib/errors/error-codes.js';
import { resolveWindow } from './dashboard.service.js';
import { gatherMerchantDemandFacts, buildMerchantDemandSnapshot } from './snapshot.service.js';

/** The catalogue size a score treats as "as big as it needs to be". */
const CATALOG_SIZE_SATURATION = 500;

/** The interaction count a score treats as saturated demand. */
const DEMAND_SATURATION = 5_000;

/** The unmet-demand product count a score treats as saturated. */
const UNMET_DEMAND_SATURATION = 50;

/** A measured signal, normalized into `[0, 1]` against a saturation point. */
function saturating(value: number, saturation: number): MerchantAcquisitionSignal {
  return { outcome: 'measured', normalized: Math.min(1, Math.max(0, value / saturation)) };
}

/** An unmeasured signal. Left OUT of the mean, never imputed as zero. */
function unmeasured(reason: MerchantDemandUnavailableReason): MerchantAcquisitionSignal {
  return { outcome: 'unmeasured', reason };
}

/**
 * Which connector, if any, would fit this merchant.
 *
 * Measured from the catalogue SOURCES behind the merchant's offers: a merchant
 * Mercaria already ingests through a source it maintains an adapter for is one
 * a connector conversation can start from, and a merchant with no source at all
 * is one nobody has a route to. It is a MEASUREMENT rather than a judgement,
 * which is what keeps it out of the forbidden-input list — it says nothing about
 * what the merchant would pay.
 */
function connectorFitSignal(sourceIds: readonly (string | null)[]): MerchantAcquisitionSignal {
  const known = sourceIds.filter((id): id is string => id !== null);
  if (known.length === 0) return unmeasured('relationship_not_defensible');
  const distinct = new Set(known).size;
  // One source is the best fit — a single integration reaches the whole
  // catalogue. Several means the merchant's products arrive by several routes,
  // which is a harder conversation, not an impossible one.
  return { outcome: 'measured', normalized: 1 / distinct };
}

/**
 * Build the score inputs for one merchant from its demand facts.
 *
 * Exported so the isolation test can walk the returned object's FIELD NAMES:
 * "no forbidden signal has a fact field" is asserted against a real value, not
 * only against the interface.
 */
export function acquisitionFactsFrom(
  facts: Awaited<ReturnType<typeof gatherMerchantDemandFacts>>,
): MerchantAcquisitionFacts {
  const catalogSize = facts.canonicalProductIds.length;
  const unmet = facts.canonicalProductIds.filter(
    (productId) => !facts.nativeProductIds.has(productId),
  ).length;

  return {
    aggregateDemand: facts.collectionEnabled
      ? saturating(facts.offerImpressions + facts.productPageViews, DEMAND_SATURATION)
      : unmeasured('collection_disabled'),
    catalogSize:
      catalogSize === 0
        ? unmeasured('relationship_not_defensible')
        : saturating(catalogSize, CATALOG_SIZE_SATURATION),
    catalogFreshness:
      facts.offers.length === 0
        ? unmeasured('relationship_not_defensible')
        : saturating(facts.freshOfferCount / facts.offers.length, 1),
    sourceQuality:
      facts.offers.length === 0
        ? unmeasured('relationship_not_defensible')
        : // The share of the merchant's catalogue whose source Mercaria can
          // still name. An offer whose observation has no source is one nobody
          // can refresh, which is a fact about the SOURCE rather than about the
          // merchant — and it is the honest thing to score a route on.
          saturating(
            facts.offers.filter((offer) => offer.sourceId !== null).length / facts.offers.length,
            1,
          ),
    connectorFit: connectorFitSignal(facts.offers.map((offer) => offer.sourceId)),
    unmetNativeDemand: facts.collectionEnabled
      ? saturating(unmet, UNMET_DEMAND_SATURATION)
      : unmeasured('collection_disabled'),
  };
}

/**
 * Where this merchant stands in the conversion funnel. DERIVED, every time.
 *
 * The order is the funnel's and the checks stop at the first stage that fails,
 * because the stages are nested: a payment-ready merchant is necessarily
 * store-linked and claimed.
 */
export async function deriveConversionStage(
  merchantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionConversionStage> {
  const merchantRows = await db
    .select({ claimState: merchants.claimState })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  if (merchantRows[0]?.claimState !== 'claimed') return 'unclaimed';

  const linkRows = await db
    .select({ storeId: nativeStoreLinks.storeId })
    .from(nativeStoreLinks)
    .where(and(eq(nativeStoreLinks.merchantId, merchantId), eq(nativeStoreLinks.status, 'active')))
    .limit(1);
  const storeId = linkRows[0]?.storeId;
  if (storeId === undefined) return 'claimed';

  // #46's ONE stored readiness verdict, read live. There is no second boolean
  // here and none may be added: a stale copy on a candidate row is exactly the
  // failure `onboarding_state` exists to prevent, moved to a dashboard.
  const account = await findProviderAccountByOwner(db, {
    provider: 'stripe',
    ownerType: 'store',
    ownerId: storeId,
  });
  if (account?.onboardingState !== 'ready') return 'store_linked';

  const nativeOffer = await db
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        eq(offers.merchantId, merchantId),
        eq(offers.kind, 'native'),
        eq(offers.status, 'active'),
      ),
    )
    .limit(1);
  return nativeOffer.length === 0 ? 'payment_ready' : 'native_activated';
}

/** Project one candidate for the operator surface. */
export async function projectCandidate(
  row: AcquisitionCandidateWithMerchant,
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateView> {
  const [contactSources, outreach, conversionStage] = await Promise.all([
    listContactSources(row.candidate.id, db),
    listOutreach(row.candidate.id, db),
    deriveConversionStage(row.candidate.merchantId, db),
  ]);

  return {
    merchantId: row.candidate.merchantId,
    merchantName: row.merchantName,
    state: row.candidate.state,
    conversionStage,
    scoreBps: row.candidate.scoreBps,
    scoreVersion: row.candidate.scoreVersion,
    ...(row.candidate.scoredAt === null
      ? {}
      : { scoredAt: row.candidate.scoredAt.toISOString() }),
    contributingInputs: row.candidate.contributingInputs as MerchantAcquisitionScoreInput[],
    // Names only. Why each was unmeasurable is answered by the snapshot the
    // score cites, which carries a reason per metric — a reason copied onto the
    // candidate would be the copy that is wrong after the next rescore.
    unmeasuredInputs: row.candidate.unmeasuredInputs as MerchantAcquisitionScoreInput[],
    ...(row.candidate.assignedToOxyUserId === null
      ? {}
      : { assignedToOxyUserId: row.candidate.assignedToOxyUserId }),
    ...(row.candidate.nextAction === null ? {} : { nextAction: row.candidate.nextAction }),
    ...(row.candidate.nextActionDueAt === null
      ? {}
      : { nextActionDueAt: row.candidate.nextActionDueAt.toISOString() }),
    doNotContact: row.candidate.doNotContact,
    ...(row.candidate.exclusionReason === null
      ? {}
      : { exclusionReason: row.candidate.exclusionReason }),
    ...(row.candidate.excludedAt === null
      ? {}
      : { excludedAt: row.candidate.excludedAt.toISOString() }),
    contactSources: contactSources.map((source) => ({
      id: source.id,
      kind: source.kind,
      sourceUrl: source.sourceUrl,
      locatorNote: source.locatorNote,
      observedAt: source.observedAt.toISOString(),
      recordedByOxyUserId: source.recordedByOxyUserId,
    })),
    outreach: outreach.map((entry) => ({
      id: entry.id,
      channel: entry.channel,
      outcome: entry.outcome,
      occurredAt: entry.occurredAt.toISOString(),
      actorOxyUserId: entry.actorOxyUserId,
      ...(entry.contactSourceId === null ? {} : { contactSourceId: entry.contactSourceId }),
    })),
    ...(row.candidate.snapshotId === null ? {} : { snapshotId: row.candidate.snapshotId }),
  };
}

/** One page of the pipeline. */
export async function listPipeline(
  input: {
    readonly states?: readonly MerchantAcquisitionState[];
    readonly assignedToOxyUserId?: string;
    readonly limit: number;
    readonly offset: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly MerchantAcquisitionCandidateView[]> {
  const rows = await listAcquisitionCandidates(input, db);
  return Promise.all(rows.map((row) => projectCandidate(row, db)));
}

/** One candidate, or a 404. */
export async function readCandidate(
  merchantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateView> {
  const row = await findAcquisitionCandidate(merchantId, db);
  if (row === undefined) throw notFound('Candidate not found');
  return projectCandidate(row, db);
}

/** The context every write shares. */
interface ActionContext {
  readonly merchantId: string;
  readonly actorOxyUserId: string;
  readonly now?: Date;
}

/**
 * Run one operator action, auditing BOTH outcomes.
 *
 * A refusal is audited with a bounded `refusalCode` and no prose: an audit row
 * is not a place to write about a person, and a code is what a later query can
 * count.
 */
async function withAudit<T>(
  input: ActionContext & { readonly action: MerchantAcquisitionAction },
  run: (candidateId: string) => Promise<T>,
  db: DatabaseOrTransaction,
): Promise<T> {
  const now = input.now ?? new Date();
  const existing = await findAcquisitionCandidate(input.merchantId, db);
  if (existing === undefined) {
    await recordAcquisitionAudit(
      {
        merchantId: input.merchantId,
        action: input.action,
        outcome: 'refused',
        refusalCode: 'candidate_not_found',
        actorOxyUserId: input.actorOxyUserId,
        occurredAt: now,
      },
      db,
    );
    throw notFound('Candidate not found');
  }
  const result = await run(existing.candidate.id);
  await recordAcquisitionAudit(
    {
      merchantId: input.merchantId,
      action: input.action,
      outcome: 'granted',
      actorOxyUserId: input.actorOxyUserId,
      occurredAt: now,
    },
    db,
  );
  return result;
}

/**
 * Put a merchant into the pipeline. Idempotent; no audit, no decision.
 *
 * The merchant is checked to EXIST first rather than left to the foreign key:
 * an unknown id is a 404 about the merchant, and letting the constraint answer
 * it would make the same request a 500 about a database. Enrolment itself is
 * not a decision — a candidate row is a merchant's standing in a pipeline, and
 * reading one that has never been scored should show an empty pipeline rather
 * than 404 — so nothing here is audited.
 */
export async function enrolMerchant(
  merchantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const exists = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  if (exists.length === 0) throw notFound('Merchant not found');
  await ensureAcquisitionCandidate(merchantId, db);
}

/** Rescore a candidate against a freshly built snapshot. */
export async function rescoreCandidate(
  input: ActionContext & { readonly market: string; readonly windowDays: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateView> {
  return withAudit(
    { ...input, action: 'rescore' },
    async () => {
      const window = resolveWindow({
        merchantId: input.merchantId,
        market: input.market,
        windowDays: input.windowDays,
        refresh: true,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      const snapshot = await buildMerchantDemandSnapshot(
        {
          merchantId: input.merchantId,
          market: input.market,
          windowFrom: window.from,
          windowTo: window.to,
          now: window.now,
        },
        db,
      );
      const facts = await gatherMerchantDemandFacts(
        {
          merchantId: input.merchantId,
          market: input.market,
          windowFrom: window.from,
          windowTo: window.to,
          now: window.now,
        },
        db,
      );
      const score = scoreMerchantAcquisition(acquisitionFactsFrom(facts));
      await storeAcquisitionScore(
        {
          merchantId: input.merchantId,
          scoreBps: score.scoreBps,
          scoreVersion: MERCHANT_ACQUISITION_SCORE_VERSION,
          snapshotId: snapshot.snapshot.id,
          contributingInputs: score.contributingInputs,
          unmeasuredInputs: score.unmeasuredInputs.map((entry) => entry.input),
          scoredAt: window.now,
        },
        db,
      );
      return readCandidate(input.merchantId, db);
    },
    db,
  );
}

/** Assign, or clear an assignment. */
export async function assignCandidate(
  input: ActionContext & { readonly assignedToOxyUserId: string | null },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateView> {
  return withAudit(
    { ...input, action: 'assign' },
    async () => {
      await assignAcquisitionCandidate(
        { merchantId: input.merchantId, assignedToOxyUserId: input.assignedToOxyUserId },
        db,
      );
      return readCandidate(input.merchantId, db);
    },
    db,
  );
}

/** Set the next action and move the pipeline state with it. */
export async function setNextAction(
  input: ActionContext & {
    readonly state: MerchantAcquisitionState;
    readonly nextAction: string | null;
    readonly nextActionDueAt: Date | null;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateView> {
  return withAudit(
    { ...input, action: 'set_next_action' },
    async () => {
      await setAcquisitionNextAction(
        {
          merchantId: input.merchantId,
          state: input.state,
          nextAction: input.nextAction,
          nextActionDueAt: input.nextActionDueAt,
        },
        db,
      );
      return readCandidate(input.merchantId, db);
    },
    db,
  );
}

/** Exclude a candidate, attributably. */
export async function excludeCandidate(
  input: ActionContext & { readonly reason: MerchantAcquisitionExclusionReason },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateView> {
  return withAudit(
    { ...input, action: 'exclude' },
    async () => {
      await excludeAcquisitionCandidate(
        {
          merchantId: input.merchantId,
          reason: input.reason,
          actorOxyUserId: input.actorOxyUserId,
          at: input.now ?? new Date(),
        },
        db,
      );
      return readCandidate(input.merchantId, db);
    },
    db,
  );
}

/**
 * Lift an exclusion.
 *
 * REFUSED while `do_not_contact` is set. Clearing that is a separate, separately
 * audited action, because a merchant that asked not to be contacted has not
 * withdrawn the request because an operator changed their mind about something
 * else.
 */
export async function clearExclusion(
  input: ActionContext,
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateView> {
  const now = input.now ?? new Date();
  const existing = await findAcquisitionCandidate(input.merchantId, db);
  if (existing !== undefined && existing.candidate.doNotContact) {
    await recordAcquisitionAudit(
      {
        merchantId: input.merchantId,
        action: 'clear_exclusion',
        outcome: 'refused',
        refusalCode: 'do_not_contact_is_set',
        actorOxyUserId: input.actorOxyUserId,
        occurredAt: now,
      },
      db,
    );
    throw notFound('Candidate not found');
  }
  return withAudit(
    { ...input, action: 'clear_exclusion' },
    async () => {
      await clearAcquisitionExclusion({ merchantId: input.merchantId }, db);
      return readCandidate(input.merchantId, db);
    },
    db,
  );
}

/** Record or withdraw a do-not-contact request. */
export async function setDoNotContact(
  input: ActionContext & { readonly doNotContact: boolean },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateView> {
  return withAudit(
    { ...input, action: 'set_do_not_contact' },
    async () => {
      await setAcquisitionDoNotContact(
        {
          merchantId: input.merchantId,
          doNotContact: input.doNotContact,
          actorOxyUserId: input.actorOxyUserId,
          at: input.now ?? new Date(),
        },
        db,
      );
      return readCandidate(input.merchantId, db);
    },
    db,
  );
}

/** Record where a public business contact is published. */
export async function addContactSource(
  input: ActionContext & {
    readonly kind: MerchantAcquisitionContactSourceKind;
    readonly sourceUrl: string;
    readonly locatorNote: string;
    readonly observedAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateView> {
  return withAudit(
    { ...input, action: 'record_contact_source' },
    async (candidateId) => {
      await recordContactSource(
        {
          candidateId,
          kind: input.kind,
          sourceUrl: input.sourceUrl,
          locatorNote: input.locatorNote,
          observedAt: input.observedAt,
          recordedByOxyUserId: input.actorOxyUserId,
        },
        db,
      );
      return readCandidate(input.merchantId, db);
    },
    db,
  );
}

/**
 * Record one outreach attempt.
 *
 * REFUSED while `do_not_contact` is set. This is the one gate that has to be a
 * refusal rather than a filter: the row is the record that somebody contacted a
 * merchant, and accepting it after a do-not-contact request would record the
 * thing the flag exists to prevent while looking like compliance.
 */
export async function logOutreach(
  input: ActionContext & {
    readonly channel: MerchantAcquisitionOutreachChannel;
    readonly outcome: MerchantAcquisitionOutreachOutcome;
    readonly occurredAt: Date;
    readonly contactSourceId?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateView> {
  const now = input.now ?? new Date();
  const existing = await findAcquisitionCandidate(input.merchantId, db);
  if (existing !== undefined && existing.candidate.doNotContact) {
    await recordAcquisitionAudit(
      {
        merchantId: input.merchantId,
        action: 'record_outreach',
        outcome: 'refused',
        refusalCode: 'do_not_contact_is_set',
        actorOxyUserId: input.actorOxyUserId,
        occurredAt: now,
      },
      db,
    );
    throw notFound('Candidate not found');
  }
  return withAudit(
    { ...input, action: 'record_outreach' },
    async (candidateId) => {
      await recordOutreach(
        {
          candidateId,
          channel: input.channel,
          outcome: input.outcome,
          occurredAt: input.occurredAt,
          actorOxyUserId: input.actorOxyUserId,
          ...(input.contactSourceId === undefined
            ? {}
            : { contactSourceId: input.contactSourceId }),
        },
        db,
      );
      return readCandidate(input.merchantId, db);
    },
    db,
  );
}
