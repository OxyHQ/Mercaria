/**
 * The retail-fulfilment column allow-list and its deny-list (#126 acceptance 2).
 *
 * `db/schema/retailFulfilment.ts` holds four tables whose central property is
 * an ABSENCE: **Moovo owns the physical logistics, and Mercaria models no
 * carrier, package, label, scan, weight, dimension or manifest.** Until this
 * module existed the gate behind that sentence was one regex naming eleven
 * tokens, and it had two independent defects (#354).
 *
 * **It could not fire on two of its own tokens.** It matched against
 * `column.name`, the TypeScript PROPERTY name, so `proof_of_delivery` and
 * `service_code` were being compared to `proofOfDelivery` and `serviceCode`.
 * Its mutation self-test could not show it, because the self-test fed the
 * pattern snake_case literals the scan never receives.
 *
 * **And it admitted everything it had not thought of.** `tracking_number`,
 * `shipment_id`, `courier_reference`, `waybill_id` and `checkpoint_at` match
 * not one of the eleven — every one of them the durable half of exactly the
 * carrier system acceptance 2 forbids.
 *
 * So the shape is inverted. Every column of every table in the module is
 * enumerated here with a REASON, and **anything not enumerated fails the build
 * until somebody decides it is allowed.** `services/curation/merge-plan.ts` is
 * the precedent — "a new table referencing a mergeable entity fails the build
 * until somebody decides what a merge does with it" — including its posture on
 * silence: a decision recorded WITH a reason is what the census accepts, and
 * saying nothing is not.
 *
 * The machinery, the both-ways comparison and the segment matching are
 * `db/__tests__/column-allowlist.ts`'s.
 */

import type { ColumnExemption, ColumnProhibition, TableAllowance } from '../../db/__tests__/column-allowlist.js';

/**
 * Every column of every table in `db/schema/retailFulfilment.ts`.
 *
 * Grouped rather than annotated one by one: the question a reviewer actually
 * has to answer is what KIND of fact a column is. A group whose reason does not
 * cover a column is the signal to open a new group, not to widen the sentence.
 */
export const RETAIL_FULFILMENT_COLUMN_ALLOWLIST: readonly TableAllowance[] = [
  {
    table: 'retail_order_role_snapshots',
    groups: [
      {
        reason:
          'The row and the order it snapshots. A snapshot is immutable, so it carries a creation instant and no update one.',
        columns: ['id', 'order_id', 'created_at'],
      },
      {
        reason:
          'Who is selling, as a legal entity. #126 stores the seller of record because a receipt has to name one, and `MERCARIA_RETAIL_SELLER_COUNTRY` is deliberately not defaulted — defaulting it would print a country on the receipt of a deployment that never configured one.',
        columns: ['seller_of_record', 'seller_legal_entity_name', 'seller_legal_entity_country'],
      },
      {
        reason:
          "#117's supplier-fulfilment disclosure, cited by key and version, beside the customer terms version it was made under. A version pointer, never a copy of the terms — the terms are a code constant so they can still be resolved.",
        columns: [
          'supplier_fulfilment_disclosure_key',
          'supplier_fulfilment_disclosure_version',
          'customer_terms_version',
        ],
      },
      {
        reason:
          'The four consumer-rights windows, stored as NUMBERS beside their terms version rather than as a pointer, because a version pointer is only as durable as the code that can still resolve it.',
        columns: [
          'cancellation_window_hours',
          'withdrawal_window_days',
          'return_window_days',
          'warranty_months',
        ],
      },
    ],
  },
  {
    table: 'retail_fulfilment_intents',
    groups: [
      {
        reason:
          "The row, the order, the #123 procurement intent it fulfils, its kind, and the intent it supersedes. Lineage rather than mutation: a revised intent is a new row naming the one it replaces.",
        columns: [
          'id',
          'order_id',
          'procurement_intent_id',
          'intent_kind',
          'supersedes_intent_id',
          'created_at',
          'updated_at',
        ],
      },
      {
        reason:
          'Mercaria\'s own view of the intent, from `RETAIL_FULFILMENT_INTENT_STATUSES` — a CHECK-bound vocabulary asserted disjoint from `RETAIL_FULFILMENT_FORBIDDEN_INTENT_STATUSES`, so no status can assert a physical fact.',
        columns: ['status', 'status_reason'],
      },
      {
        reason:
          'Two mode columns and two clocks: `permitted` is contractual and frozen at purchase, `fulfilment` is operational and unknowable until a supplier confirms package readiness. One column would either freeze a mode nobody could know or leave the grant rewritable after the sale.',
        columns: ['permitted_fulfilment_mode', 'fulfilment_mode'],
      },
      {
        reason:
          'The Moovo seam. A deterministic source reference generated from the row id, plus a REFERENCE to a transport request Moovo owns and when it was registered — never a copy of what that request says, which is why no shipment, package, checkpoint or freshness column exists beside them.',
        columns: [
          'moovo_source_reference',
          'moovo_transport_request_id',
          'moovo_transport_registered_at',
        ],
      },
    ],
  },
  {
    table: 'retail_fulfilment_line_allocations',
    groups: [
      {
        reason:
          'Which order line an intent claims and how many units of it. The over-allocation invariant is cross-row, which is why the repository is the single writer and locks `order_items` first.',
        columns: [
          'id',
          'fulfilment_intent_id',
          'order_item_id',
          'quantity',
          'created_at',
          'updated_at',
        ],
      },
    ],
  },
  {
    table: 'retail_delivery_promises',
    groups: [
      {
        reason:
          'The row, the order and the intent the promise is about. Append-only, so a past promise cannot be silently rewritten by a refresh.',
        columns: ['id', 'order_id', 'fulfilment_intent_id', 'created_at'],
      },
      {
        reason:
          'What was promised and on whose authority: the kind, who said it, the reference they said it under, the basis, and the window. Only `mercaria_checkout` may author the guaranteed accepted-at-checkout promise, by CHECK; a supplier SLA arrives advisory and no code path upgrades it.',
        columns: [
          'promise_kind',
          'source',
          'source_ref',
          'basis',
          'earliest_at',
          'latest_at',
        ],
      },
      {
        reason:
          'What was observed against it, and when. A failed refresh is a ROW rather than a missing one, and an unparseable observation time answers `unknown` rather than fresh.',
        columns: ['outcome', 'observed_at', 'failure_reason'],
      },
    ],
  },
];

