/**
 * The referral EARNINGS ledger: postings, transitions, payout batches and the
 * reconciliation sweep's findings (#145, under ADR 0005 "Ledger
 * representability", D12–D15 and R1–R8).
 *
 * Five tables. None of them holds a balance, and that absence is acceptance 1:
 * **reward balances are fully derivable from immutable entries**, and the
 * immutable entries are `ledger_entries` — the same table, the same repository,
 * the same three-layer balance enforcement every other Mercaria movement uses.
 * A `referral_partner_balances` row would be a second representation of a fact
 * the book already carries, and the two would disagree exactly when it mattered.
 *
 * ## What each table is for, and why it is not the others
 *
 * - **`referral_ledger_postings`** is the BRIDGE and the idempotency CLAIM: it
 *   says which `ledger_transactions` row booked which referral fact, under a
 *   deterministic key. It is what makes "reward creation and reversal must be
 *   idempotent on stable ids" a DATABASE property (a unique index plus
 *   `ON CONFLICT DO NOTHING`, whose empty `RETURNING` set IS the "already
 *   booked" answer) rather than a read-then-write two workers can both win.
 * - **`referral_reward_transitions`** records STATE changes, which book nothing
 *   — ADR 0005: "state-only transitions book nothing: no money moved". A
 *   `held → vested` is not a posting and a posting is not a transition, so one
 *   table for both would need a nullable half on every row.
 * - **`referral_payout_batches`** / **`referral_payout_batch_items`** are the
 *   payout side, deliberately separate from the earnings side (#145 ledger
 *   behaviour 4: never mix payout and earnings state). A reward's `state` says
 *   what it has EARNED; the batch says what has been PAID, and a reward reaches
 *   `paid` only when its batch does.
 * - **`referral_earning_discrepancies`** is the sweep's output. The
 *   `payment_discrepancies` posture exactly: this domain DETECTS and never
 *   repairs, because every kind it can record is a decision about a financial
 *   record.
 *
 * ## Nothing here is deletable and nothing here is editable
 *
 * Four append-only triggers. The postings, the transitions and the batch items
 * refuse UPDATE and DELETE outright — `referral_payout_batch_items` with ONE
 * precise exception, `released_at` moving NULL → a value exactly once, which is
 * how a cancelled batch hands its rewards back to a later one. The batches
 * themselves are mutable by design (a status machine with a rail behind it) and
 * carry a trigger freezing their IDENTITY: partner, currency, amounts, key.
 *
 * That is #145 acceptance 4 and 6 in one sentence: a refund or fraud reversal
 * cannot duplicate or erase history, and a feature rollback cannot erase an
 * already-earned or already-paid record, because no code path and no `psql`
 * session can remove one.
 *
 * ## No contact, no credential, no buyer, structurally
 *
 * Like every other table in this domain, the only identities representable here
 * are a `referral_partners.id`, an Oxy OPERATOR id and a rail's own opaque
 * reference. There is no email, no beneficiary detail, no tax identifier and no
 * order id — a payout is about a partner and an amount, and the conversion that
 * earned it is reachable only through the reward, which is where ADR 0005 A5
 * already draws that line.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  REFERRAL_EARNING_DISCREPANCY_KINDS,
  REFERRAL_EARNING_DISCREPANCY_STATUSES,
  REFERRAL_EVENT_ACTOR_KINDS,
  REFERRAL_LEDGER_POSTING_KINDS,
  REFERRAL_PAYOUT_BATCH_STATUSES,
  REFERRAL_PAYOUT_FAILURE_REASONS,
  REFERRAL_REWARD_STATES,
  REFERRAL_REWARD_TRANSITION_CAUSES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, CURRENCY_CODE_VALUES } from './columns';
import { ledgerTransactions } from './ledger';
import { referralPartners } from './referrals';
import { referralRewardAdjustments, referralRewards } from './referralRewards';

/** Bound on a stored reason — the `referral_events` bound, same reasoning. */
const MAX_REASON_LENGTH = 2_000;

