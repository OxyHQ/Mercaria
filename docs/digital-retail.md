# Authorized digital retail — private supply, exactly-once procurement, sealed artifacts (#1016)

> Epic [#1016](https://github.com/OxyHQ/Mercaria/issues/1016). Binding:
> [ADR 0011](adr/0011-authorized-digital-retail.md), which amends
> [ADR 0010](adr/0010-digital-commerce.md) **D16** in ONE half. Schema-level rules
> are `packages/backend/src/db/schema/CONVENTIONS.md`; the physical sibling of
> this domain is [ADR 0004](adr/0004-mercaria-retail-dropship.md) and
> [purchase-orders.md](purchase-orders.md).

## Start here: the one-paragraph version

A customer buys a game or a software licence **from Mercaria**, pays Mercaria,
and manages it in Mercaria. Behind that, Mercaria buys the thing from an approved
distributor at the moment the customer pays — irreversibly, with real money — and
the customer never needs to know which one. This domain is that private half: who
Mercaria may buy from, under what authorization, how one purchase is made exactly
once, what is handed over, and how it is kept.

**The two shapes of digital good do not collapse into each other.** #1015 sells a
creator's file, which exists before the sale. #1016 sells a third-party
activation artifact, which does not. A redemption code is not a creator file
download, and modelling one as an `asset_package` is exactly what ADR 0010 D16
refused — what changed is that it now has a domain of its own.

## The graph

```text
suppliers ── supplier_accounts ── digital_supplier_capabilities
    │               │
    │               └── digital_procurement_offers ──┐
    │                                                 │
    └── supplier_agreements ── digital_supply_terms ──┤   (the rider: what is AUTHORIZED)
                                                      │
                            digital_retail_pricing_policies
                                                      │
                                 digital_purchase_orders ── digital_purchase_order_attempts
                                              │
                                     digital_fulfilments ── digital_fulfilment_artifacts
                                              │                      │
                                    digital_fulfilment_reveals       │
                                              │                      │
                                    digital_fulfilment_incidents ────┘
```

Who owns which table and which repository issues its statements:
[catalog-table-ownership.md](catalog-table-ownership.md).

## The nouns, and why none of them collapses

| Noun | What it is | What it is NOT |
|---|---|---|
| **Supplier** | the counterparty, shared with physical retail | not a merchant, not a seller, not a public page |
| **Supply terms** (the rider) | what ONE agreement version authorizes digitally | not the API's abilities |
| **Supplier capability** | what the API can do, per operation, with its own pause | not a permission |
| **Procurement offer** | one supplier's terms for one exact product | not a public offer, ever |
| **Pricing policy** | the versioned rule turning cost into a retail price | not ADR 0004's cost-only formula |
| **Purchase order** | ONE attempt to buy ONE line from ONE supplier | not the customer's order |
| **Attempt** | one adapter CALL | not a purchase |
| **Fulfilment** | what the BUYER owns | not the artifact |
| **Artifact** | the sealed thing handed over | not a download URL, not a plaintext column |
| **Reveal** | that a secret was shown, once, to somebody | not a redemption |
| **Incident** | that something went wrong, and what was done | not a refund |

## Reading a purchase end to end

```text
1. A catalogue sync maps a supplier SKU onto a canonical  digital_procurement_offers
   variant. Anything ambiguous is STORED and dark.
2. A buyer checks out. (#57's public offer surface is
   not built — see "What is not built".)
3. Procurement opens ONE attempt, with a DERIVED key.     digital_purchase_orders
4. Preflight re-asks the supplier, authoritatively.       …_attempts
5. A compare-and-swap claims the attempt.                 status: submitting
6. The purchase is made. The bound is never exceeded.
7. The artifact is fetched, SEALED and stored.            digital_fulfilment_artifacts
8. The buyer's durable record is created, idempotently.   digital_fulfilments
9. The buyer reveals it. The reveal is audited.           digital_fulfilment_reveals
```

### What makes step 3 exactly-once

Three mechanisms, and none of them is a service-level check (ADR 0011 D6):

1. **`UNIQUE(idempotency_key)`**, the key derived as `dpo:<order_item>:<attempt>`.
   The same key is what the adapter is handed, so a provider that honours
   idempotency dedupes on its side too.
2. **`digital_purchase_orders_live_line_key`** — a PARTIAL unique on
   `order_item_id` over the non-terminal statuses. Two live attempts for one order
   line are unrepresentable, which is the epic's fallback rule 1 as a database
   property rather than as an ordering somebody has to preserve.
3. **A compare-and-swap on every transition**, answering `updated` / `stale` /
   `missing` / `forbidden`. A caller that cannot name where it started cannot
   write.

### What makes step 6 safe when it goes wrong

```text
pending → preflighted → submitting → accepted → fulfilled
                           |  \→ ambiguous → accepted | rejected | failed
                           \→ rejected | failed
```

**`ambiguous` is a first-class state and there is NO edge from `submitting` to
`failed` on a timeout.** A `failed` written on a timeout is a claim that nothing
was bought, and nothing on this side of the wire knows that — acting on it is
what buys a second key for a customer paying for one. The only way out of
`ambiguous` is `recoverAmbiguousPurchaseOrder`, which asks the supplier; a
recovery that itself fails leaves the attempt ambiguous, because "I could not
reach them" is not "nothing happened".

**Every non-terminal state has a terminal exit, and a test asserts it.** That is
not tidiness: the live-line index means an attempt with no way out blocks its
order line forever. The first version of the map had no `pending → rejected`
edge, so a supplier saying "no" at preflight did exactly that.

## What a supplier is authorized to do

Nothing, until a RIDER says so. `digital_supply_terms` hangs off one
`supplier_agreements` version, one row per version, and its absence is legible:
an account is not a grant (the epic's invariant 4).

- **`provenance` is NOT NULL with four members and no `unknown`.** Unclassified
  supply has no rider, and no rider authorizes nothing — so the unverified state
  is unrepresentable rather than refused (ADR 0011 D3).
- **Empty scope arrays mean NONE.** An agreement GRANTS; a grant naming no
  territory grants none. (`commerce_relationships.territories` reads `'{}'` as
  worldwide, because a relationship is a positive fact being scoped down. The two
  semantics are documented against each other in `CONVENTIONS.md`.)
- **An offer's activation territories are the OPPOSITE**: empty means
  unrestricted, because an offer DESCRIBES where the thing works rather than
  authorizing anything.

`deriveDigitalProcurementEligibility` is the one verdict, derived from supplier,
account, capability, rider and offer facts every time it is asked. There is no
`eligible` column: a stored verdict beside the facts it derives from is two
representations of one fact, and the place they must not disagree is a checkout
gate.

## Choosing a supplier

Cheapest does NOT win (ADR 0011 D9). Six hard gates — exact mapping, authorized
territory, healthy and unpaused, available, within the order's cost ceiling, the
right capability — then a total ranking on provenance strength, historical
reliability, expected latency, cost, and finally the offer id.

The id tiebreak is load-bearing: a selector that can return either of two
suppliers makes an incident unreproducible, and an unmeasured supplier ranks at
`RELIABILITY_WITHOUT_HISTORY` (0.5) rather than at 1, so a brand-new account does
not win every routing decision on its first day.

## The artifact, and the three facts about it that are easy to conflate

| Fact | Column | Who may write it |
|---|---|---|
| it was DELIVERED | `digital_fulfilments.delivered_at` | the orchestrator |
| it was REVEALED | `first_revealed_at`, `reveal_count` | the reveal path |
| it was REDEEMED | `digital_fulfilment_artifacts.redemption_state` | provider truth ONLY |

A reveal is not a redemption, and a refund decision turns on which one happened.
There is no operator transition to `redeemed`, because an operator who could set
it could make a refund ineligible by typing.

**The plaintext has no column.** `sealed_secret` is AES-256-GCM ciphertext,
`key_reference` is a PATH into the approved secret store (a pasted key fails the
column's CHECK), and all three sealed columns are registered in
`db/protectedColumns.ts` — so a whole-row read cannot ship one and a serializer
that reaches for one fails `tsc`. `masked_hint` is four characters of the TAIL,
in clear, deliberately: support answers *"is the key you are holding the key we
sold you"* without anybody reading a key, and four characters reconstruct
nothing.

## What the database refuses, and where

| Constraint / trigger | What it prevents |
|---|---|
| `digital_purchase_orders_live_line_key` | a second live attempt for one order line — the double-buy |
| `digital_purchase_orders_idempotency_key` | two attempts for one derived key |
| `digital_purchase_orders_cost_bound_check` | a ceiling below the quote, or two currencies compared |
| `digital_purchase_orders_final_cost_check` | a final cost above the ceiling |
| `digital_purchase_orders_snapshot_immutable` | a catalogue refresh rewriting a submitted order's cost |
| `digital_procurement_offers_mapping_shape_check` | an `exact` mapping with no canonical variant |
| `digital_procurement_offers_mapping_note_check` | an ambiguous mapping nobody can triage |
| `digital_fulfilment_artifacts_active_key` | the old key and the new one both working |
| `digital_fulfilment_artifacts_secret_presence_check` | an `activation_key` with nothing in it, and a `direct_account_activation` carrying a key |
| `digital_fulfilment_artifacts_operator_check` | a fabricated fulfilment with no named operator and no incident |
| `digital_fulfilment_artifacts_seal_immutable` | a ciphertext swapped after delivery |
| `digital_fulfilment_incidents_operator_check` | a machine filing an operator incident |
| `digital_*_append_only` / `_no_delete` | edited or erased evidence |

All of them are exercised against a real server by
`db/digitalRetail/__tests__/digital-retail.realdb.test.ts`, and the orchestration
by `services/digital-retail/__tests__/procurement.realdb.test.ts`.

## The five levers

| Variable | Default | Stops |
|---|---|---|
| `DIGITAL_RETAIL_CATALOG_SYNC_ENABLED` | off | pulling supplier catalogues |
| `DIGITAL_RETAIL_PUBLICATION_ENABLED` | off | an offer becoming publishable |
| `DIGITAL_RETAIL_CHECKOUT_ENABLED` | off | buying |
| `DIGITAL_RETAIL_PROCUREMENT_ENABLED` | off | submitting anything to a supplier |
| `DIGITAL_RETAIL_REVEAL_ENABLED` | **on** | revealing an artifact a buyer already owns |

Plus `DIGITAL_RETAIL_SEAL_KEY_REFERENCE` (the path new artifacts are sealed
with — empty means this deployment can seal nothing, which is why procurement
defaults off) and `DIGITAL_RETAIL_RECOVERY_DELAY_SECONDS`.

**These are deployment levers and they do not replace the per-row kill
switches.** `supplier_accounts.state = 'killed'` and
`digital_supplier_capabilities.state` are what an incident about ONE supplier
reaches for. None of them gates the library, a reveal of something already sold
(except the incident lever, deliberately), support or refunds.

## Adding an authorized digital supplier

The epic's acceptance criterion 25, as a procedure:

1. **Verify the account and the terms first.** Mercaria may legally resell; the
   API may be used for customer-facing resale; catalogue rights; territories;
   publisher exclusions; key provenance; idempotency semantics; refund and
   replacement rules; funding model; tax treatment. ADR 0011 ships no named
   distributor because this step is not a code review.
2. Write the adapter against `DigitalSupplierAdapter`. Nothing outside it may see
   the provider's schema.
3. Run `runAdapterConformance` against their sandbox with `allowPurchase: true`.
   A clean run proves the CONTRACT — not that their stock is real or that their
   terms permit resale.
4. Register it in `registerBuiltInDigitalSupplierAdapters`.
5. Create the supplier, the account (with its credential REFERENCE), the
   agreement version and the digital rider. No rider, no supply.
6. Create the capability rows. `purchase_recovery` is required — without it an
   ambiguous attempt is unrecoverable.
7. Turn on catalog sync, map a small allowlisted catalogue, and check the
   ambiguous queue before anything is published.

Nothing in the public catalogue semantics changes for any of it.

## What is NOT built

- **The public offer and the checkout wiring.** Mercaria's unified public offer
  domain is #57 and does not exist, which is why #118 exposed a sourcing SEAM for
  physical retail rather than extending a table that is not there. This domain
  does the same: `DigitalRetailSourcingSeam` is what #57 composes over.
- **A named provider adapter.** The sandbox is a conformance fixture.
- **Gift cards and any stored-value instrument.** ADR 0011 D16 — unrepresentable,
  not disabled.
- **Direct account activation's OAuth flow.** The capability is in the
  vocabulary and refuses to fulfil rather than pretending.
- **The catalogue sync worker and the ambiguous review queue UI.** The repository
  upsert and the retirement sweep exist; nothing schedules them yet.
- **Ledger posting for supplier cost and realized margin.** ADR 0011 states the
  accounting treatment; the postings are #128's reconciliation domain and are not
  wired.

`HANDOFF.md` carries each of these with what it still needs.
