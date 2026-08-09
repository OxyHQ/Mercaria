/**
 * Columns That Must Not Reach a Client
 *
 * Mongoose has `select: false`; drizzle has nothing equivalent, because it
 * enumerates columns explicitly — and `db.select().from(table)` enumerates ALL
 * of them. So the guard has to be data plus a gate, decided once per table
 * rather than remembered at each call site.
 *
 * Read this registry through `publicColumns` from `@oxyhq/db/assert`:
 *
 *     db.select(publicColumns(orders, PROTECTED_COLUMNS)).from(orders)
 *
 * which withholds every registered column at RUNTIME and — because the registry
 * below is declared `as const` and never re-annotated with the
 * `ProtectedColumnRegistry` type — at the TYPE level too: the row type has no
 * such property, so a serializer that reads one fails `tsc` instead of shipping
 * it. Annotating this constant with `ProtectedColumnRegistry` would widen the
 * literal types away and silently drop that compile-time half (fail-closed: the
 * result collapses to no accessible columns rather than leaking), which is why
 * `satisfies` is used below and a type annotation must never be added.
 *
 * Opting in is deliberately unhelped: a path that legitimately needs a
 * protected column names it — `db.select({ id: orders.id, … })` — which reads
 * differently from an ordinary select and stays greppable.
 *
 * ## The keys are SQL table names; the values are TYPESCRIPT property names
 *
 * `publicColumns` looks the table up by `getTableName` (so `channel_api_keys`,
 * snake_case) and then filters `getTableColumns`, which is keyed by the drizzle
 * PROPERTY (so `keysP256dh`, camelCase). Mixing the two conventions up produces
 * no error at all — an unmatched key silently protects nothing — so both sides
 * are spelled in the convention their own lookup uses, and the test in
 * `__tests__/schema-conventions.test.ts` checks every entry resolves to a real
 * table and a real column.
 *
 * ## What is here, and the one deliberate omission
 *
 * Three kinds of column qualify: a live credential, an irreversible form of one,
 * and a person's contact details on a table an operator surface reads whole.
 *
 * `stores.notification_settings_*` was a Fase 0 candidate and is deliberately
 * NOT registered: it holds three booleans and a stock threshold, no secret, and
 * the dashboard renders all four to every member. Registering it would make the
 * registry read as "fields we felt cautious about" rather than "fields that leak
 * something", which is the distinction that keeps the list worth reading.
 */

import type { ProtectedColumnRegistry } from '@oxyhq/db/assert';

export const PROTECTED_COLUMNS = {
  /**
   * A POS walk-in's contact details. `customer.service` upserts these from what
   * a cashier types at the register, and the store customer list reads the table
   * whole — this is the single most likely accidental disclosure in the schema.
   */
  customers: ['email', 'phone'],

  /**
   * The payment provider's own transaction reference, snapshotted at checkout.
   * It identifies a real movement of money in Oxy Pay and is not the buyer's to
   * hold; nothing in any order DTO needs it.
   */
  orders: ['paymentReference'],

  /**
   * Both AES-GCM envelopes — the store's platform access token and its
   * per-connection inbound webhook secret. Already withheld from the serialized
   * `Connection` DTO by hand today; this makes it structural. All six columns,
   * because an `iv` and a `tag` are half of a decryption.
   */
  connections: [
    'credentialsCiphertext',
    'credentialsIv',
    'credentialsTag',
    'webhookSecretCiphertext',
    'webhookSecretIv',
    'webhookSecretTag',
  ],

  /**
   * The sha256 of an ingest key. Irreversible, and still protected: handing it
   * out hands an attacker an OFFLINE oracle to test guessed keys against, with
   * no rate limit and no log line. `prefix` stays public — it is the non-secret
   * display half, by design.
   */
  channel_api_keys: ['hash'],

  /** An Expo push token — possession of it is permission to push to that device. */
  push_tokens: ['token'],

  /** The Web Push subscription's encryption material; the pair IS the capability. */
  web_push_subscriptions: ['keysP256dh', 'keysAuth'],

  /** A contact address a reporter typed in, on a table an admin surface reads whole. */
  feedback: ['email'],

  /**
   * Operator working notes on a B2B counterparty — risk assessments,
   * negotiation detail, evidence pointers. Explicitly "hidden from public
   * DTOs" by #118, and the kind of commercially sensitive text a whole-row
   * read would ship first.
   */
  suppliers: ['internalNotes'],

  /** A supplier-side person's contact details — the `customers` precedent exactly. */
  supplier_contacts: ['email', 'phone'],

  /**
   * The secret-store PATH to a supplier account's credentials (ADR 0004 D6.5).
   * Not the secret itself — the CHECK on the column makes a pasted key
   * unstorable — but the pointer names the target of an attack and nothing
   * outside the adapter's credential resolver ever needs it. Reading it back
   * is an explicit, greppable opt-in.
   */
  supplier_accounts: ['credentialReference'],

  /**
   * The digest of a merchant-claim challenge token (#83). Irreversible, and
   * still protected for `channel_api_keys.hash`'s reason: handing it out hands
   * an attacker an OFFLINE oracle to test guessed tokens against, with no rate
   * limit and no log line. Nothing outside the verifier ever needs it.
   */
  merchant_claim_challenges: ['tokenHash'],

  /**
   * A claimant's private evidence (#83 security control 5): the business
   * document's Oxy file id, the URL it points at, and whatever a claimant or
   * reviewer wrote about it. Explicitly "outside public DTOs with restricted
   * access", and the kind of material a whole-row read would ship first.
   */
  merchant_claim_evidence: ['oxyFileId', 'url', 'note'],
} as const satisfies ProtectedColumnRegistry;
