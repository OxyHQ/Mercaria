/**
 * The buyer-request column allow-list and its deny-list (#110).
 *
 * `db/schema/buyerRequests.ts` states the domain's privacy property in one
 * paragraph: **no email in any form, no phone, no postal address, no email
 * hash, no guest session id, no payment-method detail, no card fingerprint and
 * no IP address.** A request is identified by its ORDER; the contact it would
 * be answered to is one join away on `guest_checkouts` and is read only by the
 * send path.
 *
 * That paragraph then said `BUYER_REQUEST_FORBIDDEN_IDENTIFIERS` "names the
 * prohibition as a value and `buyer-request-forbidden-columns.test.ts` walks
 * these tables against it."
 *
 * **That file did not exist** (#354). Nothing walked those tables, and the only
 * assertion on the constant anywhere was `length >= 10` in
 * `buyer-request-isolation.test.ts` — a floor on the LIST, which says nothing
 * about any column. A described gate is worse than an absent one: an absent one
 * invites a reviewer to look, and a described one persuades them not to.
 *
 * So this is the gate, built rather than the sentence deleted, and built as an
 * ALLOW-LIST: every column of every one of the eight tables is enumerated here
 * with a REASON, and **anything not enumerated fails the build until somebody
 * decides it is allowed.** A deny-list is correct only until somebody adds a
 * field, and the field that leaks is by definition the one nobody was thinking
 * about — `recipient_name`, `delivery_postcode` and `contact_email` match not
 * one of the constant's ten entries.
 *
 * The shape is #352's
 * (`services/analytics/__tests__/analytics-column-allowlist.ts`); the machinery
 * is `db/__tests__/column-allowlist.ts`.
 *
 * ## What this gate does NOT claim
 *
 * It is about COLUMNS. Several columns here hold free text somebody typed —
 * `note`, `decision_note`, `return_instructions`, `detail`, and
 * `support_messages.body` — and a buyer can type an email address into any of
 * them. That is a CONTENT question, and it is `services/buyer-requests/
 * redaction.ts`'s. Reading this gate as covering it is the mistake it exists to
 * make harder, so it is written down rather than left to be assumed.
 */

import type { ColumnExemption, ColumnProhibition, TableAllowance } from '../../db/__tests__/column-allowlist.js';

/**
 * The three column shapes that repeat across this domain, spelled once.
 *
 * A requester triple, a decider triple and a completion group appear on both
 * request tables with identical meaning. Writing the reason twice is how the
 * two drift.
 */
const REQUESTER_REASON =
  'The requester as a KIND plus at most one identifier, mirroring `order_status_history` (ADR 0003 D16): a guest session id has no Oxy-shaped column to arrive in, so "a guest acted" is recordable without saying which guest. `requested_by_grant_id` names the #108 portal grant that authorized it — an audit handle that authorizes nothing, `ON DELETE SET NULL` because the retention sweep purges grants at 90 days.';

const DECIDER_REASON =
  'The decider triple and what they said, in the same shape as the requester. A decision note is free text a merchant or operator wrote; it is not a place to put a buyer.';

const COMPLETION_REASON =
  'What happened when the decision was carried out: the refund row those services wrote (a POINTER, never a copy of what it says), when it completed, and a bounded failure code if it did not. There is no `failed` state — a completion that did not complete stays `accepted` and the retry is the same idempotent call.';

const IDENTITY_REASON =
  'The row and the order it is about, with its timestamps. The order is the whole of the identity: there is deliberately no `guest_checkout_id` here, because `orders` already carries one and a stale copy would outlive the ADR 0003 D15 erasure that removed the contact.';

const LINE_REASON =
  'Which variant and how many units. `requested_quantity` is frozen by trigger and only `approved_quantity` moves, because the approved quantity is the only one the refund reads.';

