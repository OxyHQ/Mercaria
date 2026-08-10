/**
 * Zero-profit cost reconciliation for `mercaria_retail` (#128, ADR 0004
 * D7/D8): ten tables that make every retail order explainable from the customer
 * charge to the supplier invoice, and make "the planned margin is zero" a
 * property of the database.
 *
 * #120 composes a cost-only amount and classifies a difference; #123 observes an
 * actual and writes it down; #124 records what a supplier billed. This is where
 * all of it is gathered, the equation is evaluated once per revision, and the
 * answer is BOOKED through the ledger's single writer.
 *
 * ## The boundaries this file exists to hold
 *
 * **There is no margin, profit or markup column, and none may be added.**
 * `retail_reconciliation_components.component` is CHECKed against
 * `RETAIL_ACCOUNTING_COMPONENTS` — the twelve #128 requires — and
 * `RETAIL_FORBIDDEN_ACCOUNTING_COMPONENTS` is a DISJOINT union no column
 * accepts, so a `retail_margin_revenue` row fails the WRITE rather than being
 * caught by review. The two tuples' disjointness, the absence of a
 * margin-shaped column in any of these ten tables, and the refusal that names
 * a forbidden component BY NAME are three independent walls, each tested.
 *
 * **A missing cost is never a zero cost.** `completeness` is two-valued and
 * `outcome` is present EXACTLY when it is `complete` — a biconditional CHECK —
 * so a reconciliation that could not find the supplier invoice has no verdict at
 * all rather than a confident one built on an assumed zero. Every blocking
 * exception kind is a term of the equation with no evidence behind it.
 *
 * **Historical truth is never revalued.** Every amount is stored in the
 * currency the SOURCE stated it in, beside its conversion into the accounting
 * currency and the five-column `FxRateSnapshot` that produced it — the
 * `retail_cost_quote_components` shape, for the same reason. A conversion that
 * cannot be made from a STORED rate is `currency_unconvertible`, an exception,
 * never a fresh call to `fx.service`.
 *
 * **Nothing here is mutable that records what happened.**
 * `retail_reconciliations`, its components, its evidence, the supplier credits
 * and the operator audit are append-only by TRIGGER (against UPDATE and
 * DELETE). A correction is a new REVISION, exactly as a ledger correction is a
 * new reversing transaction. The two tables that are mutable —
 * `retail_customer_adjustments` and `retail_reconciliation_exceptions` — carry
 * state machines about work still in progress, and neither is a record of a
 * movement.
 *
 * **Finality is DERIVED and has no column.** ADR 0004 D8.6 defines it as the
 * latest of three live conditions bounded at 180 days; a stored
 * `finalised_at` beside them would be the second representation of one fact
 * that `deriveNativeCheckoutEligibility` exists as a precedent against, and the
 * place they must not disagree is the decision to stop owing a buyer money.
 *
 * ## What is deliberately absent
 *
 * - **No `finalised_at`, no `is_final`.** See above.
 * - **No `reconciled` flag on `purchase_orders`.** #124 already carries
 *   `reconciled_at` and states that #128 books what a document means; a second
 *   flag here would be two answers to one question.
 * - **No tax-liability account or column beyond the COMPONENT.** Representing
 *   the tax separately is what #128 asks for; deciding where destination VAT
 *   sits in Mercaria's chart of accounts is an OSS-reporting decision with its
 *   own owner, and inventing an account for it here would put a number nobody
 *   has agreed into the books.
 * - **No buyer identity anywhere.** An adjustment names its ORDER. A guest
 *   buyer's credential is purged on its own clock while these rows are
 *   retained, and a per-buyer handle in a permanent financial record is a
 *   correlation key wearing an owner id (#106 identity rule 11).
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  ALL_CURRENCY_CODES,
  RETAIL_ACCOUNTING_COMPONENTS,
  RETAIL_ADJUSTMENT_BLOCK_REASONS,
  RETAIL_ADJUSTMENT_FINALITY_DISPOSITIONS,
  RETAIL_ADJUSTMENT_MAX_AUTOMATION_FLOOR_MINOR,
  RETAIL_ADJUSTMENT_METHODS,
  RETAIL_ADJUSTMENT_STATES,
  RETAIL_LEDGER_RECOGNITION_KINDS,
  RETAIL_RECONCILIATION_COMPLETENESS_STATES,
  RETAIL_RECONCILIATION_EVIDENCE_KINDS,
  RETAIL_RECONCILIATION_EXCEPTION_KINDS,
  RETAIL_RECONCILIATION_FINALITY_CEILING_DAYS,
  RETAIL_RECONCILIATION_MAX_TOLERANCE_MINOR,
  RETAIL_RECONCILIATION_OPERATOR_ACTIONS,
  RETAIL_RECONCILIATION_OPERATOR_OUTCOMES,
  RETAIL_RECONCILIATION_OUTCOMES,
  RETAIL_RECONCILIATION_POLICY_STATUSES,
  RETAIL_SUPPLIER_CREDIT_CLASSIFICATIONS,
  type CurrencyCode,
} from '@mercaria/shared-types';
import {
  asEnumValues,
  checkOneOf,
  currencyChecks,
  CURRENCY_CODE_VALUES,
  money,
  optionalMoney,
} from './columns';
import { ledgerTransactions } from './ledger';
import { orders, refunds } from './orders';
import { purchaseOrders, suppliers } from './procurement';
import { supplierRecoveries } from './retailServiceRequests';

/** Bound on any stored note, reason or reference — the `.slice()` at every writer. */
const MAX_NOTE_LENGTH = 2_000;

/**
 * The `WHEN … THEN … ELSE` body of a `CASE <currency>` rendering one
 * per-currency integer ceiling.
 *
 * The currency-awareness of the tolerance, expressed where it has to hold: in
 * the database, against `psql` and a backfill as well as against the service.
 *
 * `else -1` is not decoration. A CASE with no matching branch yields NULL, a
 * comparison against NULL is NULL, and **a CHECK rejects only FALSE** — so the
 * obvious spelling would SATISFY the constraint for exactly the currency it
 * failed to cover, which is the `array_length` trap wearing different clothes.
 * The map is a `Record<CurrencyCode, number>`, so the compiler already
 * guarantees every branch exists; `-1` is what makes the failure loud rather
 * than permissive if that ever stops being true.
 */