/**
 * `referral_payout_batches` — one settlement of one partner's vested rewards,
 * carrying every field #145's "Payout batches" section names.
 *
 * ## One OPEN batch per partner per currency, by partial unique
 *
 * `referral_payout_batches_open_key` is the whole answer to "two batches racing
 * for the same rewards". Without it the builder would have to read what is
 * already claimed and then insert, which under READ COMMITTED is the
 * read-then-write that both racers win — and the batch ITEM's own partial
 * unique would then refuse the loser's items one at a time, leaving a half-built
 * batch with a total that no longer matches what it holds.
 *
 * ## `failed` is retryable and `cancelled` is not
 *
 * A rail that answered 500 has told nobody whether the money moved, so the retry
 * rides the batch's OWN `idempotency_key` — which is derived from the batch id
 * and therefore byte-identical across attempts, the property ADR 0001 D11 makes
 * every provider retry rest on. Releasing the items on failure would let the
 * retry and the next batch both carry the same reward, which is precisely the
 * duplicate payout the claim exists to prevent. `cancelled` is the operator's
 * terminal decision and is the only status that releases anything.
 *
 * ## Four eyes, expressed so it cannot be trivially satisfied
 *
 * The construction loop opens a batch as `system`; a person opening one by hand
 * names themselves. `approved_by <> created_by` is therefore automatically true
 * for the loop's batches and a real second pair of eyes for a hand-built one —
 * the #55/#59 flag applied where it actually bites, with no branch to get wrong.
 */
export const referralPayoutBatches = pgTable(
  'referral_payout_batches',
  {
    id: generatedId(),
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'restrict' }),
    /** The stable program identity, matching `referral_program_controls.program_id`. */
    programId: text().notNull(),
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    status: text({ enum: asEnumValues(REFERRAL_PAYOUT_BATCH_STATUSES) })
      .notNull()
      .default('draft'),
    /** Field 5 — the sum of the included rewards' nets, at the moment of building. */
    grossEligibleMinor: bigint({ mode: 'number' }).notNull(),
    /** Field 6 — withholding or tax adjustment, where a jurisdiction requires one. */
    withholdingMinor: bigint({ mode: 'number' }).notNull().default(0),
    /** Field 7 — `gross - withholding`, a CHECK rather than a convention. */
    netPayoutMinor: bigint({ mode: 'number' }).notNull(),
    /** Field 8 — the rail's own opaque handle. Never a Mercaria primary key. */
    providerReference: text(),
    /** Field 9 */
    failureReason: text({ enum: asEnumValues(REFERRAL_PAYOUT_FAILURE_REASONS) }),
    failureDetail: text(),
    /** Field 11 — derived from this row's id, so every retry presents the same one. */
    idempotencyKey: text().notNull(),
    /** Field 12 — `system` for a batch the construction loop opened. */
    createdByOxyUserId: text().notNull(),
    approvedByOxyUserId: text(),
    cancelledByOxyUserId: text(),
    /** Field 10 */
    approvedAt: timestamptz(),
    paidAt: timestamptz(),
    failedAt: timestamptz(),
    cancelledAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('referral_payout_batches_status_check', t.status, REFERRAL_PAYOUT_BATCH_STATUSES),
    checkOneOf(
      'referral_payout_batches_failure_reason_check',
      t.failureReason,
      REFERRAL_PAYOUT_FAILURE_REASONS,
    ),
    ...currencyChecks('referral_payout_batches', [t.currency]),
    check(
      'referral_payout_batches_identity_check',
      sql`length(${t.programId}) > 0 and length(${t.idempotencyKey}) > 0
          and length(${t.createdByOxyUserId}) > 0`,
    ),
    // The arithmetic, as a row property. A batch that paid more than it was
    // owed, or a withholding that exceeded the gross, is unrepresentable.
    check(
      'referral_payout_batches_amounts_check',
      sql`${t.grossEligibleMinor} > 0 and ${t.withholdingMinor} >= 0
          and ${t.netPayoutMinor} >= 0
          and ${t.netPayoutMinor} = ${t.grossEligibleMinor} - ${t.withholdingMinor}`,
    ),
    // Four eyes when a person opened it; automatically satisfied when the loop
    // did, because `system` is not an Oxy account id anybody holds.
    check(
      'referral_payout_batches_four_eyes_check',
      sql`${t.approvedByOxyUserId} is null
          or ${t.approvedByOxyUserId} <> ${t.createdByOxyUserId}`,
    ),
    check(
      'referral_payout_batches_status_times_check',
      sql`(${t.status} <> 'approved' or (${t.approvedAt} is not null
              and ${t.approvedByOxyUserId} is not null))
          and (${t.status} <> 'processing' or ${t.approvedAt} is not null)
          and (${t.status} <> 'paid' or (${t.paidAt} is not null
              and ${t.providerReference} is not null))
          and (${t.status} <> 'failed' or (${t.failedAt} is not null
              and ${t.failureReason} is not null))
          and (${t.status} <> 'cancelled' or (${t.cancelledAt} is not null
              and ${t.cancelledByOxyUserId} is not null
              and ${t.failureReason} = 'operator_cancelled'))`,
    ),
    // A detail without a reason is prose nobody can act on.
    check(
      'referral_payout_batches_failure_detail_check',
      sql`${t.failureDetail} is null
          or (${t.failureReason} is not null
              and length(${t.failureDetail}) > 0
              and length(${t.failureDetail}) <= ${sql.raw(String(MAX_REASON_LENGTH))})`,
    ),
    uniqueIndex('referral_payout_batches_idempotency_key_key').on(t.idempotencyKey),
    // At most ONE live batch per partner per currency — the whole answer to two
    // builders racing. See the docblock.
    uniqueIndex('referral_payout_batches_open_key')
      .on(t.partnerId, t.currency)
      .where(sql`${t.status} in ('draft', 'approved', 'processing', 'failed')`),
    index('referral_payout_batches_partner_created_at_idx').on(
      t.partnerId,
      t.createdAt.desc(),
    ),
    index('referral_payout_batches_status_created_at_idx').on(t.status, t.createdAt),
  ],
);