/** Every column of every table in `db/schema/buyerRequests.ts`. */
export const BUYER_REQUEST_COLUMN_ALLOWLIST: readonly TableAllowance[] = [
  {
    table: 'cancellation_requests',
    groups: [
      { reason: IDENTITY_REASON, columns: ['id', 'order_id', 'created_at', 'updated_at'] },
      {
        reason:
          'What was asked for: the lifecycle state, a bounded reason code, the buyer\'s own note, and whether the whole order was meant. A cancellation refunds delivery, which is why `whole_order` is a stored fact rather than derived from the lines.',
        columns: ['state', 'reason', 'note', 'whole_order'],
      },
      {
        reason: REQUESTER_REASON,
        columns: ['requested_by_actor_kind', 'requested_by_oxy_user_id', 'requested_by_grant_id'],
      },
      {
        reason: DECIDER_REASON,
        columns: ['decided_by_actor_kind', 'decided_by_oxy_user_id', 'decided_at', 'decision_note'],
      },
      {
        reason: COMPLETION_REASON,
        columns: ['completion_mode', 'refund_id', 'completed_at', 'completion_failure'],
      },
      {
        reason:
          'The convergence key. One client\'s retry after its request was decided converges here; two concurrent racers converge on the partial unique over the OPEN states instead, and neither index covers the other.',
        columns: ['idempotency_key'],
      },
    ],
  },
  {
    table: 'cancellation_request_lines',
    groups: [
      {
        reason: LINE_REASON,
        columns: [
          'id',
          'request_id',
          'variant_id',
          'requested_quantity',
          'approved_quantity',
          'created_at',
          'updated_at',
        ],
      },
    ],
  },
  {
    table: 'return_requests',
    groups: [
      { reason: IDENTITY_REASON, columns: ['id', 'order_id', 'created_at', 'updated_at'] },
      {
        reason:
          'What was asked for and what shape of answer it wants: the lifecycle state, a bounded reason code, the requested resolution, and the buyer\'s own note. `replacement` is representable and refused at submit, which is why the resolution is stored rather than assumed.',
        columns: ['state', 'reason', 'resolution', 'note'],
      },
      {
        reason: REQUESTER_REASON,
        columns: ['requested_by_actor_kind', 'requested_by_oxy_user_id', 'requested_by_grant_id'],
      },
      {
        reason: DECIDER_REASON,
        columns: ['decided_by_actor_kind', 'decided_by_oxy_user_id', 'decided_at', 'decision_note'],
      },
      {
        reason:
          'How the goods come back: instructions the merchant wrote, the window the buyer has, the deadline to send it, and when it ARRIVED. `received_at` is why `received` is a state at all — a return cannot restock at approval, because the units are still in a parcel. No carrier, tracking or label column: return transport is Moovo\'s (#159).',
        columns: [
          'return_instructions',
          'return_window_ends_at',
          'ship_back_deadline_at',
          'received_at',
        ],
      },
      {
        reason: COMPLETION_REASON,
        columns: ['refund_id', 'completed_at', 'completion_failure'],
      },
      {
        reason:
          'The convergence key, as on `cancellation_requests` and for the same two-index reason.',
        columns: ['idempotency_key'],
      },
    ],
  },
  {
    table: 'return_request_lines',
    groups: [
      {
        reason: LINE_REASON,
        columns: [
          'id',
          'request_id',
          'variant_id',
          'requested_quantity',
          'approved_quantity',
          'created_at',
          'updated_at',
        ],
      },
    ],
  },
  {
    table: 'return_request_evidence',
    groups: [
      {
        reason:
          'A bare Oxy `file_id`, its kind and its position — the `abuse_reports` posture, one provenance channel and no second upload path. There is deliberately no digest column: #110 rule 5 asks for malware scanning Mercaria has none of, and the gap is stated rather than faked with a field nothing fills.',
        columns: ['id', 'request_id', 'file_id', 'kind', 'position', 'created_at'],
      },
    ],
  },
  {
    table: 'support_threads',
    groups: [
      {
        reason:
          'A thread hangs off an ORDER, optionally beside the return it is about, with its state and when it closed. The order is the whole of the identity here too — a thread is never addressed by an email, a phone number or a reference somebody could quote over the telephone.',
        columns: [
          'id',
          'order_id',
          'return_request_id',
          'state',
          'closed_at',
          'created_at',
          'updated_at',
        ],
      },
    ],
  },
  {
    table: 'support_messages',
    groups: [
      {
        reason:
          'Who wrote it, as the same actor triple every other table uses, and when. Append-only against UPDATE and DELETE, with a RESTRICT foreign key so the trail cannot be removed by removing its parent.',
        columns: [
          'id',
          'thread_id',
          'author_kind',
          'author_oxy_user_id',
          'author_grant_id',
          'created_at',
        ],
      },
      {
        reason:
          'The message itself and what was redacted out of it. `body` is free text somebody typed, so what keeps an email address out of it is `services/buyer-requests/redaction.ts` at the write, not this gate — this gate only guarantees no COLUMN invites one. There are no attachments: #110 rule 5 asks for scanning Mercaria does not have.',
        columns: ['body', 'redactions'],
      },
    ],
  },
  {
    table: 'buyer_request_events',
    groups: [
      {
        reason:
          'The shared append-only trail: which request it belongs to (exactly one of the two, by CHECK), what happened, and when it happened as distinct from when the row was written.',
        columns: [
          'id',
          'cancellation_request_id',
          'return_request_id',
          'kind',
          'detail',
          'at',
          'created_at',
        ],
      },
      {
        reason:
          'The actor triple again. `actor_kind` says a guest acted without saying which; the grant id is an audit handle. Neither is a correlation key a merchant response could carry, because the repository selects an explicit column list rather than the row.',
        columns: ['actor_kind', 'actor_oxy_user_id', 'actor_grant_id'],
      },
    ],
  },
];

