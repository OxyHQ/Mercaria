# Named POS registers (`expanded_pos_registers`)

The paid tool behind the `expanded_pos_registers` plan capability (#89). Code:
`services/pos-registers.service.ts`, `db/pos/posRegisterRepository.ts`,
`db/schema/posRegisters.ts`, the dashboard's `app/(app)/tools/pos-registers.tsx`
and the POS store-setup register step.

## The free baseline: one default register per location

Every location has ONE implicit default register. It is not a row: an order
with `orders.pos_register_id` NULL was rung up on it. Any number of devices use
it, unnamed, with no limit. That is every POS sale taken before named registers
existed and every sale a free store takes now, so a free store's POS (and every
POS build that predates registers) behaves exactly as it did.

## What the plan adds

NAMED registers at a location, each with its own identity on POS sales and its
own line in the daily summary.

| Action | Route (`/admin/stores/:storeId/pos-registers`) | Permission | Plan |
|---|---|---|---|
| List | `GET /` (`locationId`, `includeArchived`) | `draft_orders:write` or `locations:write` | free |
| Create | `POST /` | `locations:write` | consumes 1 (`total`) in the row's transaction |
| Rename | `PATCH /:id` | `locations:write` | free |
| Remove | `DELETE /:id` | `locations:write` | releases 1 in the same transaction |
| Daily summary | `GET /summary` (`from`, `to`, `locationId`; ≤ 92 days) | `stats:read` | free |

- **Removing** deletes a register that never took a sale and ARCHIVES one that
  did (`archived_at`): `orders.pos_register_id` is RESTRICT, so a sale's
  register stays part of its record and keeps its name in the summary.
- **A sale** names its register in `POST …/draft-orders/:id/complete`
  (`{ registerId }`). It is honoured only when the register is live, at the
  draft's location, in the same store, AND the store holds the capability
  (`holdsCapability`, still true at the allowance ceiling). Anything else is
  recorded on the default register. A plan decision never refuses a sale.
- **When a plan ends**, nothing is deleted: registers and their attributed sales
  stay listed and summarised, registers can still be renamed and removed, new
  sales fall back to the default register, and creating a register is refused
  (`PLAN_CAPABILITY_REQUIRED`). The POS hides its register picker
  (`attributionActive: false`).

## The summary

Per UTC day, location, register (default included) and currency: the count and
the summed shop-side grand total of POS sales whose payment was taken
(`payment_paid_at`) in the window. A refund is its own record and does not
reduce a day's takings. The location is the draft's, read through
`draft_orders.converted_order_id`.

## Integrity

- `pos_registers (location_id, store_id)` → `locations (id, store_id)` and
  `orders (pos_register_id, store_id)` → `pos_registers (id, store_id)` are
  composite keys: a register cannot sit at, or be named by a sale of, another
  store.
- `orders_pos_register_channel_check`: only a store's POS order names a register.
- Live names are unique per location, case-insensitively.
- A location with a live register cannot be deleted until the register is removed.

## Not in v1

Register sessions (open/close a shift with expected vs counted cash) and
per-device enrolment. A device chooses its register in the POS store setup and
remembers it; the server does not bind devices to registers.