/**
 * `referral_payout_batch_items` — which rewards one batch settles (#145 "Payout
 * batches" field 3).
 *
 * ## The partial unique IS the claim
 *
 * `referral_payout_batch_items_live_reward_key` on `(reward_id) WHERE
 * released_at IS NULL` means one reward can be in at most one LIVE batch, ever.
 * That is what makes "a payout batch settles only vested/payable rewards"
 * survive a retry, a second builder and an operator opening a batch by hand at
 * the same moment the loop does — none of them can claim a reward another holds,
 * and the refusal is the database's rather than a check somebody remembered.
 *
 * `net_amount_minor` is the reward's net AT CLAIM TIME, snapshotted rather than
 * joined: a reversal landing between the claim and the settlement lowers the
 * reward's net, and the batch has to be able to say what it was built on. The
 * settlement re-derives payability before it books anything, so a batch whose
 * rewards have moved fails with `amount_no_longer_payable` rather than paying a
 * figure that is no longer owed.
 */
export const referralPayoutBatchItems = pgTable(
  'referral_payout_batch_items',
  {
    id: generatedId(),
    batchId: text()
      .notNull()
      .references(() => referralPayoutBatches.id, { onDelete: 'restrict' }),
    rewardId: text()
      .notNull()
      .references(() => referralRewards.id, { onDelete: 'restrict' }),
    /** The reward's net when the batch claimed it. */
    netAmountMinor: bigint({ mode: 'number' }).notNull(),
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** Set exactly once, by a CANCELLED batch handing the reward back. */
    releasedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    ...currencyChecks('referral_payout_batch_items', [t.currency]),
    check('referral_payout_batch_items_amount_check', sql`${t.netAmountMinor} > 0`),
    uniqueIndex('referral_payout_batch_items_batch_reward_key').on(t.batchId, t.rewardId),
    uniqueIndex('referral_payout_batch_items_live_reward_key')
      .on(t.rewardId)
      .where(sql`${t.releasedAt} is null`),
    index('referral_payout_batch_items_batch_id_idx').on(t.batchId),
  ],
);

