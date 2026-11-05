# Merchandising rules (paid: `advanced_merchandising_rules`)

The paid merchandising tool a Mercaria plan can include (#89). It arranges a
store's **own storefront page** (`/stores/:handle`) and nothing else.

## What stays free, unchanged

Manual and automated collections, a collection's own `sortOrder`, featured
collection shelves, discounts, and the store page's default grid. A rule never
writes `collections`, `listing_collections` or a listing, so a manual
collection's hand-picked positions and an automated collection's NULL positions
(`AGENTS.md`) are exactly what the merchant set. Free features stay where they
are.

## What a rule does

| Kind | Target | Effect on the store page |
|---|---|---|
| `sort` | the whole store page, or one collection | the grid's DEFAULT order (when the shopper has not picked a sort, typed a search or set the in-stock filter): pins first (up to 24, in order), then in-stock first when set, then `best_selling` (units sold in paid orders of this store over 1–365 days, newest as tie-break), `newest`, `price_asc` or `price_desc` |
| `spotlight` | one collection | a shelf at the top of the page showing the collection's first 1–24 listings (in that collection's `sort` rule order if one applies, else the collection's free order) |

Either kind may carry `startsAt` (inclusive) and `endsAt` (exclusive), and may be
paused. Schedules are evaluated **when the page is read** (no worker, no stored
"is live" flag). For `sort`, one rule applies per target: the one whose window
started latest wins (an open start counts as the earliest), so a scheduled
override beats an always-on default and hands back when it ends; the others
read `superseded`. Up to three spotlights show, most recently started first.
Unpublished collections are never merchandised on the page.

A rule whose collection is deleted is kept, `detached` (the FK is `SET NULL`;
`target` keeps NULL unambiguous), applies to nothing, and still holds its unit
until the merchant deletes it.

## Enforcement

- Create: `consumeCapabilityOrThrow` takes one unit of the `total` allowance in
  the insert's transaction. A refused or failed create takes nothing.
- Edit and preview: `requireCapability` (the tool's own work). At the ceiling a
  store can still edit what it has.
- Delete: never gated; `releaseCapability` in the delete's transaction, only when
  a row was deleted.
- List and read: never gated.
- Plan ends: rules stop applying to the store page (`holdsCapability` on every
  public read answers the empty plan), nothing is deleted, and they apply again
  if the plan returns.

## The wall: plans never buy reach

`routes/stores.ts` and `controllers/stores.controller.ts` are in the derived
ranking surface (`__tests__/ranking-surface.ts`), so the rule read has its own
router, `routes/store-merchandising.ts`, mounted at
`/stores/:handle/merchandising` before `/stores`. Its controller, service and
repository import no ordering engine (`listingRepository`,
`catalog-hydration`, search, ranking, feed). The page hydrates the ids it is
given through the free `GET /stores/:handle/listings?ids=` (store-scoped,
active-only, in the order named, at most 48), which reads no rule.
`services/__tests__/merchandising-rules-isolation.test.ts` asserts both
directions, plus `merchant-plan-isolation.test.ts`.

## Surfaces

- `GET|POST /admin/stores/:storeId/merchandising/rules`, `GET|PATCH|DELETE …/rules/:id`
  (`products:read` to read, `collections:write` to write), `POST …/preview`.
- `GET /stores/:handle/merchandising`, `GET /stores/:handle/merchandising/listings`.
- Dashboard: `app/(app)/tools/merchandising` (list, new, edit with schedule
  pickers and a live order preview you can pin from).
