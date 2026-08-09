/**
 * Reads and writes on `guest_checkouts` (ADR 0003 D4, #105).
 *
 * The row is created ONCE, inside the transaction that creates its checkout
 * group's orders, and is IMMUTABLE thereafter apart from the two transitions
 * the database itself permits: #108 moving the verification stage, and D15's
 * anonymization. That is why there is no `updateGuestCheckoutContact` here —
 * "create or update the pending record" resolves, under the layered idempotency
 * contract, to "create it, or converge on the one this group already has": a
 * replayed checkout converges on the SAME `checkout_group_id`, and reading the
 * existing contact is the correct answer, not overwriting it with whatever the
 * retry happened to carry.
 *
 * Like `guestSessionRepository`, this module knows nothing about plaintext: it
 * stores ciphertext and hashes a service produced, so a buyer's address cannot
 * end up in a query log.
 */

import { eq, inArray } from 'drizzle-orm';
import type { GuestContactVerificationStage } from '@mercaria/shared-types';
import { guestCheckouts } from '../schema/guests.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** A `guest_checkouts` row as the backend reads it. */
export type GuestCheckoutRow = typeof guestCheckouts.$inferSelect;

/** What the checkout transaction writes. */
export interface InsertGuestCheckoutInput {
  checkoutGroupId: string;
  /** Correlation only — the session is purged long before this row is. */
  guestSessionId: string;
  /** AES-256-GCM, key-id prefixed. */
  emailCiphertext: string;
  /** HMAC-SHA-256 of the NORMALIZED address. */
  emailHash: string;
  /** `j***@example.com`. The only form a support surface renders. */
  emailRedacted: string;
  phoneCiphertext?: string;
  phoneRedacted?: string;
  /** Separate from the purchase's own transactional permission. */
  marketingOptIn: boolean;
  locale?: string;
}

/**
 * Create the group's contact row, or converge on the one already there.
 *
 * `ON CONFLICT … DO NOTHING` plus a read, rather than `DO UPDATE`: a repeat is
 * a genuine no-op, for the same structural reason the moderation outbox's
 * enqueue is (see `AGENTS.md` §Testing). A `DO UPDATE` writing "the same
 * values" still moves `updated_at` and the row's `xmin`, and — far worse here —
 * would let a retry carrying a DIFFERENT email silently replace the contact a
 * placed order was made with, which is a change to an immutable commercial
 * record made through the back door of an idempotency path.
 *
 * The empty-vs-one-row `RETURNING` set IS the "already existed" answer, so a
 * real failure (a dropped connection, a CHECK violation) still propagates
 * instead of being read as a duplicate.
 */
export async function ensureGuestCheckout(
  db: DatabaseOrTransaction,
  input: InsertGuestCheckoutInput,
): Promise<GuestCheckoutRow> {
  const [inserted] = await db
    .insert(guestCheckouts)
    .values({
      checkoutGroupId: input.checkoutGroupId,
      guestSessionId: input.guestSessionId,
      emailCiphertext: input.emailCiphertext,
      emailHash: input.emailHash,
      emailRedacted: input.emailRedacted,
      phoneCiphertext: input.phoneCiphertext ?? null,
      phoneRedacted: input.phoneRedacted ?? null,
      marketingOptIn: input.marketingOptIn,
      locale: input.locale ?? null,
    })
    .onConflictDoNothing({ target: guestCheckouts.checkoutGroupId })
    .returning();
  if (inserted) return inserted;

  const existing = await findGuestCheckoutByGroup(db, input.checkoutGroupId);
  if (!existing) {
    // The conflict target and the lookup name the same unique index, so an
    // empty insert with no row behind it means the row was deleted between the
    // two statements — which nothing in this codebase does. Naming it beats
    // returning a fabricated row.
    throw new Error('guest_checkouts conflicted on a group that does not exist');
  }
  return existing;
}

/**
 * The group's contact row, if it has one.
 *
 * Every column is NAMED, including the three protected ones, and that is the
 * opt-in `db/protectedColumns.ts` describes: a path that legitimately needs a
 * protected column spells it out, which reads differently from an ordinary
 * select and stays greppable. This path needs them because it is the read
 * behind the transactional mail (#108 decrypts `email_ciphertext`) and behind
 * #108's magic-link routing (`email_hash`) — but no PROJECTION built from this
 * row carries either: `toGuestContactSummary` names its own fields, and the
 * summary has none for a ciphertext or a hash.
 */
