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
   * The guest SESSION that drove a lifecycle transition (ADR 0003 D16, #106).
   *
   * A guest identifier on a table every order DTO reads WHOLE — `withChildren`
   * attaches the status trail to each order and `order-hydration` serializes
   * every event — so this is the `customers.email` situation exactly: the most
   * likely accidental disclosure is the one nobody has to write a line of code
   * to cause. #106 buyer-model rule 7 says seller-facing hydration cannot
   * expose a guest security identifier, and invariant I11 says a seller API
   * must not be able to CORRELATE two of a guest's purchases; a session row id
   * shared across a guest's orders is precisely such a correlation key.
   *
   * It authorizes nothing on its own (possession of the TOKEN is what
   * authorizes a guest, and no path leads from this id back to one), which is
   * why the operator surface may name it explicitly. `actor_kind` is
   * deliberately NOT registered: it says a guest acted without saying WHICH,
   * and the audit trail is useless without it.
   */
  order_status_history: ['actorGuestSessionId'],

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

  /**
   * A guest buyer's contact, in both of the forms that are not for display
   * (ADR 0003 D12, #105 privacy rule 7).
   *
   * `email_ciphertext` and `phone_ciphertext` are reversible with a key the
   * process holds, so a whole-row read is a plaintext disclosure one
   * `decryptGuestPii` away. `email_hash` is registered for a DIFFERENT reason
   * and it is the one worth stating: it is irreversible, and it is still an
   * exact-match ORACLE — anyone holding it can confirm whether a guessed
   * address placed an order, which is the correlation ADR 0003 I11 says seller
   * and partner surfaces must not be able to perform. It is also never
   * legitimately client-facing: its two permitted uses (#108 routing, abuse
   * counting) both happen inside the backend.
   *
   * `email_redacted` and `phone_redacted` are deliberately NOT registered —
   * they are the support-surface display form (T15) and exist precisely to be
   * read.
   */
  guest_checkouts: ['emailCiphertext', 'emailHash', 'phoneCiphertext'],

  /**
   * The rotating salt every pseudonymous analytics session id is derived under
   * (#77 data-lifecycle rule 7).
   *
   * A LIVE secret, and the most consequential one in this registry despite
   * looking like a housekeeping column: possession of the current epoch's salt
   * turns every `analytics_events.pseudonymous_session_id` of that epoch back
   * into the session handle it was derived from, which is precisely the
   * re-identification the rotation exists to make impossible. The operator
   * surface reads these rows for their epoch and window; nothing anywhere needs
   * the value except the derivation itself.
   */
  analytics_pseudonym_salts: ['salt'],

  /**
   * A supplier preflight's request digest and its raw-answer pointer (#122
   * quote fields 1 and 6).
   *
   * `request_fingerprint` and `idempotency_key` (which defaults to it) are
   * HMACs over a request that INCLUDES the buyer's destination — postal code
   * and city among it — so anyone holding one plus the key can confirm whether
   * a guessed address was quoted for. That is `guest_checkouts.email_hash`'s
   * situation exactly: irreversible and still an exact-match ORACLE, and the
   * whole reason this domain stores no postal code is defeated if the value
   * that stands in for one ships in a whole-row read.
   *
   * `source_record_ref` points into the restricted-access store holding what
   * the provider actually sent. The pointer is not the payload, but handing it
   * out hands out the way to ask for the payload, with none of the
   * authorization the operator surface applies.
   */
  supplier_quotes: ['requestFingerprint', 'idempotencyKey', 'sourceRecordRef'],

  /**
   * The same digest on the sourcing trail (#122 selection 7). One attempt row
   * per candidate tried, keyed on the request it was sourcing — so the oracle
   * above is reachable through this table too unless it is registered here.
   */
  supplier_sourcing_attempts: ['requestFingerprint'],

  /**
   * The SUPPLIER's own reservation id (#122 acceptance 3).
   *
   * A live handle on a commitment somebody else is holding: presenting it to
   * that supplier's API cancels the hold. `supplier_accounts.credential_reference`
   * is the neighbouring case and this is the weaker one only in that the damage
   * is bounded to one order — it is still a capability in a column, and the
   * operator trace deliberately renders it as its last four characters
   * (`provider_accounts`' account-id rule) rather than whole.
   */
  supplier_reservations: ['providerReservationId'],

  /**
   * The digest of a guest portal credential — the `mgx_` exchange token or the
   * `mgp_` portal credential (#108, ADR 0003 D5).
   *
   * `merchant_claim_challenges.token_hash` exactly, and the consequence is
   * larger: this digest stands for a credential that reads a placed order's
   * lines, totals and shipping address. Handing it out hands an attacker an
   * OFFLINE oracle to test guessed tokens against with no rate limit and no log
   * line — and the portal's own projection (`GuestPortalSessionState`) has no
   * field it could arrive in, so registering it here closes the whole-row route
   * that a projection cannot.
   */
  guest_order_access_grants: ['tokenHash'],

  /**
   * The keyed digest of a suppressed inbox (#108 privacy rule 5).
   *
   * `guest_checkouts.email_hash`'s reasoning, on a table whose whole purpose is
   * to be queried by that value: irreversible and still an exact-match ORACLE,
   * so anyone holding it can confirm whether a guessed address stopped
   * receiving Mercaria's mail — which is a fact about a person's relationship
   * with this marketplace that no client is owed.
   */
  guest_contact_suppressions: ['emailHash'],

  /**
   * The keyed digest a recovery throttle counts against (#108 recovery rule 2).
   *
   * The same oracle one axis wider: the subject is an email hash, an order
   * number or a coarse network prefix depending on the row, and any of the
   * three confirms a guess. The counters themselves are the only thing an
   * operator ever needs, and the operator surface exposes none of these rows at
   * all — the registration is what stops a future diagnostic from shipping one
   * by reading the table whole.
   */
  guest_recovery_attempts: ['subjectHash'],
} as const satisfies ProtectedColumnRegistry;
