/**
 * The evidence digest — the convergence key of a reconciliation REVISION. PURE.
 *
 * Evidence arrives over weeks and the sweep re-reads an order many times, so the
 * question every pass has to answer is "has anything I depend on changed since
 * the last revision". This is that answer: a sha-256 over a canonical
 * serialization of exactly the evidence the equation consumed. Equal digest, no
 * new revision.
 *
 * ## Determinism is the whole contract, and it is the moderation-envelope rule
 *
 * Nothing here may vary between two digests of one evidence set. So: records are
 * SORTED by `(kind, reference)` rather than trusted in query order; every number
 * is serialized as a string; an absent optional serializes as the empty string,
 * which is a value rather than a hole; and **the clock is never read**.
 *
 * That last one is the load-bearing part and the easy mistake. A digest that
 * included the computation time — or a `lastSeenAt`, or a sweep run id — would
 * differ on every pass, so every tick would write a revision, every order would
 * accumulate one per minute, and the "exactly one customer adjustment
 * obligation" a unique index gives us would become one obligation per tick with
 * every earlier one superseded. `observedAt` IS included, because it is a fact
 * about the RECORD and not about the reading of it: a supplier reissuing an
 * invoice with a later date is a genuinely different piece of evidence.
 *
 * ## The tolerance and the policy version are in the preimage
 *
 * They are not evidence, but they change the ANSWER, and a revision whose
 * verdict differs from its predecessor's while its digest matches would be a
 * verdict nobody could reproduce. Including them means activating a new policy
 * version re-reconciles every open order exactly once.
 */

import { createHash } from 'node:crypto';
import type { CurrencyCode, RetailReconciliationEvidenceKind } from '@mercaria/shared-types';

/** One authoritative record the equation read. */
export interface EvidenceDigestRecord {
  kind: RetailReconciliationEvidenceKind;
  /** The durable id of the record — a Mercaria id, or a provider's own reference. */
  reference: string;
  /** What it stated, in ITS own currency. Absent when the record states no amount. */
  amountMinor?: number;
  currency?: CurrencyCode;
  /** When the record was created or observed. NEVER when the sweep read it. */
  observedAt: Date;
}

/** Everything a revision's identity is composed from. */
export interface EvidenceDigestInput {
  orderId: string;
  policyKey: string;
  policyVersion: number;
  accountingCurrency: CurrencyCode;
  toleranceMinor: number;
  records: readonly EvidenceDigestRecord[];
  /**
   * The conditions that blocked the verdict, if any.
   *
   * In the preimage because "the invoice is still missing" and "the invoice
   * arrived" are different states of one order that can otherwise share an
   * evidence set: the first has one record fewer, but so does an order whose
   * supplier simply charged no handling fee. Without this, resolving a block
   * would sometimes fail to produce a new revision.
   */
  blockedBy: readonly string[];
}

/**
 * The two preimage separators, written as ESCAPES and never as raw bytes.
 *
 * `\0` separates fields and `\x01` separates records; neither can appear in any
 * input, which is what makes the serialization unambiguous.
 *
 * They are escapes because a raw control byte in a source file makes it BINARY
 * to git: `file` reports `data`, a diff renders as `Bin 0 -> N bytes` instead of
 * lines, nobody can read the file in a review, and a later rebase loses
 * line-level conflict resolution and falls back to whole-file ours/theirs. That
 * matters most in this file of all of them, because this is what makes "equal
 * digest, no new revision" true — and that is what keeps "exactly one customer
 * adjustment obligation" from becoming one obligation per sweep tick. An escape
 * and a raw byte are the same character at runtime, so every stored digest is
 * unchanged.
 */
const FIELD = '\0';
const RECORD = '\x01';

/** One record, canonically. Sorted into place by the caller below. */
function serializeRecord(record: EvidenceDigestRecord): string {
  return [
    record.kind,
    record.reference,
    record.amountMinor === undefined ? '' : String(record.amountMinor),
    record.currency ?? '',
    // An ISO-8601 instant at millisecond precision. `Date` prints the same
    // string for one instant on every platform, which `toString()` does not.
    record.observedAt.toISOString(),
  ].join(FIELD);
}

/**
 * The canonical preimage. Exported so a test can read what is hashed rather
 * than only whether two hashes agree — a digest test that compares two opaque
 * strings passes just as well when both are of the empty string.
 */
export function serializeReconciliationEvidence(input: EvidenceDigestInput): string {
  const records = input.records
    .map(serializeRecord)
    // Sorted by the SERIALIZED form, so the ordering is over `(kind, reference,
    // …)` without a comparator that could disagree with the fields it reads.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(RECORD);

  return [
    input.orderId,
    input.policyKey,
    String(input.policyVersion),
    input.accountingCurrency,
    String(input.toleranceMinor),
    [...input.blockedBy].sort().join(','),
    records,
  ].join(FIELD);
}

/** The digest itself — 64 lower-case hex characters, as the CHECK requires. */
export function reconciliationEvidenceDigest(input: EvidenceDigestInput): string {
  return createHash('sha256').update(serializeReconciliationEvidence(input), 'utf8').digest('hex');
}