function currencyCeilingCase(ceilings: Readonly<Record<CurrencyCode, number>>): string {
  const branches = ALL_CURRENCY_CODES.map(
    (code) => `when '${code}' then ${String(ceilings[code])}`,
  ).join(' ');
  return `${branches} else -1`;
}

/* -------------------------------------------------------------------------- */
/*  The versioned policy                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `retail_reconciliation_policies` — one immutable VERSION of the
 * reconciliation policy: the tolerances, the automation floor, the alerting
 * thresholds and what happens to an uncollected adjustment at finality.
 *
 * The `fee_schedules` / `retail_pricing_policies` shape, and for the same
 * reason: a policy change is a NEW version, never an edit, because orders were
 * reconciled under the old one and a mutable version would silently restate
 * what they were reconciled against. A trigger enforces it and a partial unique
 * index holds at most one `active` version per key.
 *
 * ## The columns that exist, and the ones that must never
 *
 * There is no margin target, no profit floor, no retention rate and no
 * "unclaimed adjustment" horizon. `absorbed_variance_alert_bps` is the domain's
 * only basis-point column and it decides when somebody is TOLD about a loss; it
 * can neither create a charge nor keep a surplus.
 *
 * `sub_threshold_disposition` is the one that looks like it should have a third
 * option and must not: `refund_remaining` or `keep_open`, with nothing meaning
 * "retain". An adjustment Mercaria kept at finality would be the profit bucket
 * ADR 0004 D7 leaves no account for, so the value that would express it has no
 * representation — see `RETAIL_ADJUSTMENT_FINALITY_DISPOSITIONS`.
 */
