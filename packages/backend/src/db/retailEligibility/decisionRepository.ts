/**
 * Recorded eligibility decisions and the append-only audit trail (#121
 * acceptance 7, operations 3 and 5–7).
 *
 * ## A recorded decision is never an authority
 *
 * Nothing reads a row here to decide whether something is eligible — the
 * verdict is re-derived every time it is asked for, which is what makes an
 * expiry and a recall bite with no sweep having run. What the rows are FOR is
 * the operator trace, the re-evaluation sweep, the eligible-catalogue
 * measurement and the alert on a checkout blocked by an eligibility that moved.
 * The relationship is `payment_discrepancies`' to a payment: a durable
 * observation, not a cached truth.
 *
 * `services/retail-eligibility/eligibility.ts` does not import this module, and
 * `retail-eligibility-isolation.test.ts` fails the build if it starts to.
 *
 * ## A decision that cannot cite a policy version is not recorded at all
 *
 * {@link recordRetailEligibilityDecision} refuses one, before issuing SQL and
 * regardless of what the composite foreign key would do — because the answer
 * "there is no active policy" is reproducible from nothing and a record of it
 * would be evidence of nothing. The derivation still ANSWERS (`unknown`,
 * `policy_missing`); it is only the durable record that is withheld.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type {
  AgreementChannel,
  CurrencyCode,
  RetailCustomerType,
  RetailEligibilityAction,
  RetailEligibilityAuditAction,
  RetailEligibilityReason,
  RetailEligibilityVerdict,
  RetailFulfilmentMethod,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  retailEligibilityAudits,
  retailEligibilityDecisions,
} from '../schema/retailEligibility.js';

/** One decision row, whole. */
export type RetailEligibilityDecisionRecord = typeof retailEligibilityDecisions.$inferSelect;
/** One audit row, whole. */
export type RetailEligibilityAuditRecord = typeof retailEligibilityAudits.$inferSelect;

/** Where an eligibility question came from. A closed set, CHECKed in the column. */
export type RetailEligibilitySurface = 'publication' | 'checkout' | 'sweep' | 'operator';

/** What one recorded decision states. */
export interface NewRetailEligibilityDecision {
  policyId: string;
  policyKey: string;
  policyVersion: number;
  procurementOfferId: string;
  supplierId: string;
  canonicalVariantId: string | null;
  destinationCountry: string;
  fulfilmentOriginCountry: string | null;
  channel: AgreementChannel;
  currency: CurrencyCode;
  quantity: number;
  fulfilmentMethod: RetailFulfilmentMethod;
  customerType: RetailCustomerType;
  verdict: RetailEligibilityVerdict;
  reasons: RetailEligibilityReason[];
  nextRequiredAction: RetailEligibilityAction;
  resaleEvidenceIds: string[];
  complianceEvidenceIds: string[];
  exceptionId: string | null;
  contentHash: string;
  evaluatedAt: Date;
  surface: RetailEligibilitySurface;
}

/**
 * Record one answer. Append-only by trigger — a verdict is re-derived, never
 * edited.
 */
export async function recordRetailEligibilityDecision(
  db: DatabaseOrTransaction,
  input: NewRetailEligibilityDecision,
): Promise<RetailEligibilityDecisionRecord> {
  const [row] = await db
    .insert(retailEligibilityDecisions)
    .values({
      policyId: input.policyId,
      policyKey: input.policyKey,
      policyVersion: input.policyVersion,
      procurementOfferId: input.procurementOfferId,
      supplierId: input.supplierId,
      canonicalVariantId: input.canonicalVariantId,
      destinationCountry: input.destinationCountry.toUpperCase(),
      fulfilmentOriginCountry: input.fulfilmentOriginCountry?.toUpperCase() ?? null,
      channel: input.channel,
      currency: input.currency,
      quantity: input.quantity,
      fulfilmentMethod: input.fulfilmentMethod,
      customerType: input.customerType,
      verdict: input.verdict,
      reasons: input.reasons,
      nextRequiredAction: input.nextRequiredAction,
      resaleEvidenceIds: input.resaleEvidenceIds,
      complianceEvidenceIds: input.complianceEvidenceIds,
      exceptionId: input.exceptionId,
      contentHash: input.contentHash,
      evaluatedAt: input.evaluatedAt,
      surface: input.surface,
    })
    .returning();
  if (!row) throw new Error('recordRetailEligibilityDecision returned no row');
  return row;
}

/** The most recent decisions for one offer, newest first — the operator trace. */
export async function listRetailEligibilityDecisionsForOffer(
  db: DatabaseOrTransaction,
  input: { procurementOfferId: string; limit?: number },
): Promise<RetailEligibilityDecisionRecord[]> {
  return await db
    .select()
    .from(retailEligibilityDecisions)
    .where(eq(retailEligibilityDecisions.procurementOfferId, input.procurementOfferId))
    .orderBy(desc(retailEligibilityDecisions.evaluatedAt))
    .limit(input.limit ?? 50);
}

