# Replenishment planning

A paid merchant tool (`replenishment_planning`, a `flag` capability; see
[merchant-plans.md](merchant-plans.md) "Building a paid tool"): a demand
forecast and purchase suggestions over a store's OWN multi-location inventory.
It suggests; it never creates a supplier order, a purchase order or a stock
movement.

## What it computes

Per tracked variant of an `active` or `sold` store listing, store-wide or at one
location, computed on read (nothing about a forecast is stored):

| Figure | Definition |
|---|---|
| Units sold (28 d / 90 d) | Lines of the store's orders in `paid`, `processing`, `shipped`, `delivered`, `digitally_delivered` or `partially_refunded`, minus units on `refunded`/`restocked` refund lines of that order and variant, floored at 0. Dated by the order's `created_at` (when the stock was reserved). |
| Location | `order_items.location_id` (POS register, pickup), else the store's default location — where `inventory.service` reserved it. A sale at a since-deleted location counts store-wide only. |
| Demand / day | 0.6 × (28-day units ÷ 28) + 0.4 × (90-day units ÷ 90). A variant younger than a window is measured over its own age, never fewer than 7 days. No seasonality. |
| Available / on hand | `inventory_levels.available` (may be negative when oversold) / `available + committed`. |
| Days of cover, stock-out date | available ÷ demand; today (UTC) + whole days of cover. None when nothing sells. |
| Reorder point | ⌈demand × (lead time + safety stock)⌉. |
| Suggested order | ⌈demand × (lead time + target cover + safety stock) − available⌉, never negative. |
| Status | `stocked_out` (available ≤ 0 while selling, or < 0), `reorder_now` (available ≤ reorder point), `healthy`, `no_recent_sales`. |

Incoming stock is NOT modelled: Mercaria holds no purchase orders for a
merchant's own suppliers (`purchase_orders` is Mercaria-retail procurement,
ADR 0004), so the screen tells the merchant to subtract what they already
ordered.

Rows are prioritised soonest stock-out first, then largest suggestion. One plan
reads at most 20,000 variants (`truncated` says so); the JSON answers 500 rows by
default (max 5,000) and the CSV every row.

## Settings

`replenishment_settings` (one row per store: lead time 0–365, target cover
0–365, safety stock 0–180 days; defaults 14 / 28 / 7 until saved) and
`replenishment_variant_overrides` (any subset per variant; NULL inherits, an
all-NULL row is refused by CHECK and deleted by the service).

## API and gating

`/admin/stores/:storeId/replenishment/*`:

| Route | Permission | Capability |
|---|---|---|
| `GET /plan` (`locationId`, `status`, `limit`, `format=csv`) | `products:read` + `stats:read` | required |
| `GET /settings` | `products:read` + `stats:read` | never (rows the store saved) |
| `PUT /settings`, `PUT /overrides/:variantId` | + `inventory:write` | required |
| `DELETE /overrides/:variantId` | + `inventory:write` | never (removes what the store made) |

The capability is checked in `services/replenishment/plan.service.ts`. When a
plan ends, the plan and settings changes stop with 403
`PLAN_CAPABILITY_REQUIRED`; the saved settings stay, readable and deletable.

Dashboard: `app/(app)/tools/replenishment.tsx` behind `PlanToolGate`.

## Performance

Four statements per plan, each scoped to one store by an index:
`orders_store_id_status_created_at_idx` (one range per counted status, bounded by
the 90-day window), `refunds_store_id_status_created_at_idx`,
`listings_owner_store_status_published_at_id_idx` → product variants, and
`inventory_levels` through the store's locations. No new index was needed.