export const retailReconciliationPolicies = pgTable(
  'retail_reconciliation_policies',
  {
    id: generatedId(),
    /** The stable logical id shared by every version (`mercaria-retail-reconciliation`). */
    policyKey: text().notNull(),
    /** Monotonic per key, assigned by the operator creating the draft. */
    version: integer().notNull(),
    name: text().notNull(),
    /** The operator-facing statement of what this version decides and why. */
    summary: text().notNull(),
    status: text({ enum: asEnumValues(RETAIL_RECONCILIATION_POLICY_STATUSES) })
      .notNull()
      .default('draft'),
    /** The policy applies only inside `[effective_start, effective_end)`. */
    effectiveStart: timestamptz().notNull(),
    /** NULL = open-ended. */
    effectiveEnd: timestamptz(),
    /**
     * When Mercaria absorbing a shortfall is loud enough to alert on: the
     * GREATER of this share of the locked customer amount and the floor below,
     * the `absorption_cap_bps` + `absorption_cap_floor` pairing #120 already
     * uses. Two bounds because a percentage alone is silent on a small order and
     * a fixed amount alone is silent on a large one.
     */
    absorbedVarianceAlertBps: integer().notNull().default(500),
    ...money('absorbedVarianceAlertFloor'),
    /**
     * How many absorbed-variance alerts on one supplier, inside
     * `recurring_variance_window_hours`, mean the cost model has stopped being
     * reliable — #128 negative-variance rules 4 and 5. Crossing it feeds #125's
     * stop-threshold evaluation, which is what pauses entry.
     */
    recurringVarianceCount: integer().notNull().default(3),
    recurringVarianceWindowHours: integer().notNull().default(168),
    /** ADR 0004 D8.6's operational ceiling, measured from delivery. */
    finalityCeilingDays: integer()
      .notNull()
      .default(RETAIL_RECONCILIATION_FINALITY_CEILING_DAYS),
    /** What becomes of an adjustment the buyer never received. Two options; see above. */
    subThresholdDisposition: text({ enum: asEnumValues(RETAIL_ADJUSTMENT_FINALITY_DISPOSITIONS) })
      .notNull()
      .default('refund_remaining'),
    /** The operator who drafted it — an Oxy account id, no foreign key. */
    createdByOxyUserId: text().notNull(),
    /** The operator who activated it — the audit half of "publish a new version". */
    approvedByOxyUserId: text(),
    activatedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'retail_reconciliation_policies_status_check',
      t.status,
      RETAIL_RECONCILIATION_POLICY_STATUSES,
    ),
    checkOneOf(
      'retail_reconciliation_policies_disposition_check',
      t.subThresholdDisposition,
      RETAIL_ADJUSTMENT_FINALITY_DISPOSITIONS,
    ),
    ...currencyChecks('retail_reconciliation_policies', [t.absorbedVarianceAlertFloorCurrency]),
    check('retail_reconciliation_policies_version_check', sql`${t.version} >= 1`),
    check(
      'retail_reconciliation_policies_key_check',
      sql`${t.policyKey} ~ '^[a-z0-9][a-z0-9-]{1,63}$'`,
    ),
    check(
      'retail_reconciliation_policies_alert_check',
      sql`${t.absorbedVarianceAlertBps} between 1 and 10000
          and ${t.absorbedVarianceAlertFloorAmount} >= 0`,
    ),
    check(
      'retail_reconciliation_policies_recurrence_check',
      sql`${t.recurringVarianceCount} >= 1 and ${t.recurringVarianceWindowHours} >= 1`,
    ),
    // The ceiling is bounded by ADR 0004 D8.6's own figure: a version may close
    // reconciliation SOONER than 180 days after delivery and may never leave a
    // buyer's money in an open obligation for longer.
    check(
      'retail_reconciliation_policies_finality_check',
      sql`${t.finalityCeilingDays} between 1 and ${sql.raw(String(RETAIL_RECONCILIATION_FINALITY_CEILING_DAYS))}`,
    ),
    check(
      'retail_reconciliation_policies_summary_check',
      sql`length(btrim(${t.summary})) between 1 and ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    check(
      'retail_reconciliation_policies_effective_window_check',
      sql`${t.effectiveEnd} is null or ${t.effectiveEnd} > ${t.effectiveStart}`,
    ),
    // Nothing published is anonymous — the `fee_schedules` activation audit.
    check(
      'retail_reconciliation_policies_activation_audit_check',
      sql`${t.status} not in ('active', 'superseded')
          or (${t.approvedByOxyUserId} is not null and ${t.activatedAt} is not null)`,
    ),
    uniqueIndex('retail_reconciliation_policies_key_version_key').on(t.policyKey, t.version),
    uniqueIndex('retail_reconciliation_policies_one_active_per_key')
      .on(t.policyKey)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * `retail_reconciliation_tolerances` — the tiny, CURRENCY-AWARE tolerance and
 * automation floor, one row per currency of one policy version.
 *
 * A child table rather than a single number on the policy, because a bare
 * integer means five hundredths of a euro and five hundred-millionths of a FAIR
 * — the same value describing two unrelated quantities, with the FAIR reading so
 * small that every conversion residue would be reported as material variance and
 * the EUR reading so large in JPY (which has no minor unit at all) that five yen
 * of real difference would vanish.
 *
 * The ceiling is a CHECK rendered from
 * {@link RETAIL_RECONCILIATION_MAX_TOLERANCE_MINOR}, per currency, so widening
 * the tolerance into a place to keep material variance is a schema change under
 * review rather than a configuration an operator can make — the structural half
 * of #120's `RETAIL_MAX_ROUNDING_TOLERANCE_MINOR`, at the stage where the money
 * would actually be kept.
 *
 * The AUTOMATION floor is a different number and is deliberately not bounded the
 * same way: it decides when Mercaria calls the rail without being asked (ADR
 * 0004 D8.2's 1.00 EUR equivalent), and a sub-floor surplus is still recorded,
 * still owed and still refundable on request. It bounds automation, never
 * classification, so it may legitimately be large.
 */
export const retailReconciliationTolerances = pgTable(
  'retail_reconciliation_tolerances',
  {
    id: generatedId(),
    policyId: text()
      .notNull()
      .references(() => retailReconciliationPolicies.id, { onDelete: 'cascade' }),
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** At or below this, a difference is rounding. Bounded per currency; see above. */
    toleranceMinor: bigint({ mode: 'number' }).notNull(),
    /** At or above this, a surplus is refunded without anyone asking. */
    automationFloorMinor: bigint({ mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    ...currencyChecks('retail_reconciliation_tolerances', [t.currency]),
    check(
      'retail_reconciliation_tolerances_bound_check',
      sql`${t.toleranceMinor} between 0 and (case ${t.currency} ${sql.raw(
        currencyCeilingCase(RETAIL_RECONCILIATION_MAX_TOLERANCE_MINOR),
      )} end)`,
    ),
    // The automation floor is at least the tolerance: a floor BELOW it would
    // promise an automatic refund for a difference the same policy has already
    // classified as rounding, which is two answers to one question.
    check(
      'retail_reconciliation_tolerances_floor_check',
      sql`${t.automationFloorMinor} >= ${t.toleranceMinor}
          and ${t.automationFloorMinor} <= (case ${t.currency} ${sql.raw(
            currencyCeilingCase(RETAIL_ADJUSTMENT_MAX_AUTOMATION_FLOOR_MINOR),
          )} end)`,
    ),
    uniqueIndex('retail_reconciliation_tolerances_policy_currency_key').on(t.policyId, t.currency),
  ],
);

/* -------------------------------------------------------------------------- */
/*  The reconciliation itself                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `retail_reconciliations` — one evaluation of the zero-profit equation for one
 * retail order, at one revision. Append-only by trigger.
 *
 * ## Why a REVISION rather than a mutable row
 *
 * Evidence arrives over weeks: the supplier accepts, then invoices, then a
 * credit note lands, then a return resolves. Each of those changes the answer,
 * and a mutable row would overwrite the answer a customer adjustment was created
 * under — leaving an obligation whose justification no longer exists anywhere.
 * A revision is the ledger's own correction rule applied one layer up: the new
 * one supersedes, and both are readable.
 *
 * `UNIQUE(order_id, revision)` and a monotonic revision are what make a
 * re-run under UNCHANGED evidence converge rather than accumulate: the service
 * computes, compares against the latest revision's `evidence_digest`, and writes
 * nothing when they match. The digest is over the evidence, not over a clock, so
 * two runs a week apart on one unchanged order produce one row.
 *
 * ## The verdict is present exactly when the evidence is complete
 *
 * `retail_reconciliations_outcome_shape_check` is a biconditional, so an
 * incomplete reconciliation has NO outcome. #128 acceptance 7 — missing
 * evidence creates an operator exception instead of a fabricated zero cost — is
 * that CHECK plus the exceptions raised beside it, rather than a convention
 * about what a service should do with an absent number.
 *
 * ## The signed variance, and the sign it must have
 *
 * `cost_variance_minor = customer_amount_before_subsidy − final_attributable_cost`,
 * verbatim from #128's equation, and the CHECK re-computes it. Its SIGN and the
 * outcome are a biconditional per branch, so a `customer_adjustment_required`
 * row whose cost EXCEEDED the customer amount — a surcharge wearing a refund's
 * name — is unrepresentable, exactly as #123's variance record already makes it.
 */
export const retailReconciliations = pgTable(
  'retail_reconciliations',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** Monotonic per order, starting at 1. */
    revision: integer().notNull(),
    /** The policy VERSION this evaluation was made under — its terms, by reference. */
    policyId: text()
      .notNull()
      .references(() => retailReconciliationPolicies.id, { onDelete: 'restrict' }),
    /** Snapshot names beside the pointer — the `order_fee_snapshots` rule. */
    policyKey: text().notNull(),
    policyVersion: integer().notNull(),
    completeness: text({ enum: asEnumValues(RETAIL_RECONCILIATION_COMPLETENESS_STATES) }).notNull(),
    /** Present EXACTLY when `completeness` is `complete`. */
    outcome: text({ enum: asEnumValues(RETAIL_RECONCILIATION_OUTCOMES) }),
    /** Every amount below is in ONE currency: the order's accounting currency. */
    accountingCurrency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** #128's equation, left-hand side: what the buyer paid PLUS what Mercaria subsidised. */
    customerAmountBeforeSubsidyMinor: bigint({ mode: 'number' }).notNull(),
    /** #128's equation, right-hand side: the four cost terms, net of supplier credits. */
    finalAttributableCostMinor: bigint({ mode: 'number' }).notNull(),
    /** The subtraction. Signed; positive means the buyer paid more than it cost. */
    costVarianceMinor: bigint({ mode: 'number' }).notNull(),
    /** The tolerance this classification was made against, from the policy version. */
    toleranceMinor: bigint({ mode: 'number' }).notNull(),
    /**
     * A sha-256 over the evidence this revision consumed, canonically serialized.
     *
     * The convergence key: a re-run whose digest matches the latest revision
     * writes nothing. It is over the EVIDENCE and never over the computation's
     * clock, because a digest that moved with time would make every sweep pass
     * produce a revision and every order accumulate one per tick.
     */
    evidenceDigest: text().notNull(),
    computedAt: timestamptz().notNull(),
    /** No `updated_at` — the ABSENCE is the append-only contract. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_reconciliations_completeness_check',
      t.completeness,
      RETAIL_RECONCILIATION_COMPLETENESS_STATES,
    ),
    checkOneOf('retail_reconciliations_outcome_check', t.outcome, RETAIL_RECONCILIATION_OUTCOMES),
    ...currencyChecks('retail_reconciliations', [t.accountingCurrency]),
    check('retail_reconciliations_revision_check', sql`${t.revision} >= 1`),
    check(
      'retail_reconciliations_digest_check',
      sql`${t.evidenceDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'retail_reconciliations_amounts_check',
      sql`${t.customerAmountBeforeSubsidyMinor} >= 0
          and ${t.finalAttributableCostMinor} >= 0
          and ${t.toleranceMinor} >= 0`,
    ),
    // An incomplete reconciliation has NO verdict. See the docblock.
    check(
      'retail_reconciliations_outcome_shape_check',
      sql`(${t.completeness} = 'complete') = (${t.outcome} is not null)`,
    ),
    /**
     * The variance IS the subtraction, and its sign IS the outcome — one CHECK,
     * because the facts are one fact. Written as a biconditional per branch so
     * neither half can drift, the `retail_cost_variance_records` device.
     *
     * Every branch is written as `(outcome = 'x') = (<the condition>)`, in full
     * parentheses. The obvious shorter spelling — `outcome <> 'x' or <cond>` —
     * only constrains ONE direction, so a row could carry
     * `mercaria_absorbed` with a positive variance as long as it also failed to
     * be `customer_adjustment_required`, which is a surcharge wearing a refund's
     * name. And SQL binds `AND` tighter than `OR`, so a chain of those without
     * parentheses does not even mean what it reads as.
     *
     * `within_rounding_tolerance` is NOT pinned to a sign: a difference in
     * either direction inside the tolerance lands there, and that is the whole
     * distinction from `cost_recovered_exactly`, which is pinned to exactly
     * zero. The four conditions are mutually exclusive and exhaustive over the
     * integers, so the four biconditionals cannot all be satisfied by more than
     * one outcome.
     */
    check(
      'retail_reconciliations_variance_check',
      sql`${t.costVarianceMinor}
            = ${t.customerAmountBeforeSubsidyMinor} - ${t.finalAttributableCostMinor}
          and (${t.outcome} is null
               or (
                 ((${t.outcome} = 'cost_recovered_exactly') = (${t.costVarianceMinor} = 0))
                 and ((${t.outcome} = 'customer_adjustment_required')
                      = (${t.costVarianceMinor} > ${t.toleranceMinor}))
                 and ((${t.outcome} = 'mercaria_absorbed')
                      = (${t.costVarianceMinor} < -${t.toleranceMinor}))
                 and ((${t.outcome} = 'within_rounding_tolerance')
                      = (abs(${t.costVarianceMinor}) <= ${t.toleranceMinor}
                         and ${t.costVarianceMinor} <> 0))
               ))`,
    ),
    uniqueIndex('retail_reconciliations_order_revision_key').on(t.orderId, t.revision),
    index('retail_reconciliations_order_computed_idx').on(t.orderId, t.computedAt.desc()),
    index('retail_reconciliations_outcome_idx').on(t.outcome, t.computedAt.desc()),
    index('retail_reconciliations_completeness_idx')
      .on(t.completeness, t.computedAt.desc())
      .where(sql`${t.completeness} = 'missing_evidence'`),
  ],
);

