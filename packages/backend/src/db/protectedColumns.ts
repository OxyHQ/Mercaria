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

  /**
   * Who a buyer's support message and buyer-request audit event actually was
   * (#110 merchant rule 8, support rule 6).
   *
   * `order_status_history.actor_guest_session_id`'s reasoning, applied to a
   * surface that BOTH sides read. `support_messages` is serialized to the
   * seller and to the buyer from one repository, so a plain `select()` would
   * put the buyer's Oxy account id in the seller's response and the seller's
   * staff account id in the buyer's — neither of which either party is owed,
   * and the buyer half is exactly the correlation key #106 spends a column
   * keeping out of a merchant projection.
   *
   * `author_grant_id` is a PORTAL grant id. #108 establishes that a grant id
   * authorizes nothing and is safe in an operator trace, and that is precisely
   * why it is protected HERE and not there: it is stable across every message a
   * buyer writes from one credential, so a merchant holding it can tell two
   * conversations came from one device. The audit needs it; a projection does
   * not.
   *
   * The KINDs beside them are deliberately NOT protected — `buyer` and `guest`
   * say somebody acted without saying who, which is what a timeline needs.
   */
  support_messages: ['authorOxyUserId', 'authorGrantId'],

  /** The same two facts on the shared request audit trail. See above. */
  buyer_request_events: ['actorOxyUserId', 'actorGrantId'],

  /**
   * The portal grant that authorized a buyer's request (#110 cancellation
   * field 6, "access-session audit").
   *
   * Recorded because the audit has to say which credential filed a
   * cancellation, and protected because the merchant queue reads these rows: a
   * seller who could see it would be able to group a buyer's requests across
   * orders by device, which is the correlation the whole portal design refuses.
   * `requested_by_oxy_user_id` joins it because a merchant must not be able to
   * tell a claimed guest order's requester from an account holder's — merchant
   * rule 7, and the reason the merchant projection's label is the literal
   * `Buyer`.
   */
  cancellation_requests: ['requestedByGrantId', 'requestedByOxyUserId'],

  /** The same pair on return requests. See above. */
  return_requests: ['requestedByGrantId', 'requestedByOxyUserId'],

  /**
   * The digest of what was actually SENT to a supplier (#124 idempotency 8).
   *
   * `supplier_quotes.request_fingerprint`'s situation, one step worse: a
   * preflight request carries a country and a postal code, while a SUBMISSION
   * carries the recipient's name, street and phone number — so the sha-256 over
   * it is an exact-match oracle over a specific person's home address. Anyone
   * holding the hash plus a guess can confirm the guess.
   *
   * It exists because #124 requires persisting what was sent before
   * acknowledging, so a second attempt that differs is visible rather than
   * silently overwriting the first. Storing the request itself would put the
   * address in a second table beside `purchase_orders`' one snapshot, which is
   * the duplication the destination's redaction-by-shape exists to avoid.
   */
  supplier_order_attempts: ['requestHash'],

  /**
   * A stored provider event's own id and its content digest (#124 polling and
   * webhooks 3).
   *
   * `provider_event_id` is a live handle in the supplier's key space: several
   * fulfilment APIs will replay an event, or answer questions about an order,
   * to whoever presents one. `content_hash` is the digest of the normalized
   * observation, which includes the tracking numbers and the provider order id
   * — an oracle over the same facts the summary is redacted to withhold.
   */
  supplier_provider_events: ['providerEventId', 'contentHash'],

  /**
   * A feed's authenticated download URL and its encrypted credential (#63
   * security 5).
   *
   * `auth_ciphertext` is the obvious half — an AES-256-GCM envelope, the
   * `connections` situation exactly. `feed_url` is the half that surprises
   * people and is the reason this entry exists: the affiliate networks that
   * matter carry the key IN the URL (Awin's product-feed download is
   * `.../datafeed/list/apikey/<KEY>`, and several others use a query
   * parameter), so a feed URL in this domain is a credential wearing a
   * hostname. It is not a value a store member typed once and may read back —
   * it is a bearer capability shared with everyone who can read the row, which
   * is why every projection emits `redactFeedUrl`'s output and the fetcher
   * names the column explicitly.
   */
  feed_configuration_versions: ['feedUrl', 'authCiphertext'],

  /**
   * The source's own handle for a delivery statement (#126 privacy 11).
   *
   * `source_ref` holds a #122 supplier-quote id on a supplier observation and a
   * Moovo transport id on a logistics one. Neither is the buyer's to see: the
   * first is a procurement handle in the same key space `supplier_quote_ref` is
   * already protected in, and the second identifies a movement in another Oxy
   * service to whoever presents it. The promise itself — the window, the basis,
   * when it was observed — is exactly what a buyer SHOULD see, which is why the
   * protection is on this one column and not on the row.
   */
  retail_delivery_promises: ['sourceRef'],

  /**
   * Mercaria's application-scoped handle for one fulfilment intent, and Moovo's
   * own transport id (#126 privacy 9).
   *
   * `moovo_source_reference` is what an inbound Moovo event resolves against.
   * It authorizes nothing on its own — the resolution is an exact-match lookup
   * that returns one intent or none — but it is the ONE value that, presented
   * to Moovo, names a specific Mercaria fulfilment, and a buyer-facing DTO
   * carrying one hands every reader a cross-service correlation key for
   * somebody else's parcel. `moovo_transport_request_id` is the same fact from
   * the other side.
   *
   * The tracking a buyer legitimately sees comes from Moovo's own safe
   * presentation (#126 privacy 7, #162), never from either of these.
   */
  retail_fulfilment_intents: ['moovoSourceReference', 'moovoTransportRequestId'],

  /**
   * A watchlist item's PRIVATE note (#81 model rule 9, privacy rules 2 and 4).
   *
   * This is the `customers.email` situation exactly: the basket evaluation reads
   * `watchlist_items` WHOLE — it needs the quantity, the preferences and the
   * product on every row — and then writes a `watchlist_snapshot_items` row from
   * what it read. A `select()` plus a spread is all it would take for a person's
   * free text to land in a durable table nobody scoped to them, and #81 says
   * merchants receive thresholded aggregates and never notes, and that notes
   * never enter analytics.
   *
   * The owner's own list projection names it explicitly, which is what the
   * registry's opt-in is for: that read is the one place a note is legitimately
   * returned, and it reads differently from an ordinary select.
   */
  watchlist_items: ['note'],
} as const satisfies ProtectedColumnRegistry;