/**
 * `referral_ledger_postings` — which ledger transaction booked which referral
 * fact, and the deterministic key that makes a repeat converge.
 *
 * ## The idempotency key is derived from the SUBJECT, never from a clock
 *
 * `refledg:<kind>:<subjectId>`. A reward accrual keys on the REWARD (one accrual
 * per reward, ever); a reversal keys on the ADJUSTMENT row, whose own key
 * already carries `(reward, cause, source)`; a payout keys on the BATCH. So a
 * retried accrual, a redelivered refund webhook and a reconciliation sweep
 * re-deriving the same fact all land on the row they already made — and
 * `ON CONFLICT DO NOTHING` writes NOTHING at all on the repeat, which is what
 * makes a genuine no-op distinguishable from a second posting that happened to
 * compute the same figure.
 *
 * ## `amount_minor` is a positive MAGNITUDE and the kind carries the direction
 *
 * The signed movement lives in `ledger_entries`, where the sign convention is
 * enforced and summed. Copying a signed figure here would be a second
 * representation of it that could disagree; a magnitude plus a kind cannot,
 * because the kind is the same closed vocabulary the transaction's own
 * `LedgerTransactionKind` carries.
 */
export const referralLedgerPostings = pgTable(
  'referral_ledger_postings',
  {
    id: generatedId(),
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'restrict' }),
    kind: text({ enum: asEnumValues(REFERRAL_LEDGER_POSTING_KINDS) }).notNull(),
    rewardId: text().references(() => referralRewards.id, { onDelete: 'restrict' }),
    adjustmentId: text().references(() => referralRewardAdjustments.id, {
      onDelete: 'restrict',
    }),
    payoutBatchId: text().references(() => referralPayoutBatches.id, { onDelete: 'restrict' }),
    /**
     * The balanced transaction this posting booked. A REAL foreign key: the
     * ledger is in this database, written in the same transaction, and
     * `restrict` is right because deleting either side would destroy the record
     * of money that moved.
     */
    ledgerTransactionId: text()
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    /** A positive magnitude — see the docblock. */
    amountMinor: bigint({ mode: 'number' }).notNull(),
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    idempotencyKey: text().notNull(),
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('referral_ledger_postings_kind_check', t.kind, REFERRAL_LEDGER_POSTING_KINDS),
    ...currencyChecks('referral_ledger_postings', [t.currency]),
    check(
      'referral_ledger_postings_identity_check',
      sql`length(${t.idempotencyKey}) > 0`,
    ),
    check('referral_ledger_postings_amount_check', sql`${t.amountMinor} > 0`),
    // Exactly the subjects each kind is ABOUT, and no others. A payout posting
    // naming a reward, or an accrual naming a batch, would make the trace
    // ambiguous in the one direction an operator reads it.
    check(
      'referral_ledger_postings_subject_shape_check',
      sql`(${t.kind} = 'reward_accrued' and ${t.rewardId} is not null
             and ${t.adjustmentId} is null and ${t.payoutBatchId} is null)
          or (${t.kind} = 'reward_reversed' and ${t.rewardId} is not null
             and ${t.adjustmentId} is not null and ${t.payoutBatchId} is null)
          or (${t.kind} = 'payout_settled' and ${t.payoutBatchId} is not null
             and ${t.rewardId} is null and ${t.adjustmentId} is null)
          or (${t.kind} = 'recovery_received' and ${t.rewardId} is null
             and ${t.adjustmentId} is null and ${t.payoutBatchId} is null)`,
    ),
    uniqueIndex('referral_ledger_postings_idempotency_key_key').on(t.idempotencyKey),
    index('referral_ledger_postings_partner_occurred_at_idx').on(
      t.partnerId,
      t.occurredAt.desc(),
    ),
    index('referral_ledger_postings_reward_id_idx')
      .on(t.rewardId)
      .where(sql`${t.rewardId} is not null`),
    index('referral_ledger_postings_batch_id_idx')
      .on(t.payoutBatchId)
      .where(sql`${t.payoutBatchId} is not null`),
    index('referral_ledger_postings_ledger_transaction_id_idx').on(t.ledgerTransactionId),
  ],
);