/**
 * `retail_reconciliation_components` — the TWELVE separately represented
 * accounting components of one revision, each in the order's applicable
 * currencies. Append-only with its parent.
 *
 * ## Separately is the whole point
 *
 * #128's accounting model lists twelve and requires them represented
 * separately. Folding supplier handling into the item cost, or the provider fee
 * into "other", destroys the only thing that makes a variance explicable: which
 * evidence disagreed. `UNIQUE(reconciliation_id, component)` keeps them apart
 * and keeps each one summed once.
 *
 * ## The amount is a MAGNITUDE and the component carries the sign
 *
 * Every stored amount is non-negative, and which side of the equation a
 * component enters is `RETAIL_COMPONENT_ROLES` — a property of the component's
 * meaning rather than of the number somebody recorded. A signed column would let
 * one writer record a supplier credit as a negative cost and another as a
 * positive recovery, and both would balance while meaning opposite things.
 *
 * ## The conversion is stored, never recomputed
 *
 * `source_*` is the currency the evidence stated, `accounting_*` is the
 * reconciliation's own currency, and the five `fx_rate_*` columns are the exact
 * `FxRateSnapshot` between them — present EXACTLY when the currencies differ, a
 * biconditional, and naming the pair they converted. That is #128's multi-
 * currency rules 1–3 as a row shape: a later rate move can never alter a stored
 * amount, because the amount carries the rate that produced it.
 */
