# Digital commerce — assets, licences, buyer rights and fulfilment (#1015)

> Epic [#1015](https://github.com/OxyHQ/Mercaria/issues/1015). Binding:
> [ADR 0010](adr/0010-digital-commerce.md), which amends
> [ADR 0007](adr/0007-universal-catalog-taxonomy-and-authoring.md) D15. Schema-level
> rules are `packages/backend/src/db/schema/CONVENTIONS.md`; what the catalogue
> classifies at all is [commerce-types.md](commerce-types.md).

## Start here: the one-paragraph version

A digital product is an **ordinary canonical product with ordinary variants**. The
catalogue, the cart, the pricing engine, the rail, the ledger and the fee schedules
are unchanged. What #1015 adds is the thing the catalogue has never modelled for
anything: **what gets handed over**. An asset owns immutable versions; a version
owns files; a package is the named deliverable an offer sells; a licence version is
the terms, frozen; and an `asset_rights` row is what a buyer durably owns and the
only thing that authorizes a download.

## The graph

```text
stores ─── digital_assets ─── asset_versions ─── asset_files
                │                   │                 │
                │                   │            asset_file_inspections
                │                   │            asset_provenance_signals
                │                   │
                ├── asset_packages ─┴── asset_package_files
                │         │
                │    asset_licence_options ─── asset_licence_versions ─── asset_licences
                │         │
                │    asset_variant_bindings ··· product_variants  (no FK, by design)
                │
           asset_rights ─── asset_right_events
                │
       asset_download_grants ─── asset_download_events
```

Who owns which table, and which repository issues its statements:
[catalog-table-ownership.md](catalog-table-ownership.md). The derived ERD and the
write census:
[catalog-architecture-diagrams.md](catalog-architecture-diagrams.md).

## The eleven nouns, and why none of them collapses

| Noun | What it is | What it is NOT |
|---|---|---|
| **Digital asset** | the work as a commercial identity | not bytes — it owns none |
| **Asset version** | one immutable release | not editable once published |
| **Asset file** | one stored binary of one version | not reachable by URL |
| **Asset package** | the named deliverable an offer sells | not a format |
| **Licence definition** | a named licence | not the terms |
| **Licence version** | the TERMS, frozen | not a price |
| **Licence option** | this licence × this package × this update policy | not a variant axis |
| **Asset right** | what a BUYER owns | not a merchant entitlement (#89) |
| **Right event** | the audit trail | not a download log |
| **Download grant** | a five-minute, single-file door | not an ownership record |
| **Download event** | the access audit | not a device fingerprint |

**It is a "right", not an "entitlement".** #89's `entitlement_grants`,
`MerchantEntitlementCapability` and `EntitlementGrantReason` already exist and mean
Mercaria billing a merchant for its own software. Two domains one adjective apart is
how a service resolves the wrong one (ADR 0010 D1).

## Reading a purchase end to end

```text
1. A creator uploads files into a DRAFT version.            asset_files
2. Each file is scanned and inspected; results land beside  asset_file_inspections
   the seller's own claims, never mixed with them.
3. The creator assembles a PACKAGE from those files.        asset_package_files
4. A licence version is published — frozen from here.      asset_licence_versions
5. An OPTION ties package + licence + update policy.       asset_licence_options
6. A catalogue variant is BOUND to that option.            asset_variant_bindings
7. The version is published; the asset points at it.       asset_versions.state
8. A buyer checks out. The order line SNAPSHOTS package,   order_items.digital_*
   asset version, licence version and update policy.
9. The order is paid. ONE right is created, idempotently.  asset_rights
10. The order becomes `digitally_delivered`.               orders.status
11. The buyer asks for a file. Six checks run, then a      asset_download_grants
    five-minute grant is minted and the token handed over
    ONCE. Nothing logs it.
12. The transfer is recorded without a fingerprint.        asset_download_events
```

### What makes step 9 idempotent

`UNIQUE(order_item_id, package_id)`, partial on `order_item_id IS NOT NULL`. The
repository inserts with `ON CONFLICT DO NOTHING` and reads back on conflict, so a
retried webhook, an operator repair and a reordered delivery all converge on one
row — and only the first caller appends a `granted` event. A service-level
"check then insert" has a window between the two statements, and a reordered
webhook is precisely a second caller inside it.

A FREE claim has no order line, so the index above is vacuous for it; the second
partial index, `UNIQUE(buyer_key, package_id) WHERE order_item_id IS NULL`, bounds
that case.

### What makes step 11 safe

Six questions, in this order, and **none of them reads a payment**:

1. `config.digital.downloadsEnabled`
2. a right exists for THIS caller over this package
3. its status is `active` — the only authorizing status
4. its update policy covers the version asked for
5. that version is in `DOWNLOADABLE_ASSET_VERSION_STATES`
6. the file is IN the package at that version, and is not `preview_only`

Every refusal happens **before any storage key is read**.
`asset_files.storage_key` is in `PROTECTED_COLUMNS`, so reading it is an explicit,
greppable act and `services/digital/download.service.ts` is the only module that
performs one.

**"No right" and "somebody else's right" get the same answer.** Distinguishing them
would confirm an id exists, which is the enumeration oracle #1015 W12 threat 1 is
about.

## The update policy, which is the subtlest rule here

`DIGITAL_LICENCE_UPDATE_POLICIES` has three members and the RIGHT freezes which
one applied (ADR 0010 D4):

| Policy | What a buyer reaches |
|---|---|
| `purchased_version_only` | exactly the version bought, forever |
| `same_major_version` | later versions sharing the purchased major |
| `all_future_versions` | every version the creator ever publishes |

`services/digital/version-coverage.ts` is the ONE implementation, and it is pure —
so `version-coverage.test.ts` drives every policy against every interesting version
shape rather than illustrating one.

**Two directions, two questions.** `coveredVersion` answers *"what is the newest
thing this buyer may fetch"*; `coversVersion` answers *"may this buyer fetch THAT"*.
The tempting implementation of the second is `coveredVersion(...).id === versionId`
and it is wrong: a buyer entitled to v3 is entitled to v2 and v1 as well.

**`major_version` is the leading integer of the creator's own label, or 0.** A
creator numbering releases `spring-2026` gets 0 for all of them, so
`same_major_version` behaves as `purchased_version_only` for them. Stated rather
than left to be discovered.

## Lifecycles, and which states are load-bearing

```text
asset version:  draft → processing → review → published → superseded
                                                       ↘ restricted
                                                       ↘ withdrawn
```

- **Acquirable:** `published`. ONE member.
- **Downloadable:** `published`, `superseded`, `withdrawn`. Three, and the last two
  are the point — a set listing only `published` would revoke every historical
  purchase the moment a creator shipped an update (ADR 0010 D7).
- **`restricted`** is the one state that stops access, and it is moderation's.

```text
asset right:    active → refunded
                      → disputed_hold → refunded / active (reinstated)
                      → revoked_for_policy   (closed basis set, audited)
                      → superseded           (replaced by another right)
```

Nothing is deleted. `asset_rights` refuses DELETE and freezes every commercial
column; `asset_right_events` refuses UPDATE and DELETE.

## What the database refuses, and where

| Constraint / trigger | What it prevents |
|---|---|
| `orders_shipping_address_digital_check` | a fabricated street on a digital order, AND a missing address on a physical one |
| `orders_digital_supply_pairing_check` | an order whose tax treatment cannot be explained |
| `orders_digital_withdrawal_consent_check` | a waiver nobody can date |
| `order_items_digital_snapshot_complete_check` | three of four snapshot columns |
| `order_items_digital_no_condition_check` | a condition on something with no condition |
| `asset_versions_immutable_once_published` | v2 silently mutating what v1 was |
| `asset_files_immutable_once_published` | a creator swapping bytes after a sale (W12 threat 8) |
| `asset_licence_versions_immutable_once_published` | yesterday's purchase changing terms |
| `asset_rights_commercial_half_immutable` | a buyer's licence being upgraded in place (W12 threat 9) |
| `asset_right_events_append_only` | edited evidence |
| `asset_provenance_signals_append_only` | a creator erasing the fingerprint of something they published |
| `order_items_digital_snapshot_immutable` | a receipt that changes |

All of them are exercised against a real server by
`db/digital/__tests__/digital-commerce.realdb.test.ts`.

## Tax, withdrawal and the launch gate

**Place of supply is PER LINE.** A physical line matches on shipping country,
region and postal code exactly as before; a digital line matches on the consumer's
**country alone**, and a rate scoped to a region or a postal code does not match it
at all. A digital line with NO place of supply matches nothing — deliberately, so a
checkout that never established one fails visibly instead of producing a plausible
zero.

**What is recorded is one country and the KIND of evidence for it.**
`FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS` names what may never establish it —
`ip_geolocation`, `ip_address`, `device_fingerprint`, `browser_locale`,
`timezone_offset` — and `digital-place-of-supply.test.ts` keeps the two sets
disjoint. `~/AGENTS.md`'s no-IP invariant holds with no exception.

**Withdrawal** is a closed three-member vocabulary, and the waiver is paired with a
timestamp by CHECK. **Before `DIGITAL_PAID_CHECKOUT_ENABLED` goes on for a market**,
three sign-offs are required and recorded in `HANDOFF.md`: the payment provider's
permission for a third-party digital-goods marketplace, the electronically-supplied-
service tax configuration for that market, and the consumer-law review of the waiver
copy (ADR 0010 D15).

## The five levers

| Variable | Default | Stops |
|---|---|---|
| `DIGITAL_UPLOADS_ENABLED` | off | new files |
| `DIGITAL_PUBLICATION_ENABLED` | off | a version becoming sellable |
| `DIGITAL_PAID_CHECKOUT_ENABLED` | off | buying (a free claim still works) |
| `DIGITAL_DOWNLOADS_ENABLED` | **on** | minting new grants |
| `DIGITAL_ENABLED_VERTICALS` | empty | a whole vertical (an ALLOW-list) |

`downloadsEnabled` is the only lever that reaches an existing right, hence the only
one defaulting on: it is an incident lever, and the thing you reach for mid-incident
must not be the thing that destroys what buyers hold.

## Adding a second digital vertical

#1015 acceptance criterion 20 says this must not need a second commerce stack. It
does not:

1. Add the vertical to `DIGITAL_VERTICALS`.
2. Add its formats to `ASSET_FORMAT_REGISTRY` as capability rows.
3. Add its product-type profiles through #367's authoring path — NOT as frontend
   truth (`docs/catalog-cookbook.md`).
4. Add the key to `DIGITAL_ENABLED_VERTICALS` on the deployments it launches in.

Nothing in payment, licensing or delivery changes. What a NEW format may need is a
processor, which is the one genuinely new piece — and its absence reads as
`unsupported`, not as a measurement of zero.

## Where the 3D metadata lives

**In #367's product-type registry, never in a React component** (#1015 acceptance
criterion 18). Measured facts — triangle counts, bounding box, watertightness —
live in `asset_file_inspections` with the processor name and version that produced
them. Seller claims — "optimized for Unreal", tested printers — are product-type
attribute values. Two tables, two provenances, and `@mercaria/ui` renders them
differently because it can tell them apart.

A geometric analyzer reports MEASURED properties. It must never present an unsafe
or uncertain model as guaranteed printable, which is why `watertight` is nullable
and `NULL` is "not determined" rather than "no".

## What Phases B and C added

- **The inspection pipeline** (`services/digital/inspection/`): format sniffing and
  geometry measurement for STL, OBJ, glTF/GLB and 3MF, container-bomb refusals for
  zip-shaped packages, a fail-closed malware-scanner seam, and a fourth BullMQ
  queue (`marketplace-digital`) because an inspection is CPU- and memory-bound
  while everything on `marketplace-sync` waits on a supplier. Every other format in
  the registry answers `unsupported` rather than a weak measurement.
- **A publication gate on inspections.** `everyFileInspectionAcceptable` is
  `everyFileScannedClean`'s sibling and closes the escape it left: a `corrupt` file
  is not malicious, so a scanner calls it clean and nothing else stood between it
  and a buyer. `unsupported` and `missing_resources` deliberately pass — see
  `PUBLISHABLE_ASSET_INSPECTION_VERDICTS`.
- **Re-upload detection** (`services/digital/provenance/`): content hashes,
  quantised geometry fingerprints and preview perceptual hashes, swept against the
  evidence table and escalated to the EXISTING abuse-report path, with an operator
  id required and no default — a machine can never file. Nothing is stored: a
  persisted candidate list is a verdict-shaped row.
- **Creator analytics** (`services/digital/analytics/`): six projections of rows
  that already exist, with a ten-sale cohort floor on geographic revenue that
  suppresses rather than rounds, and no path by which ranking can read it.
- **Seven 3D product profiles** and the reference licence seed
  (`services/digital/profiles/`, `scripts/seed-digital-3d.ts`,
  `docs/verticals/3d.md`).
- **The viewer and storefront surfaces** (`@mercaria/ui`, `packages/frontend`),
  including the branded `AssetPreviewSource` that makes handing a paid file to the
  viewer a compile error rather than a runtime check.
- **The storage port** (`services/digital/storage.ts`, `byte-source.ts`): an asset
  file is a private Oxy object, resolved through Oxy's service-token mint. ADR 0010
  D17 records why the obvious user-scoped call is wrong.

## What is NOT built yet

Phases D and E of #1015, and `HANDOFF.md` carries what each still needs: creator
royalties and payout splits (which #1015 forbids building on referral commission or
marketplace fees, and which wants an economic ADR of its own), bundles and
memberships, the physical print bridge, and the dashboard authoring surfaces. The
analytics engine is complete and UNWIRED — its `DigitalAnalyticsFactReader` seam
has no SQL behind it yet. The foundation is built so none of them is a second
commerce stack; none of them is in place today.

**Gift cards, licence keys and third-party redemption codes are still excluded**
(ADR 0010 D16). A redemption code is not a creator file download and must never be
modelled as one.
