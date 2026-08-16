# Backend domain model


One unified API (`packages/backend`) serves storefront, dashboard and POS.

- `Listing`, with ownerType `user | store`, including `ProductVariant` child
  rows.
- **`listings.published_at` is the FIRST activation, never the row's birthday**
  (#261). NULL until a listing is `active`, stamped by the first transition to
  it, never restamped and never cleared — `created_at` is where "when was the row
  written" lives. `db/catalog/listingRepository.ts` is the only author: the three
  statements that can write `listings.status` (`insertListing`,
  `updateListingColumns`, `setListingStatusIfIn`) each derive it, the stamp is a
  SQL `coalesce` rather than a read-then-write, and
  `listing-publication-chokepoint.test.ts` fails the build on a fourth production
  writer of that table. **No backfill, deliberately**: nothing distinguishes a
  draft that was never published from one that was `active` and was returned to
  `draft` by moderation's `request_changes`, so a pre-#261 draft may carry a
  stamp. The feed-ordering change was accepted — every read ordering by the
  column filters `status='active'`, and the two draft-showing screens order by
  `created_at`.
- **`product_variants.sku` and `.barcode` are unique at NO grain** (#296).
  Both carried a table-wide partial unique from the genesis migration, ported
  from Mongo's `sparse: true, unique: true`, and both were an AMBIGUITY CHECK
  wearing a constraint's clothes. A `barcode` is one seller's OBSERVATION of a
  trade item, and two merchants selling one trade item share a GTIN by
  definition — so the unique made the premise `offers` and every price
  comparison rest on unreachable; GTIN identity is `product_identifiers`'
  collision gate, which answers `disputed` plus a review item rather than a raw
  23505. A `sku` is a merchant's own code: Shopify enforces no uniqueness at all
  and WooCommerce enforces it site-wide, so it is NOT narrowed to
  `(listing_id, sku)` either — the `product_identifiers` MPN ruling, that a
  constraint which has to be wrong sometimes is worse than none. The check they
  were standing in for now lives where it can NAME what it found:
  `matchIncomingVariant` (pull) and `resolveInventoryVariant` (push) each refuse
  to pick between candidates, and the push rail reports its own `ambiguous`
  action rather than `skipped` — "we could not find it" and "we found several
  and will not guess" send a merchant to opposite places.
- `Location` plus `InventoryLevel` for multi-location inventory; the `$inc` guard
  is race-safe at the location grain.
- `Collection`, manual plus automated rules, materialized into
  `Listing.collectionIds`.
- `Discount`: code or automatic, percentage/fixed/BOGO, scopes, usage limits,
  combinability.
- `TaxRate` per jurisdiction.
- `Customer`, including POS walk-ins, upserted on paid with running stats.
- `DraftOrder` for a POS sale; `complete` converts it to a paid Order,
  idempotently.
- `Refund`: partial or full, per-line restock at location,
  `partially_refunded` status, no double restock.
- Store settings (policies, notifications, tax config) and reports
  (`/reports/summary`, `/reports/sales`, `/reports/top-products`).

**Pricing engine** (`pricing.service.calculateTotals`): subtotal, then discounts,
then taxes, then shipping, then grand total, with exact half-even reconciliation.

**Store permissions:** 18 perms (`STORE_PERMISSIONS` in
`db/schema/stores.ts`, includes `channels:write` and `analytics:read`). Role
matrix: `owner` gets 18/18, `admin` gets 17/18 (no `store:manage`), `staff` gets
9/18 operational.
**`store:manage` is the one permission an `admin` does not hold**, which is why
the payment-onboarding routes use it rather than `settings:write`. Every buyer
id, seller id and `oxy_user_id` is a foreign SERVICE's primary key (Oxy owns
identity) and carries no foreign key; see `CONVENTIONS.md` below.

**Admin API prefix:** `/admin/stores/:storeId/*`, consumed by dashboard and POS.