export const retailReconciliationComponents = pgTable(
  'retail_reconciliation_components',
  {
    id: generatedId(),
    reconciliationId: text()
      .notNull()
      .references(() => retailReconciliations.id, { onDelete: 'restrict' }),
    component: text({ enum: asEnumValues(RETAIL_ACCOUNTING_COMPONENTS) }).notNull(),
    /** The amount as the SOURCE stated it, in the source's own currency. */
    ...money('source'),
    /** The same amount in the reconciliation's accounting currency. */
    ...money('accounting'),
    // The exact conversion — the `retail_cost_quote_components` shape.
    fxRateFrom: text({ enum: CURRENCY_CODE_VALUES }),
    fxRateTo: text({ enum: CURRENCY_CODE_VALUES }),
    fxRateRate: doublePrecision(),
    fxRateProvider: text(),
    /** An ISO-8601 instant as TEXT — `FxRateSnapshot.asOf` is declared `string`. */
    fxRateAsOf: text(),
    /** How many evidence records were summed into this figure. */
    evidenceCount: integer().notNull().default(0),
    /** No `updated_at` — the row is append-only with its reconciliation. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_reconciliation_components_component_check',
      t.component,
      RETAIL_ACCOUNTING_COMPONENTS,
    ),
    ...currencyChecks('retail_reconciliation_components', [
      t.sourceCurrency,
      t.accountingCurrency,
      t.fxRateFrom,
      t.fxRateTo,
    ]),
    // Magnitudes. See the docblock: the sign is the component's, not the row's.
    check(
      'retail_reconciliation_components_amounts_check',
      sql`${t.sourceAmount} >= 0 and ${t.accountingAmount} >= 0 and ${t.evidenceCount} >= 0`,
    ),
    check(
      'retail_reconciliation_components_fx_presence_check',
      sql`num_nonnulls(${t.fxRateFrom}, ${t.fxRateTo}, ${t.fxRateRate}, ${t.fxRateProvider}, ${t.fxRateAsOf}) in (0, 5)
          and (${t.sourceCurrency} = ${t.accountingCurrency}) = (${t.fxRateRate} is null)`,
    ),
    check(
      'retail_reconciliation_components_fx_pair_check',
      sql`${t.fxRateRate} is null
          or (${t.fxRateFrom} = ${t.sourceCurrency}
              and ${t.fxRateTo} = ${t.accountingCurrency}
              and ${t.fxRateRate} > 0)`,
    ),
    uniqueIndex('retail_reconciliation_components_key').on(t.reconciliationId, t.component),
  ],
);

/**
 * `retail_reconciliation_evidence` — every authoritative record one revision
 * consumed, and the correlation trail #128's operator view item 12 asks for.
 * Append-only with its parent.
 *
 * The kinds are a closed set with no `catalog_price` member and no
 * `current_supplier_quote` member, which is how "never infer final cost from
 * the current catalog price after the order" is held: a live price has no
 * evidence shape to arrive in. The other half of that guarantee is a scanned
 * gate forbidding this domain from importing a catalogue read at all.
 *
 * `reference` is the durable id of the record — a Mercaria id, or a provider's
 * own document reference. It is what an operator opens a trace from and what a
 * duplicate detection keys on.
 */
export const retailReconciliationEvidence = pgTable(
  'retail_reconciliation_evidence',
  {
    id: generatedId(),
    reconciliationId: text()
      .notNull()
      .references(() => retailReconciliations.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(RETAIL_RECONCILIATION_EVIDENCE_KINDS) }).notNull(),
    /** The durable id of the record this figure came from. */
    reference: text().notNull(),
    /** What the record said, when it states an amount, in ITS own currency. */
    ...optionalMoney('evidence'),
    /** When the record was created or observed — never when the sweep read it. */
    observedAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_reconciliation_evidence_kind_check',
      t.kind,
      RETAIL_RECONCILIATION_EVIDENCE_KINDS,
    ),
    ...currencyChecks('retail_reconciliation_evidence', [t.evidenceCurrency]),
    check(
      'retail_reconciliation_evidence_reference_check',
      sql`length(btrim(${t.reference})) > 0`,
    ),
    // An amount names its currency. `optionalMoney` makes the pair nullable and
    // says nothing about them being nullable TOGETHER, so a figure with no
    // currency is representable without this — and raw minor units with no
    // currency are how two suppliers' invoices get added together.
    check(
      'retail_reconciliation_evidence_money_pair_check',
      sql`(${t.evidenceAmount} is null) = (${t.evidenceCurrency} is null)
          and (${t.evidenceAmount} is null or ${t.evidenceAmount} >= 0)`,
    ),
    uniqueIndex('retail_reconciliation_evidence_key').on(t.reconciliationId, t.kind, t.reference),
    index('retail_reconciliation_evidence_reference_idx').on(t.kind, t.reference),
  ],
);

/**
 * `retail_reconciliation_exceptions` — what a person has to look at.
 *
 * The `payment_discrepancies` posture: a row here is a RECORDING, detection is
 * separate from repair, and nothing in this domain deletes or rewrites a
 * financial record to make a mismatch go away. It is a SEPARATE table from
 * `payment_discrepancies` for the reason `procurement_exceptions` is: its kinds
 * are about supplier documents and cost evidence, and its correlation is an
 * ORDER rather than a payment.
 *
 * ## One OPEN case per (order, kind), and that is a partial unique
 *
 * Two sweep passes over one unresolved condition converge on the row that is
 * already open instead of filling a queue nobody reads, and the predicate is
 * what makes a RESOLVED case re-raisable when the condition genuinely recurs —
 * a plain unique would forbid that forever.
 *
 * Keyed on the ORDER and not on the reconciliation revision: "the supplier
 * invoice for this order is missing" is one condition however many revisions
 * have observed it, and a key including the revision would raise a new case on
 * every pass. `reconciliation_id` still names the revision that last saw it.
 */
