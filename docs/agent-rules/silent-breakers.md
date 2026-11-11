# Backend invariants that break silently

Moved from the root `AGENTS.md`. Backend and catalog invariants whose violation still builds green.

- **Five webhook routers stay mounted BEFORE `express.json()`**
  (`docs/house-invariants.md`), asserted PER MOUNT on the real chain.
- **No request body carries a feed** (the proxy refuses >100 MB): parts go to
  storage presigned; validation is a polled 202 job (`docs/feed-importer.md`).
- **Three moderation ESCAPES are closed in pre-existing commerce code**, invisible
  from `services/moderation/`: `catalog-write.service.updateListing` refuses to set
  `restricted` or to leave it; `archiveListing` refuses a restricted listing at all
  (DELETE-then-PATCH laundered a jury's decision in two calls — #402); and
  `order.service.transition` refuses a held order. Keep all three, and
  `restoreSubject` relists from `archived` too; `listing-archive-census.test.ts`
  fails the build on a new archiver. `docs/moderation.md`.
- **"Report" is two unrelated things.** `report.service.ts` and
  `/admin/stores/:storeId/reports/*` are SALES ANALYTICS; abuse reports are
  `services/moderation/`. Never merge.
- **`product_variants.sku` and `.barcode` are unique at NO grain and must not be
  re-narrowed** — two merchants selling one trade item share a GTIN by definition.
  GTIN identity is `product_identifiers`' collision gate; the ambiguity check lives
  in `matchIncomingVariant`/`resolveInventoryVariant`, which REFUSE to pick and
  report `ambiguous`, never `skipped`.
- **A connector collection mapping may target only a MANUAL collection.**
  `applyCollectionMapping` and `reconcileAutomatedMembership` both write a NULL
  `position` into `listing_collections`, so on an automated target each silently
  deletes the other's rows and the last run wins. Refused at write time AND filtered
  at import time — the second catches a target made automatic after a valid mapping
  was stored. `docs/channels.md`.
- **`listings.published_at` is the FIRST activation, never the row's birthday.**
  `db/catalog/listingRepository.ts` is its only author;
  `listing-publication-chokepoint.test.ts` fails the build on a fourth writer.
- **Digital goods are a commerce type since #1015 (ADR 0010); #1016 (ADR 0011) added
  authorized RETAIL of third-party keys.** A `digital` order has ALL NINE address
  columns NULL — `orders_shipping_address_digital_check` says MORE than the NOT NULLs
  it replaced, so never "fix" it with a placeholder street — place of supply is PER
  LINE on the consumer COUNTRY alone, and `asset_rights` alone authorizes a download.
  Retail: a partial unique bounds ONE live purchase order per order line, a timeout
  only reaches `ambiguous`, a key has no plaintext column, a gift card is
  unrepresentable. `DIGITAL_DOWNLOADS_ENABLED` and `DIGITAL_RETAIL_REVEAL_ENABLED`
  default ON, the other eight OFF. `docs/digital-{commerce,retail}.md`.
- **Shipping UI is HIDDEN and Moovo owns logistics entirely** — do NOT build
  shipping zones or rates, and the Moovo port is registered on no deployment.
  Pickup/collection is a different thing and IS built (`docs/pickup.md`).
- **Place facts are GoWay's** (ADR 0013, `go_way_place_id` only, via
  `services/goway/`; a location shows only while its place names it back);
  **stores are crawled by Clarity** (ADR 0017, `services/clarity/`).