/**
 * The second layer: names that may never be admitted, whichever side names
 * them.
 *
 * DELIBERATELY BROADER THAN `BUYER_REQUEST_FORBIDDEN_IDENTIFIERS`, and that is
 * the point. The constant names ten exact handles; a leak arrives under a
 * neighbouring name, so `buyer_email` is refused by a prohibition on `email`
 * rather than on `buyer_email`, and `contact_email`, `reply_to_email` and
 * `notification_email` are refused with it. Every one of the constant's ten
 * entries is still asserted refused by this list — that assertion is what makes
 * the schema docblock's claim true, and it is in the gate rather than here.
 *
 * No entry is redundant: the gate asserts that removing any one of them lets
 * its own name through, so a prohibition that another already covers is a build
 * failure rather than a line that reads as protection and is not.
 */
export const BUYER_REQUEST_FORBIDDEN_COLUMN_SEGMENTS: readonly ColumnProhibition[] = [
  { segments: ['email'], prohibition: 'an email address, in any form' },
  { segments: ['phone'], prohibition: 'a phone number' },
  { segments: ['address'], prohibition: 'a postal address' },
  { segments: ['postal'], prohibition: 'a postal address' },
  { segments: ['postcode'], prohibition: 'a postal address' },
  { segments: ['zip'], prohibition: 'a postal address' },
  { segments: ['city'], prohibition: 'a postal address' },
  { segments: ['country'], prohibition: 'a postal address' },
  { segments: ['recipient'], prohibition: 'a named recipient' },
  { segments: ['name'], prohibition: 'a personal name' },
  { segments: ['ip'], prohibition: 'a network address' },
  { segments: ['user', 'agent'], prohibition: 'a device fingerprint' },
  { segments: ['device'], prohibition: 'a device fingerprint' },
  { segments: ['fingerprint'], prohibition: 'a device or payment-method fingerprint' },
  { segments: ['card'], prohibition: 'payment-method detail' },
  { segments: ['payment', 'method'], prohibition: 'payment-method detail' },
  { segments: ['iban'], prohibition: 'payment-method detail' },
  { segments: ['stripe'], prohibition: 'a payment-provider handle' },
  { segments: ['customer'], prohibition: 'a payment-provider handle' },
  { segments: ['session'], prohibition: 'a session handle — a cart token is not order access' },
  { segments: ['token'], prohibition: 'a bearer credential' },
  { segments: ['secret'], prohibition: 'a bearer credential' },
  { segments: ['password'], prohibition: 'a bearer credential' },
  {
    segments: ['hash'],
    prohibition: 'a keyed digest, which is an exact-match ORACLE and not merely irreversible',
  },
  { segments: ['order', 'number'], prohibition: 'an order number used as a handle' },
  { segments: ['latitude'], prohibition: 'a location' },
  { segments: ['longitude'], prohibition: 'a location' },
  { segments: ['geo'], prohibition: 'a location' },
];

/**
 * Columns admitted DESPITE a prohibition.
 *
 * EMPTY, and asserted EXACTLY: an exemption list that only grows is the gate
 * switching itself off one defensible line at a time.
 */
export const BUYER_REQUEST_COLUMN_DENY_EXEMPTIONS: readonly ColumnExemption[] = [];