export const retailReconciliationExceptions = pgTable(
  'retail_reconciliation_exceptions',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(RETAIL_RECONCILIATION_EXCEPTION_KINDS) }).notNull(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** The revision that last observed it. RESTRICT: revisions are never deleted. */
    reconciliationId: text().references(() => retailReconciliations.id, { onDelete: 'restrict' }),
    /** The purchase order the condition is about, when it is about one. */
    purchaseOrderId: text().references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    /**
     * Two ids and a sentence. No jsonb bag: an exception's context is composed
     * by Mercaria's own code, which is exactly the shape `services/analytics/`
     * refuses an open bag for, and the sentence goes through the same provider-
     * message redaction every stored provider string does.
     */
    detail: text().notNull(),
    raisedAt: timestamptz().notNull(),
    lastSeenAt: timestamptz().notNull(),
    occurrences: integer().notNull().default(1),
    resolvedAt: timestamptz(),
    resolvedByOxyUserId: text(),
    resolutionReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'retail_reconciliation_exceptions_kind_check',
      t.kind,
      RETAIL_RECONCILIATION_EXCEPTION_KINDS,
    ),
    check(
      'retail_reconciliation_exceptions_detail_check',
      sql`length(btrim(${t.detail})) between 1 and ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    check('retail_reconciliation_exceptions_occurrences_check', sql`${t.occurrences} >= 1`),
    // A resolution is attributable, dated and explained: all three or none —
    // the `retail_suppressions` lift rule (#121).
    check(
      'retail_reconciliation_exceptions_resolution_check',
      sql`num_nonnulls(${t.resolvedAt}, ${t.resolvedByOxyUserId}, ${t.resolutionReason}) in (0, 3)`,
    ),
    uniqueIndex('retail_reconciliation_exceptions_open_key')
      .on(t.kind, t.orderId)
      .where(sql`${t.resolvedAt} is null`),
    index('retail_reconciliation_exceptions_open_idx')
      .on(t.raisedAt)
      .where(sql`${t.resolvedAt} is null`),
    index('retail_reconciliation_exceptions_order_idx').on(t.orderId, t.raisedAt.desc()),
  ],
);

/* -------------------------------------------------------------------------- */
/*  The customer adjustment                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `retail_customer_adjustments` — ONE durable obligation to give a buyer back
 * the surplus, keyed by order and reconciliation revision (#128 customer-
 * adjustment rule 1).
 *
 * ## `UNIQUE(reconciliation_id)` is what "exactly one" means mechanically
 *
 * A reconciliation revision is unique per (order, revision), so a unique on the
 * revision is #128 acceptance 3's "exactly one customer adjustment obligation"
 * held by the database. A retry of the same reconciliation converges on the row
 * that exists; a LATER revision that finds a different surplus creates its own,
 * and `superseded_by_id` chains them so the operator sees one obligation
 * history rather than two live claims.
 *
 * ## The state machine, and why `refund_failed` is not terminal for the money
 *
 * `owed → refund_committed → refund_settled` is the happy path; `refund_failed`
 * means the rail refused after the commerce record committed, and the amount is
 * STILL OWED — the row stays open and the retry drives the same idempotent
 * refund path (`payment_repairs` posture). `payable_recorded` is #128 item 4's
 * "immediate refund is impossible": a real state with a reason and a retry, not
 * a quiet write-off.
 *
 * ## `non_refundable_provider_cost` exists so it is not hidden as margin
 *
 * #128 item 9, and ADR 0004 D8.7 case (c): a retained provider fee may never
 * exceed the actual fee, and retention beyond cost has no account to sit in. The
 * column records what could not come back and WHY it could not, so an operator
 * reading a partial adjustment sees the shortfall rather than inferring it.
 *
 * ## Nothing here restocks anything
 *
 * #128 item 6, held by absence: there is no quantity, no line and no variant
 * column in this table, and the adjustment path calls no inventory function. A
 * price adjustment is money moving, not goods.
 */
export const retailCustomerAdjustments = pgTable(
  'retail_customer_adjustments',
  {
    id: generatedId(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** The revision that found the surplus. RESTRICT: revisions are never deleted. */
    reconciliationId: text()
      .notNull()
      .references(() => retailReconciliations.id, { onDelete: 'restrict' }),
    /** Restated so an operator list can sort without joining. */
    reconciliationRevision: integer().notNull(),
    /** What is owed, in the reconciliation's accounting currency. */
    ...money('adjustment'),
    method: text({ enum: asEnumValues(RETAIL_ADJUSTMENT_METHODS) }).notNull(),
    state: text({ enum: asEnumValues(RETAIL_ADJUSTMENT_STATES) }).notNull().default('owed'),
    /** Why the rail was not used. Present exactly on a `recorded_payable`. */
    blockReason: text({ enum: asEnumValues(RETAIL_ADJUSTMENT_BLOCK_REASONS) }),
    /** ADR 0004 D8.7 case (c) — recorded explicitly, never hidden as margin. */
    ...optionalMoney('nonRefundableProviderCost'),
    /**
     * The #49 refund this adjustment was paid through. RESTRICT: a refund is a
     * committed commerce record and nothing deletes one.
     */
    refundId: text().references(() => refunds.id, { onDelete: 'restrict' }),
    /** When the buyer was told. Best-effort and never a precondition for owing. */
    notifiedAt: timestamptz(),
    /** The later obligation that replaced this one, when a revision found a different surplus. */
    supersededById: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('retail_customer_adjustments_method_check', t.method, RETAIL_ADJUSTMENT_METHODS),
    checkOneOf('retail_customer_adjustments_state_check', t.state, RETAIL_ADJUSTMENT_STATES),
    checkOneOf(
      'retail_customer_adjustments_block_reason_check',
      t.blockReason,
      RETAIL_ADJUSTMENT_BLOCK_REASONS,
    ),
    ...currencyChecks('retail_customer_adjustments', [
      t.adjustmentCurrency,
      t.nonRefundableProviderCostCurrency,
    ]),
    // An adjustment of nothing is not an adjustment. A zero surplus is
    // `cost_recovered_exactly` and creates no row at all.
    check('retail_customer_adjustments_amount_check', sql`${t.adjustmentAmount} > 0`),
    check(
      'retail_customer_adjustments_provider_cost_check',
      sql`(${t.nonRefundableProviderCostAmount} is null)
            = (${t.nonRefundableProviderCostCurrency} is null)
          and (${t.nonRefundableProviderCostAmount} is null
               or ${t.nonRefundableProviderCostAmount} >= 0)`,
    ),
    // A blocked adjustment names its reason, and an unblocked one claims none.
    check(
      'retail_customer_adjustments_block_shape_check',
      sql`(${t.method} = 'recorded_payable') = (${t.blockReason} is not null)`,
    ),
    // A refund pointer exists exactly once the rail has been asked. The three
    // states that name one are the three in which a `refunds` row exists;
    // `refund_failed` keeps it, because the commerce record committed and only
    // the money did not move.
    check(
      'retail_customer_adjustments_refund_shape_check',
      sql`(${t.state} in ('refund_committed', 'refund_settled', 'refund_failed'))
            = (${t.refundId} is not null)`,
    ),
    // A `recorded_payable` never reaches a refund state without changing method
    // first, and a `provider_refund` never sits in `payable_recorded`.
    check(
      'retail_customer_adjustments_method_state_check',
      sql`(${t.state} = 'payable_recorded') is not true or ${t.method} = 'recorded_payable'`,
    ),
    uniqueIndex('retail_customer_adjustments_reconciliation_key').on(t.reconciliationId),
    index('retail_customer_adjustments_order_idx').on(t.orderId, t.createdAt.desc()),
    // The operator queue: what is still owed, oldest first.
    index('retail_customer_adjustments_open_idx')
      .on(t.createdAt)
      .where(sql`${t.state} <> 'refund_settled' and ${t.state} <> 'closed_at_finality'`),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Supplier credits                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `retail_supplier_credits` — one supplier credit, linked to its purchase
 * order, the supplier invoice it reverses and the customer order it affects
 * (#128 supplier-credit rule 1). Append-only by trigger.
 *
 * ## The classification is the whole of rules 2 and 3
 *
 * `return_linked` accompanies a customer return: it reconciles against the
 * return/refund lifecycle and does NOT reduce an already-promised customer
 * refund, which falls out of both movements being represented — the refund
 * lowers the customer side and the credit lowers the cost side by the same
 * amount, so the variance is unchanged by the pair. `cost_reduction` is
 * unrelated to a return, lowers the final attributable cost on its own, and
 * therefore MAY create a customer adjustment under the zero-profit policy.
 * `unattributable` is recorded and raises `unlinked_supplier_credit`: guessing
 * would either invent an adjustment or hide one.
 *
 * A `return_linked` credit REQUIRES an order, because a credit that reconciles
 * against a return has a return to reconcile against. That is a CHECK.
 *
 * ## `UNIQUE(claim_key)` is rule 4
 *
 * "Duplicate supplier credit events are idempotent" — a redelivered supplier
 * document, a poll after a webhook and a reconciliation sweep re-reading the
 * same credit note all derive the same key and converge on one row. The key is
 * composed from the purchase order and the provider's own document id, never
 * from a delivery timestamp, which is what makes it converge rather than look
 * unique every time.
 *
 * ## It BOOKS nothing by being written
 *
 * `ledger_transaction_id` is filled in the SAME transaction as the posting, or
 * it is NULL and the credit is recorded but unbooked. There is no `booked`
 * boolean beside it — the pointer is the fact. Rule 5, "credits cannot be
 * silently classified as retail revenue", is held one layer down: the only
 * posting a credit can produce debits `supplier_prepaid` and credits
 * `procurement_expense`, and no revenue account is reachable from it.
 */
export const retailSupplierCredits = pgTable(
  'retail_supplier_credits',
  {
    id: generatedId(),
    classification: text({ enum: asEnumValues(RETAIL_SUPPLIER_CREDIT_CLASSIFICATIONS) }).notNull(),
    purchaseOrderId: text()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    /** The customer order this credit affects. Absent only on an `unattributable` one. */
    orderId: text().references(() => orders.id, { onDelete: 'cascade' }),
    /** The supplier's own credit-note reference. Their key space, never a Mercaria key. */
    providerDocumentId: text().notNull(),
    /** The supplier invoice it reverses, when the document names one. */
    supplierInvoiceReference: text(),
    /**
     * The #127 recovery this credit was classified against, when one exists.
     *
     * `return_linked` is not a guess about what a credit "looks like": it is a
     * claim that a customer RETURN is on the other side of it, and this column
     * names the row that established it. Recording the evidence beside the
     * verdict is what makes the classification auditable rather than a rule
     * somebody would have to re-run to check.
     *
     * Nullable, because a `cost_reduction` credit legitimately has no recovery
     * behind it — a supplier correcting its own overcharge names nothing on
     * Mercaria's side. `ON DELETE restrict`: a credit cites its evidence, so the
     * evidence may not vanish from under it.
     */
    supplierRecoveryId: text().references(() => supplierRecoveries.id, { onDelete: 'restrict' }),
    /** What the supplier credited, in the SUPPLIER's own currency. */
    ...money('credit'),
    /** The same amount in the affected order's accounting currency. */
    ...money('accounting'),
    // The exact conversion — the `retail_reconciliation_components` shape.
    fxRateFrom: text({ enum: CURRENCY_CODE_VALUES }),
    fxRateTo: text({ enum: CURRENCY_CODE_VALUES }),
    fxRateRate: doublePrecision(),
    fxRateProvider: text(),
    fxRateAsOf: text(),
    /** When the supplier issued it, from the document — never when Mercaria read it. */
    issuedAt: timestamptz().notNull(),
    recordedAt: timestamptz().notNull(),
    /** The convergence key. See the docblock. */
    claimKey: text().notNull(),
    /** The posting that booked it, written in the same transaction. */
    ledgerTransactionId: text().references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    /** No `updated_at` — the row is append-only. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_supplier_credits_classification_check',
      t.classification,
      RETAIL_SUPPLIER_CREDIT_CLASSIFICATIONS,
    ),
    ...currencyChecks('retail_supplier_credits', [
      t.creditCurrency,
      t.accountingCurrency,
      t.fxRateFrom,
      t.fxRateTo,
    ]),
    check(
      'retail_supplier_credits_amounts_check',
      sql`${t.creditAmount} > 0 and ${t.accountingAmount} > 0`,
    ),
    check(
      'retail_supplier_credits_document_check',
      sql`length(btrim(${t.providerDocumentId})) > 0 and length(btrim(${t.claimKey})) > 0`,
    ),
    // A credit that reconciles against a return has a return to reconcile
    // against, and an `unattributable` one names no order by definition.
    check(
      'retail_supplier_credits_order_shape_check',
      sql`(${t.classification} = 'unattributable') = (${t.orderId} is null)`,
    ),
    // An IMPLICATION and deliberately not a biconditional. `return_linked`
    // requires the recovery that established the return; the converse is false,
    // because a recovery of a non-return kind (a cancelled procurement, a lost
    // parcel) legitimately sits beside a `cost_reduction` credit and naming it
    // is still the right thing to record. Writing this as `=` would refuse
    // exactly that row.
    check(
      'retail_supplier_credits_return_evidence_check',
      sql`${t.classification} <> 'return_linked' or ${t.supplierRecoveryId} is not null`,
    ),
    check(
      'retail_supplier_credits_fx_presence_check',
      sql`num_nonnulls(${t.fxRateFrom}, ${t.fxRateTo}, ${t.fxRateRate}, ${t.fxRateProvider}, ${t.fxRateAsOf}) in (0, 5)
          and (${t.creditCurrency} = ${t.accountingCurrency}) = (${t.fxRateRate} is null)`,
    ),
    check(
      'retail_supplier_credits_fx_pair_check',
      sql`${t.fxRateRate} is null
          or (${t.fxRateFrom} = ${t.creditCurrency}
              and ${t.fxRateTo} = ${t.accountingCurrency}
              and ${t.fxRateRate} > 0)`,
    ),
    uniqueIndex('retail_supplier_credits_claim_key').on(t.claimKey),
    index('retail_supplier_credits_po_idx').on(t.purchaseOrderId, t.issuedAt.desc()),
    index('retail_supplier_credits_order_idx')
      .on(t.orderId, t.issuedAt.desc())
      .where(sql`${t.orderId} is not null`),
    // Supplier-credit LATENCY (metric 5): issued-to-recorded, by supplier order.
    index('retail_supplier_credits_recorded_idx').on(t.recordedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Ledger recognition and the operator audit                                  */
/* -------------------------------------------------------------------------- */

/**
 * `retail_ledger_recognitions` — the claim taken BEFORE every posting this
 * domain makes, and the pointer to the posting it authorised. Append-only.
 *
 * `ledger_transactions` has no natural key a second booking would collide with,
 * and its append-only trigger means a duplicate can never be cleaned up
 * afterwards — a correction would have to be a reversing transaction, which is
 * the right mechanism for a WRONG posting and the wrong one for a posting that
 * simply happened twice. So the claim comes first: an
 * `INSERT … ON CONFLICT DO NOTHING … RETURNING` whose empty-versus-one-row
 * result IS the "already booked" answer, and which commits in the SAME
 * transaction as the entries it authorises, so a crash between them is not a
 * state that exists.
 *
 * The conflict is not an error to catch. Reading it off the RETURNING set is
 * what lets a real failure — a dropped connection, an exhausted pool —
 * propagate instead of being read as a duplicate (the moderation-event store's
 * reasoning, in the one domain where the difference is money).
 *
 * `claim_key` is composed from the durable thing the posting is ABOUT (a
 * purchase order, a reconciliation revision, a supplier credit, an adjustment),
 * never from a run id or a timestamp — both of which would make every claim
 * unique and defeat the index silently rather than loudly.
 */
export const retailLedgerRecognitions = pgTable(
  'retail_ledger_recognitions',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(RETAIL_LEDGER_RECOGNITION_KINDS) }).notNull(),
    /** The durable id the posting is about. See the docblock. */
    claimKey: text().notNull(),
    /** The posting this claim authorised, written in the same transaction. */
    ledgerTransactionId: text()
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    /**
     * Correlation, for the operator trace. All three are nullable and which
     * ones are set depends on the kind: a `prefund_top_up` names a supplier and
     * no order, a `variance_recognized` names an order and no purchase order.
     * RESTRICT on every one — nothing deletes a financial record.
     */
    orderId: text().references(() => orders.id, { onDelete: 'restrict' }),
    purchaseOrderId: text().references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    supplierId: text().references(() => suppliers.id, { onDelete: 'restrict' }),
    /** What was booked, in the currency it was booked in. */
    ...money('booked'),
    bookedAt: timestamptz().notNull(),
    /** No `updated_at` — the row is append-only. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('retail_ledger_recognitions_kind_check', t.kind, RETAIL_LEDGER_RECOGNITION_KINDS),
    ...currencyChecks('retail_ledger_recognitions', [t.bookedCurrency]),
    check('retail_ledger_recognitions_amount_check', sql`${t.bookedAmount} > 0`),
    check('retail_ledger_recognitions_key_check', sql`length(btrim(${t.claimKey})) > 0`),
    uniqueIndex('retail_ledger_recognitions_kind_key').on(t.kind, t.claimKey),
    index('retail_ledger_recognitions_order_idx')
      .on(t.orderId, t.bookedAt.desc())
      .where(sql`${t.orderId} is not null`),
  ],
);

/**
 * `retail_reconciliation_operator_actions` — one row per ATTEMPT on the
 * operator surface, refusals included. Append-only.
 *
 * The `payment_repairs` shape and the reason is the same: an attempt the surface
 * DECLINED is exactly what an incident review needs to see, and a table that
 * recorded only successes would make a refused action indistinguishable from one
 * nobody tried. Actor and reason are mandatory.
 *
 * The action set is CLOSED (`RETAIL_RECONCILIATION_OPERATOR_ACTIONS`) and every
 * member drives a path the sweep already runs on its own, so this surface adds a
 * trigger and no new way to move money. There is deliberately no "set this
 * variance", no "waive this adjustment", no "override this cost" and no delete.
 */
export const retailReconciliationOperatorActions = pgTable(
  'retail_reconciliation_operator_actions',
  {
    id: generatedId(),
    action: text({ enum: asEnumValues(RETAIL_RECONCILIATION_OPERATOR_ACTIONS) }).notNull(),
    outcome: text({ enum: asEnumValues(RETAIL_RECONCILIATION_OPERATOR_OUTCOMES) }).notNull(),
    /** The Oxy account that pressed it. Mandatory — nothing here is anonymous. */
    actorOxyUserId: text().notNull(),
    /** Why. Mandatory, and it is what a review reads. */
    reason: text().notNull(),
    /** What it was about — exactly one of these is set, by CHECK. */
    orderId: text(),
    adjustmentId: text().references(() => retailCustomerAdjustments.id, { onDelete: 'restrict' }),
    exceptionId: text().references(() => retailReconciliationExceptions.id, {
      onDelete: 'restrict',
    }),
    /** The refusal, when the surface declined. Present exactly on a `refused`. */
    refusalDetail: text(),
    attemptedAt: timestamptz().notNull(),
    /** No `updated_at` — the row is append-only. */
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'retail_reconciliation_operator_actions_action_check',
      t.action,
      RETAIL_RECONCILIATION_OPERATOR_ACTIONS,
    ),
    checkOneOf(
      'retail_reconciliation_operator_actions_outcome_check',
      t.outcome,
      RETAIL_RECONCILIATION_OPERATOR_OUTCOMES,
    ),
    check(
      'retail_reconciliation_operator_actions_actor_check',
      sql`length(btrim(${t.actorOxyUserId})) > 0
          and length(btrim(${t.reason})) between 1 and ${sql.raw(String(MAX_NOTE_LENGTH))}`,
    ),
    // An attempt is about exactly one thing. Zero subjects would be an audit row
    // nobody can trace; two would be an action whose target is ambiguous.
    check(
      'retail_reconciliation_operator_actions_subject_check',
      sql`num_nonnulls(${t.orderId}, ${t.adjustmentId}, ${t.exceptionId}) = 1`,
    ),
    check(
      'retail_reconciliation_operator_actions_refusal_check',
      sql`(${t.outcome} = 'refused') = (${t.refusalDetail} is not null)`,
    ),
    index('retail_reconciliation_operator_actions_attempted_idx').on(t.attemptedAt.desc()),
    index('retail_reconciliation_operator_actions_order_idx')
      .on(t.orderId, t.attemptedAt.desc())
      .where(sql`${t.orderId} is not null`),
  ],
);