/**
 * The eligible-catalogue measurement (#121 operations 6): the LATEST decision
 * per offer inside a window, counted by verdict.
 *
 * `DISTINCT ON` rather than a group over every row, because an offer evaluated
 * forty times in an hour is one offer, and counting the rows would report the
 * traffic rather than the catalogue.
 */
export async function measureRetailEligibility(
  db: DatabaseOrTransaction,
  input: { since: Date; supplierId?: string },
): Promise<{ verdict: RetailEligibilityVerdict; offers: number }[]> {
  const rows = await db.execute<{ verdict: RetailEligibilityVerdict; offers: number }>(sql`
    select latest.verdict, count(*)::int as offers
    from (
      select distinct on (d.procurement_offer_id, d.destination_country)
             d.procurement_offer_id, d.destination_country, d.verdict
      from ${retailEligibilityDecisions} d
      where d.evaluated_at >= ${input.since.toISOString()}::timestamptz
        ${input.supplierId ? sql`and d.supplier_id = ${input.supplierId}` : sql``}
      order by d.procurement_offer_id, d.destination_country, d.evaluated_at desc
    ) latest
    group by latest.verdict
    order by latest.verdict
  `);
  return [...rows];
}

/**
 * Decisions that BLOCKED a checkout attempt in a window (#121 operations 7).
 *
 * Scoped to `surface = 'checkout'` on purpose: a publication check answering
 * `unknown` for a product nobody tried to buy is ordinary, while a buyer being
 * turned away at checkout is the event worth alerting on.
 */
export async function listBlockedCheckoutDecisions(
  db: DatabaseOrTransaction,
  input: { since: Date; limit?: number },
): Promise<RetailEligibilityDecisionRecord[]> {
  return await db
    .select()
    .from(retailEligibilityDecisions)
    .where(
      and(
        eq(retailEligibilityDecisions.surface, 'checkout'),
        gte(retailEligibilityDecisions.evaluatedAt, input.since),
        sql`${retailEligibilityDecisions.verdict} <> 'eligible'`,
      ),
    )
    .orderBy(desc(retailEligibilityDecisions.evaluatedAt))
    .limit(input.limit ?? 100);
}

/* ------------------------------------------------------------------------- *
 * The audit trail
 * ------------------------------------------------------------------------- */

/** What one audited act records. */
export interface NewRetailEligibilityAudit {
  action: RetailEligibilityAuditAction;
  subjectTable: string;
  subjectId: string;
  /** Whether the attempt was carried out or refused. BOTH are recorded. */
  outcome: 'applied' | 'refused';
  reason: string;
  actorOxyUserId: string;
  detail?: string;
  at?: Date;
}

/**
 * Append one audited act — the `payment_repairs` shape: one row per ATTEMPT,
 * refusals included, with a mandatory actor and reason.
 *
 * Recording a REFUSAL is the half that is easy to skip and is the half an
 * incident actually asks about: "who tried to verify this document and was told
 * no" has no answer in a table that only records successes.
 */
export async function appendRetailEligibilityAudit(
  db: DatabaseOrTransaction,
  input: NewRetailEligibilityAudit,
): Promise<RetailEligibilityAuditRecord> {
  const [row] = await db
    .insert(retailEligibilityAudits)
    .values({
      action: input.action,
      subjectTable: input.subjectTable,
      subjectId: input.subjectId,
      outcome: input.outcome,
      reason: input.reason,
      actorOxyUserId: input.actorOxyUserId,
      detail: input.detail ?? null,
      at: input.at ?? new Date(),
    })
    .returning();
  if (!row) throw new Error('appendRetailEligibilityAudit returned no row');
  return row;
}

/** Every audited act about one subject, newest first. */
export async function listRetailEligibilityAudits(
  db: DatabaseOrTransaction,
  filter: { subjectTable?: string; subjectId?: string; limit?: number },
): Promise<RetailEligibilityAuditRecord[]> {
  const predicates = [
    ...(filter.subjectTable ? [eq(retailEligibilityAudits.subjectTable, filter.subjectTable)] : []),
    ...(filter.subjectId ? [eq(retailEligibilityAudits.subjectId, filter.subjectId)] : []),
  ];
  const query = db.select().from(retailEligibilityAudits);
  const rows =
    predicates.length > 0
      ? await query
          .where(and(...predicates))
          .orderBy(desc(retailEligibilityAudits.at))
          .limit(filter.limit ?? 100)
      : await query.orderBy(desc(retailEligibilityAudits.at)).limit(filter.limit ?? 100);
  return rows;
}