/**
 * `referral_reward_transitions` — every state change a reward went through,
 * durably, idempotently and attributably (#145 "Reward lifecycle").
 *
 * ## A state-only transition books NOTHING and that is why this table exists
 *
 * ADR 0005: `frozen` and `vested` move no money. A `held → vested` therefore has
 * no ledger transaction to point at, and recording it as a posting with a zero
 * amount is exactly what `ledger_entries_amount_nonzero_check` refuses one table
 * over. Two different facts, two tables.
 *
 * ## The idempotency key carries the CAUSE and the SUBJECT, never a clock
 *
 * `refrewst:<rewardId>:<cause>:<sourceRef>`. A vesting sweep that runs twice in
 * one minute, a freeze applied by two operators at once and a settlement retried
 * after a lost response all converge on the row they already wrote. A key
 * carrying a timestamp would record every re-run, and the trail would then say a
 * reward vested eleven times.
 */
export const referralRewardTransitions = pgTable(
  'referral_reward_transitions',
  {
    id: generatedId(),
    rewardId: text()
      .notNull()
      .references(() => referralRewards.id, { onDelete: 'restrict' }),
    fromState: text({ enum: asEnumValues(REFERRAL_REWARD_STATES) }).notNull(),
    toState: text({ enum: asEnumValues(REFERRAL_REWARD_STATES) }).notNull(),
    cause: text({ enum: asEnumValues(REFERRAL_REWARD_TRANSITION_CAUSES) }).notNull(),
    actorKind: text({ enum: asEnumValues(REFERRAL_EVENT_ACTOR_KINDS) }).notNull(),
    /** NULL exactly when the actor is `system` — the `referral_events` rule. */
    actorRef: text(),
    reason: text().notNull(),
    idempotencyKey: text().notNull(),
    occurredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('referral_reward_transitions_from_state_check', t.fromState, REFERRAL_REWARD_STATES),
    checkOneOf('referral_reward_transitions_to_state_check', t.toState, REFERRAL_REWARD_STATES),
    checkOneOf(
      'referral_reward_transitions_cause_check',
      t.cause,
      REFERRAL_REWARD_TRANSITION_CAUSES,
    ),
    checkOneOf(
      'referral_reward_transitions_actor_kind_check',
      t.actorKind,
      REFERRAL_EVENT_ACTOR_KINDS,
    ),
    // A transition that changed nothing is not a transition; recording one would
    // make "did this reward move" unanswerable from the trail.
    check(
      'referral_reward_transitions_moves_check',
      sql`${t.fromState} <> ${t.toState}`,
    ),
    check(
      'referral_reward_transitions_actor_check',
      sql`(${t.actorKind} = 'system') = (${t.actorRef} is null)`,
    ),
    check(
      'referral_reward_transitions_reason_check',
      sql`length(${t.reason}) > 0 and length(${t.reason}) <= ${sql.raw(String(MAX_REASON_LENGTH))}
          and length(${t.idempotencyKey}) > 0`,
    ),
    uniqueIndex('referral_reward_transitions_idempotency_key_key').on(t.idempotencyKey),
    index('referral_reward_transitions_reward_id_idx').on(t.rewardId, t.occurredAt),
  ],
);