/**
 * The second layer: names that may never be admitted, whichever side names
 * them.
 *
 * The first eleven entries are the previous gate's own tokens, carried over
 * unchanged in MEANING — `proof_of_delivery` and `service_code` are now
 * adjacent-segment prohibitions that can actually fire, which they could not
 * when they were matched against a camelCase property name.
 *
 * The rest are the names that gate would have admitted. They are not
 * speculative: `tracking_number`, `shipment_id` and `courier_reference` are
 * what somebody reaches for while #157 and #159 are still open and a buyer is
 * asking where their parcel is.
 *
 * `tracking` and `transport` are deliberately NOT banned as bare segments:
 * `moovo_transport_request_id` is a REFERENCE to a movement another service
 * owns, which is the whole design, and banning the word would ban the seam it
 * exists for. What is banned is anything Mercaria would have to MODEL.
 */
export const RETAIL_FULFILMENT_FORBIDDEN_COLUMN_SEGMENTS: readonly ColumnProhibition[] = [
  { segments: ['carrier'], prohibition: 'a carrier Mercaria would have to model' },
  { segments: ['courier'], prohibition: 'a carrier Mercaria would have to model' },
  { segments: ['package'], prohibition: 'a package Mercaria would have to model' },
  { segments: ['parcel'], prohibition: 'a package Mercaria would have to model' },
  { segments: ['shipment'], prohibition: 'a shipment Mercaria would have to model' },
  { segments: ['waybill'], prohibition: 'a transport document Mercaria would have to issue' },
  { segments: ['manifest'], prohibition: 'a transport document Mercaria would have to issue' },
  { segments: ['label'], prohibition: 'a shipping label Mercaria would have to produce' },
  { segments: ['scan'], prohibition: 'a carrier scan Mercaria would have to ingest' },
  { segments: ['checkpoint'], prohibition: 'a carrier scan Mercaria would have to ingest' },
  { segments: ['weight'], prohibition: 'a physical measurement of the goods' },
  { segments: ['dimension'], prohibition: 'a physical measurement of the goods' },
  { segments: ['poll'], prohibition: 'a tracking poll cursor — Moovo owns the polling' },
  { segments: ['proof', 'of', 'delivery'], prohibition: 'proof of delivery, which Moovo holds' },
  { segments: ['service', 'code'], prohibition: "a carrier's own service code" },
  { segments: ['tracking', 'number'], prohibition: 'a tracking handle Mercaria would have to keep fresh' },
  { segments: ['tracking', 'code'], prohibition: 'a tracking handle Mercaria would have to keep fresh' },
  { segments: ['tracking', 'url'], prohibition: 'a tracking handle Mercaria would have to keep fresh' },
];

/**
 * Columns admitted DESPITE a prohibition.
 *
 * EMPTY, and the count is asserted EXACTLY rather than as a ceiling: an
 * exemption list that only grows is the gate switching itself off one
 * defensible line at a time. Nothing in these four tables needs one, which is
 * the point — the domain was designed around this absence.
 */
export const RETAIL_FULFILMENT_COLUMN_DENY_EXEMPTIONS: readonly ColumnExemption[] = [];