export async function findGuestCheckoutByGroup(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
): Promise<GuestCheckoutRow | null> {
  const [row] = await db
    .select({
      id: guestCheckouts.id,
      checkoutGroupId: guestCheckouts.checkoutGroupId,
      guestSessionId: guestCheckouts.guestSessionId,
      emailCiphertext: guestCheckouts.emailCiphertext,
      emailHash: guestCheckouts.emailHash,
      emailRedacted: guestCheckouts.emailRedacted,
      phoneCiphertext: guestCheckouts.phoneCiphertext,
      phoneRedacted: guestCheckouts.phoneRedacted,
      contactVerificationStage: guestCheckouts.contactVerificationStage,
      contactVerifiedAt: guestCheckouts.contactVerifiedAt,
      contactPolicyVersion: guestCheckouts.contactPolicyVersion,
      marketingOptIn: guestCheckouts.marketingOptIn,
      locale: guestCheckouts.locale,
      anonymizedAt: guestCheckouts.anonymizedAt,
      createdAt: guestCheckouts.createdAt,
      updatedAt: guestCheckouts.updatedAt,
    })
    .from(guestCheckouts)
    .where(eq(guestCheckouts.checkoutGroupId, checkoutGroupId))
    .limit(1);
  return row ?? null;
}

/**
 * The DISPLAY half of a guest contact — every column except the three protected
 * ones (#106 contact rules 2, 3 and 6).
 *
 * A separate row type rather than a filtered {@link GuestCheckoutRow}, and the
 * difference is the whole point: `findGuestCheckoutByGroup` above NAMES the
 * ciphertext and the hash because #108's mail and routing genuinely need them,
 * and that naming is the greppable opt-in `db/protectedColumns.ts` describes.
 * The hydration path needs none of it, so the shape it reads has no property to
 * carry one — a projection that reached for a hash would fail `tsc`.
 */
export interface GuestContactDisplayRow {
  readonly id: string;
  readonly emailRedacted: string;
  readonly phoneRedacted: string | null;
  readonly contactVerificationStage: GuestContactVerificationStage;
  readonly contactVerifiedAt: Date | null;
  readonly contactPolicyVersion: string;
  readonly marketingOptIn: boolean;
  readonly anonymizedAt: Date | null;
}

/**
 * The display contact for a BATCH of guest checkouts, keyed by row id.
 *
 * One statement for a whole page of orders, the `withChildren` discipline: a
 * per-order lookup would put an N+1 on the buyer's own order list, which is the
 * page a guest opens most.
 */
export async function findGuestContactsByIds(
  db: DatabaseOrTransaction,
  ids: readonly string[],
): Promise<Map<string, GuestContactDisplayRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: guestCheckouts.id,
      emailRedacted: guestCheckouts.emailRedacted,
      phoneRedacted: guestCheckouts.phoneRedacted,
      contactVerificationStage: guestCheckouts.contactVerificationStage,
      contactVerifiedAt: guestCheckouts.contactVerifiedAt,
      contactPolicyVersion: guestCheckouts.contactPolicyVersion,
      marketingOptIn: guestCheckouts.marketingOptIn,
      anonymizedAt: guestCheckouts.anonymizedAt,
    })
    .from(guestCheckouts)
    .where(inArray(guestCheckouts.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Move a contact's verification stage (#108's seam).
 *
 * Exported now, with no caller in #105, deliberately: the COLUMN exists because
 * #105 records the stage at creation, and leaving the only writer of it to be
 * invented later is how two writers appear. The mutation is one conditional
 * statement, the `CONVENTIONS.md` concurrency rule.
 */
export async function setGuestCheckoutVerificationStage(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
  stage: GuestContactVerificationStage,
  verifiedAt: Date | null,
): Promise<GuestCheckoutRow | null> {
  const [row] = await db
    .update(guestCheckouts)
    // The stage and its INSTANT move together, because
    // `guest_checkouts_contact_verified_at_check` is a biconditional: a
    // non-pending stage with no instant is refused, and so is an instant on a
    // `pending` row. Passing the timestamp explicitly rather than defaulting it
    // to `now()` here keeps #108's magic-link exchange the thing that decides
    // WHEN the inbox was proven — which is the moment the link was consumed,
    // not the moment this statement ran.
    .set({ contactVerificationStage: stage, contactVerifiedAt: verifiedAt })
    .where(eq(guestCheckouts.checkoutGroupId, checkoutGroupId))
    .returning();
  return row ?? null;
}
