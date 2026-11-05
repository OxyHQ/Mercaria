/**
 * Reconciliation, discrepancies and operator repairs — issue #50's vocabulary.
 *
 * The payment domain (`./payment`) says what money DID. This file says what
 * Mercaria has noticed is WRONG with that record, and what an operator is
 * allowed to do about it.
 *
 * ## Why a discrepancy is a first-class kind rather than a severity plus a note
 *
 * Every value below names a distinct operator ACTION, which is the same test
 * `PaymentOutboxEventType`'s exception types are chosen by. A queue that
 * collapsed "the rail took money Mercaria never recorded" and "Mercaria's ledger
 * is missing a transaction it should have" into one `mismatch` kind with a free
 * text field would be a queue whose triage step is reading prose — and the first
 * thing anyone would build on top of it is the enumeration this file already is.
 *
 * ## Nothing here ever REPAIRS itself
 *
 * ADR 0001's operational appendix assigns discrepancy detection to the backend
 * and resolution to a person. A reconciliation sweep writes rows of these kinds
 * and stops; it never deletes, rewrites or hides financial history to make one
 * go away (issue #50, jobs 8). The one thing a sweep may do on its own is
 * CONVERGE a payment onto what the provider currently says, through the same
 * `applyPaymentStatus` a webhook uses — because a live provider read is verified
 * provider evidence, which is exactly the bar acceptance 5 sets and the
 * convergence ADR 0001's sequence 6 promises.
 */

/**
 * What a reconciliation sweep found.
 *
 * Read the pairs together: several of these come in a local-versus-provider
 * pair whose two halves have OPPOSITE resolutions, and collapsing a pair would
 * produce a queue in which the safe action and the dangerous one look alike.
 */
export type PaymentDiscrepancyKind =
  /**
   * The rail says the money arrived and Mercaria's payment does not.
   *
   * The recoverable half of the pair. A sweep re-reads the provider object and
   * applies what it says through `applyPaymentStatus`, so the ordinary outcome
   * is a row that is opened and resolved in the same run — the record of a
   * webhook that never arrived. It stays OPEN only when the payment cannot
   * legally reach the status the rail reports, which is the released-reservation
   * case `payment_succeeded_after_release` already raises.
   */
  | 'payment_provider_paid_local_unpaid'
  /**
   * Mercaria's payment says the money arrived and the rail does not.
   *
   * The dangerous half, and NOTHING automatic may touch it: orders have been
   * marked paid, inventory has been committed and sellers may already have been
   * transferred against a charge the rail does not believe in. Un-paying it
   * would be a second wrong on top of the first, so this is recorded and left
   * for a person.
   */
  | 'payment_local_paid_provider_unpaid'
  /**
   * A payment succeeded on a rail that books, and no `charge_succeeded` ledger
   * transaction exists for it.
   *
   * The ABSENCE case. The append-only trigger prevents a booked transaction
   * being edited away; nothing prevents one never being written, and under ADR
   * 0001 D3 the ledger is the sole record of commission — so a missing
   * transaction is revenue that exists nowhere.
   */
  | 'ledger_transaction_missing'
  /**
   * The global per-currency sum of every ledger entry is not zero.
   *
   * Should be structurally impossible: the repository refuses an unbalanced
   * transaction before issuing SQL and the trigger refuses an edit afterwards.
   * It is audited anyway because "impossible" and "nobody has checked" look
   * identical from outside, and this is the cheapest check in the whole file.
   */
  | 'ledger_unbalanced'
  /**
   * An order's `merchant_payable` does not net to zero and no exception explains
   * why.
   *
   * An open payable is ORDINARY when a transfer was withheld or a reversal
   * failed — those are recorded exceptions and the open balance is what they
   * MEAN in accounts. Unexplained, it is a seller who is owed money nobody is
   * tracking, or one who owes Mercaria money nobody is recovering.
   */
  | 'merchant_payable_unexplained';

/** {@link PaymentDiscrepancyKind} as the tuple the column type and CHECK read. */
export const PAYMENT_DISCREPANCY_KINDS: readonly PaymentDiscrepancyKind[] = [
  'payment_provider_paid_local_unpaid',
  'payment_local_paid_provider_unpaid',
  'ledger_transaction_missing',
  'ledger_unbalanced',
  'merchant_payable_unexplained',
];

/**
 * How loudly a discrepancy asks to be looked at.
 *
 * Three levels and not five, because the only decision a severity drives is how
 * soon somebody reads it: `critical` is money that is wrong now, `warning` is
 * money that will be wrong if nobody acts, `info` is a record kept because its
 * absence would be worse than its noise.
 */
export type PaymentDiscrepancySeverity = 'info' | 'warning' | 'critical';

/** {@link PaymentDiscrepancySeverity} as the tuple the column type and CHECK read. */
export const PAYMENT_DISCREPANCY_SEVERITIES: readonly PaymentDiscrepancySeverity[] = [
  'info',
  'warning',
  'critical',
];

/**
 * Where a discrepancy stands.
 *
 * `acknowledged` is a real state and not a courtesy: an operator who has read a
 * row and decided it needs watching rather than acting has made a decision, and
 * without somewhere to record it the only way to quieten a queue is to resolve
 * things that are not resolved.
 */
export type PaymentDiscrepancyStatus = 'open' | 'acknowledged' | 'resolved';

/** {@link PaymentDiscrepancyStatus} as the tuple the column type and CHECK read. */
export const PAYMENT_DISCREPANCY_STATUSES: readonly PaymentDiscrepancyStatus[] = [
  'open',
  'acknowledged',
  'resolved',
];

