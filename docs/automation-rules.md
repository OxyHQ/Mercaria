# Automation rules (`automation_rules`, #89)

A paid merchant-plan tool: rules that act on a store's own catalogue and
orders. Limit kind `total` — the allowance is the **number of rules** a store
has. Dashboard: **Tools → Automations** (`packages/dashboard/app/(app)/tools/automations`).

## What a rule is

One trigger, optional conditions, one action, an on/off switch, per store. The
closed sets are in `packages/shared-types/src/automation-rule.ts`, and the
table's CHECKs are rendered from them (including which action may follow which
trigger).

| Trigger | Conditions | Actions |
|---|---|---|
| `listing_stock_at_or_below` | threshold (units), optional tag | `notify_owner`, `pause_listing` (+ `republishWhenRestocked`) |
| `order_paid` | optional minimum shop-currency total, optional tag (an order line's listing carries it) | `notify_owner`, `mark_order_processing` |

- A listing's stock is the sum of its variants' rolled-up `inventory_available`;
  a listing with an untracked variant is never "at or below".
- `notify_owner` sends an in-app notification (`low_inventory` / `order_paid`
  type) to the store's owning Oxy account, the inbox every store notification
  reaches (ADR 0012).
- `pause_listing` moves an `active` listing to `draft` through
  `catalog-write.service.updateListing`. With `republishWhenRestocked`, a listing
  **this rule paused** and that is **still a draft** goes back to `active` once
  its stock is above the threshold again. A listing the merchant changed in the
  meantime, or one a jury restricted, is left alone; `restricted` is never set
  or lifted (the moderation escapes in `AGENTS.md`).
- `mark_order_processing` moves a `paid` standard/express order to `processing`
  through `order.service.transition` (system actor, note naming the rule). A held
  order is refused by `transition` itself and recorded as `skipped`; digital and
  pickup orders are skipped.

## Execution

`services/automation-rules/evaluator.ts` is a periodic sweep over committed
state (default every minute, `AUTOMATION_RULES_EVALUATE_INTERVAL_MS`), started
in `index.ts`. Nothing is hooked into the inventory or order write paths, so a
rule can never block, slow or fail a commerce write; the cost is up to one
interval of latency.

- **Idempotent per (rule, subject, occurrence).** A stock rule's occurrence is
  an episode row in `automation_rule_listing_states` (claimed by `INSERT … ON
  CONFLICT DO NOTHING`, closed by `DELETE … RETURNING` when stock recovers); an
  order rule's is the payment (`paid`), claimed by the unique key on
  `automation_rule_runs`. Claim, action and run record share one transaction, so
  a crash retries and concurrent tasks act once. A refused or failed action is
  recorded and not retried for the same occurrence.
- **The plan is asked first.** `holdsCapability` per store per pass: a store at
  its ceiling still runs every rule it has; a store without the capability runs
  none and logs nothing.
- An order rule only considers orders paid after the rule was last enabled
  (`armed_at`) and within `AUTOMATION_RULES_ORDER_LOOKBACK_MS` (one day).
- Bounds: `AUTOMATION_RULES_RULES_PER_PASS` (500), `AUTOMATION_RULES_SUBJECTS_PER_RULE` (25).
- `AUTOMATION_RULES_EVALUATOR_ENABLED` (default on) gates the loop only.

## What the plan meters

| Act | Plan |
|---|---|
| Create a rule | `consumeCapabilityOrThrow` (1) in the insert's transaction → 403 `PLAN_CAPABILITY_REQUIRED` / `PLAN_LIMIT_REACHED` |
| Delete a rule | `releaseCapability` in the delete's transaction (only when a row was deleted) |
| Edit or enable a rule | `requireCapability` (allowed at the ceiling) |
| Disable, list, read, read runs, delete | never gated |

When a plan ends nothing is deleted: rules stay readable, can be turned off and
deleted, and simply stop running. Deleting a rule leaves the listings it paused
as drafts.

## Permissions

Routes `/admin/stores/:storeId/automations` (`GET /`, `GET /runs`, `GET /:id`,
`POST /`, `PATCH /:id`, `DELETE /:id`): reads `products:read`, writes
`products:write`; a `mark_order_processing` rule additionally needs
`orders:fulfill` (checked by the service against the rule's action).

## Run history

`automation_rule_runs`: rule, subject (listing or order, no foreign key), step,
outcome (`succeeded` / `skipped` / `failed`) and a merchant-readable detail.
Swept after 90 days (`db/expiryTargets.ts`).