/**
 * `referral_earning_discrepancies` — what the reconciliation sweep found.
 *
 * ADR 0005 requires it by name: the reward's net and the ledger's
 * `referral_payable` are two stores that must agree, "and #145 must pin that
 * agreement with a reconciliation sweep in the #50 mold — the payment domain
 * already proved that two such stores without a sweep is a discrepancy nobody
 * notices". They cannot disagree by construction here, because the posting
 * commits in the same transaction as the reward write; the sweep exists because
 * "structurally impossible" and "nobody has ever checked" are indistinguishable
 * from outside the code, which is `findGlobalLedgerImbalances`' own argument.
 *
 * ## The upsert must not REOPEN a resolved row
 *
 * `dedupe_key` converges a re-run on the row it already wrote, and the writer's
 * `ON CONFLICT DO UPDATE` carries `WHERE status <> 'resolved'`. Without that
 * predicate a sweep re-observing a finding an operator has already answered
 * reopens it — the exact failure `payment_discrepancies` hit in the shared test
 * database, presenting in a sibling as `expected 'open' to be 'resolved'` and
 * naming nothing about the cause.
 */
export const referralEarningDiscrepancies = pgTable(
  'referral_earning_discrepancies',
  {
    id: generatedId(),
    kind: text({ enum: asEnumValues(REFERRAL_EARNING_DISCREPANCY_KINDS) }).notNull(),
    partnerId: text()
      .notNull()
      .references(() => referralPartners.id, { onDelete: 'restrict' }),
    rewardId: text().references(() => referralRewards.id, { onDelete: 'restrict' }),
    payoutBatchId: text().references(() => referralPayoutBatches.id, { onDelete: 'restrict' }),
    currency: text({ enum: CURRENCY_CODE_VALUES }).notNull(),
    /** What the sweep expected the figure to be. Signed — a payable may be negative. */
    expectedMinor: bigint({ mode: 'number' }).notNull(),
    /** What it actually read. Signed, for the same reason. */
    observedMinor: bigint({ mode: 'number' }).notNull(),
    detail: text().notNull(),
    status: text({ enum: asEnumValues(REFERRAL_EARNING_DISCREPANCY_STATUSES) })
      .notNull()
      .default('open'),
    /** Deterministic from the finding, so a re-run converges instead of piling up. */
    dedupeKey: text().notNull(),
    firstSeenAt: timestamptz().notNull(),
    lastSeenAt: timestamptz().notNull(),
    resolvedAt: timestamptz(),
    resolvedByOxyUserId: text(),
    resolutionNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'referral_earning_discrepancies_kind_check',
      t.kind,
      REFERRAL_EARNING_DISCREPANCY_KINDS,
    ),
    checkOneOf(
      'referral_earning_discrepancies_status_check',
      t.status,
      REFERRAL_EARNING_DISCREPANCY_STATUSES,
    ),
    ...currencyChecks('referral_earning_discrepancies', [t.currency]),
    check(
      'referral_earning_discrepancies_identity_check',
      sql`length(${t.dedupeKey}) > 0 and length(${t.detail}) > 0
          and length(${t.detail}) <= ${sql.raw(String(MAX_REASON_LENGTH))}`,
    ),
    // A resolution is attributable and explained, or it is not a resolution.
    check(
      'referral_earning_discrepancies_resolution_check',
      sql`(${t.status} = 'resolved') = (${t.resolvedAt} is not null)
          and (${t.resolvedAt} is null
               or (${t.resolvedByOxyUserId} is not null and ${t.resolutionNote} is not null
                   and length(${t.resolutionNote}) > 0))`,
    ),
    check(
      'referral_earning_discrepancies_seen_order_check',
      sql`${t.lastSeenAt} >= ${t.firstSeenAt}`,
    ),
    uniqueIndex('referral_earning_discrepancies_dedupe_key_key').on(t.dedupeKey),
    index('referral_earning_discrepancies_status_last_seen_idx').on(t.status, t.lastSeenAt.desc()),
    index('referral_earning_discrepancies_partner_id_idx').on(t.partnerId),
  ],
);