/**
 * The repairs an operator may run — a CLOSED set (issue #50, operator surface 6).
 *
 * A closed set rather than a scripting surface, and that is the whole security
 * property: every member below is a named path through code that already exists
 * and is already idempotent, so the operator surface adds a TRIGGER for it and
 * no new way to move money. An endpoint that took a table name and a patch would
 * be a second, unreviewed write path into the financial record — reachable by
 * whoever holds an operator credential, with none of the compare-and-swaps the
 * real paths carry.
 *
 * None of these can mark a payment successful (acceptance 5). The three retries
 * reach `payment.status` only through `applyPaymentStatus` fed by a live
 * provider response, and the fourth never touches it at all.
 */
export type PaymentRepairAction =
  /**
   * Re-attempt a transfer ADR 0001 D4 withheld because its seller had lost
   * readiness, or that a high-value hold is waiting on. The seller's STORED
   * account is consulted — the same row automatic settlement reads — and an
   * account that is not `ready` is refused rather than paid.
   */
  | 'retry_withheld_transfer'
  /**
   * Re-attempt the seller-side recovery of a refund or a lost dispute. The buyer
   * is not touched: ADR 0001 D7 is explicit that their refund is never undone,
   * and this only decides whether Mercaria has got its share back.
   */
  | 'retry_transfer_reversal'
  /**
   * Re-attempt a BUYER refund the rail refused after Mercaria committed and
   * restocked. Deliberately an operator action rather than a retry loop: a
   * declined refund declined for a reason, and re-issuing it is a decision about
   * which of two disagreeing records moves.
   */
  | 'retry_provider_refund'
  /**
   * Book a balanced correcting transaction, with a mandatory reason and a
   * mandatory discrepancy to attach it to.
   *
   * The ONLY way the operator surface writes the ledger, and it writes it the
   * one way the ledger permits: a NEW balanced `adjustment` transaction, never
   * an edit. Its entries are supplied by the operator and validated by the same
   * repository every other posting goes through, so an unbalanced correction is
   * refused rather than stored.
   */
  | 'book_reconciling_entry';

/** {@link PaymentRepairAction} as the tuple the column type and CHECK read. */
export const PAYMENT_REPAIR_ACTIONS: readonly PaymentRepairAction[] = [
  'retry_withheld_transfer',
  'retry_transfer_reversal',
  'retry_provider_refund',
  'book_reconciling_entry',
];

/**
 * What a repair attempt did.
 *
 * `no_op` is separated from `applied` because an operator running a repair twice
 * must be able to tell "it worked" from "it had already worked" — and `refused`
 * from both, since a refusal is the surface declining to act and is exactly what
 * the safety rules above produce.
 */
export type PaymentRepairOutcome = 'applied' | 'no_op' | 'refused';

/** {@link PaymentRepairOutcome} as the tuple the column type and CHECK read. */
export const PAYMENT_REPAIR_OUTCOMES: readonly PaymentRepairOutcome[] = [
  'applied',
  'no_op',
  'refused',
];

/**
 * The reconciliation jobs, each of which owns exactly one cursor row.
 *
 * The job name IS the cursor's primary key, which is what makes the cursor table
 * need no uniqueness of its own and makes a lease a plain compare-and-swap on a
 * known row (issue #50, jobs 7).
 *
 * ## `retail_reconciliation` shares the TABLE and not the RUNNER
 *
 * #128's cost reconciliation is the same shape of job — leased, bounded,
 * resumable, its findings deduped — so it takes a cursor row here rather than
 * growing a second lease mechanism to get wrong. What it cannot share is the
 * runner: it reads purchase orders and supplier invoices, and
 * `role-separation.test.ts` (#118) forbids anything under `services/payments/`
 * from importing the procurement domain. So it lives in
 * `services/retail-reconciliation/runner.ts` and claims only its own row, while
 * `services/payments/reconciliation/runner.ts` dispatches only the three it owns
 * and REFUSES any other job by name rather than falling through to one of them.
 */
export type ReconciliationJob =
  /** Open local payments against the rail's current state (jobs 1 and 4). */
  | 'open_payments'
  /** The ledger against itself and against the payments it describes (jobs 5). */
  | 'ledger_audit'
  /** Retail orders against their supplier and provider evidence (#128). */
  | 'retail_reconciliation'
  /**
   * Seller transfers held back for review, released once their window passes.
   *
   * The other half of `services/payments/high-value-hold.ts`, and it is not
   * optional: NOTHING else re-drives a settlement. `handleTransferWithheld`
   * records the exception and `handleProviderAccountChanged` only logs, so
   * before this job the single way out of a hold was an operator running the
   * `retry_withheld_transfer` repair. A hold with no releaser is a payout that
   * never arrives.
   */
  | 'withheld_transfers';

/** {@link ReconciliationJob} as the tuple the column type and CHECK read. */
export const RECONCILIATION_JOBS: readonly ReconciliationJob[] = [
  'open_payments',
  'ledger_audit',
  'retail_reconciliation',
  'withheld_transfers',
];

/**
 * The jobs `services/payments/reconciliation/runner.ts` owns.
 *
 * A strict subset of {@link RECONCILIATION_JOBS}, and the reason it is a value
 * rather than a list inside the runner is that the runner's dispatch must be
 * able to REFUSE a job it does not own. A dispatch written as a chain of `if`s
 * with a final fall-through silently runs the last job for every unrecognised
 * name — so adding a member above would have made the retail sweep run the
 * account-readiness one, with a clean log line and no error.
 */
export const PAYMENT_RECONCILIATION_JOBS: readonly ReconciliationJob[] = [
  'open_payments',
  'ledger_audit',
  'withheld_transfers',
];
