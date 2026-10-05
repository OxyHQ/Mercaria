# ADR 0012: A store is owned by an Oxy account, and Oxy decides who gets in

- **Status:** Accepted
- **Date:** 2026-10-04
- **Supersedes:** the store member model (`store_members`, roles
  `owner | admin | staff`) the Mongo port carried over. Nothing in ADRs
  0001–0011 is reopened; where they say "a store member with `store:manage`",
  read "a caller holding `store:manage` on the store".
- **Org-wide rule it implements:** `~/Oxy/docs/api-conventions.md`, "Cross-app
  references" — *ownership of a business is an Oxy account, usually
  `kind=organization`; products store its id as `oxyAccountId` and check
  membership with Oxy; they never keep a parallel member list.*

## Context

Mercaria kept its own list of who may act for a store: `store_members`, one row
per person with a Mercaria role and an explicit grant array. Oxy already has
the same thing, and a better one: every account is a `users` row, accounts form
a tree (`parentAccountId`), and `account_members` carries a role
(`owner | admin | editor | developer | billing | viewer`) inherited down the
tree, with acting-as an organization done by switching session
(`accounts.actAs`). A business that sells on Mercaria and lists itself on GoWay
had to be assembled twice, by hand, with nothing keeping the two lists in step —
removing somebody from the business removed them nowhere.

## Decisions

### D1. `stores.oxy_account_id` names the owning Oxy account

`text NOT NULL`, indexed, no foreign key (Oxy owns identity, CONVENTIONS "the
fact that shapes everything"). Usually an organization; a person's personal
account is equally valid, and every store that predates this ADR starts on its
earliest owner's personal account — a personal account id and an organization
id share one id space, so the backfill is a copy (`drizzle/0158`, `0161`).

### D2. Oxy decides who gets in; the role map decides what they may do

Access to a store is a role on its owning account, resolved per request:

1. **The session IS the owning account, undelegated** (`getOxyActor()` reports
   the account as its own actor): `owner`, with no round trip.
2. **Anything else asks Oxy with the caller's own bearer** — `GET
   /accounts/:id`, whose `callerMembership` (or `relationship: 'self'`) is
   Oxy's resolution, inheritance down the tree included.

Rule 1 excludes a delegated session on purpose. A person who switched into an
organization authenticates AS it, but Oxy authorizes that session as the human
operator — and an `editor` holds `account:act_as`. Treating "the session is the
owning organization" as ownership would give every editor who switched in the
`store:manage` their role withholds.

The role becomes permissions through ONE closed map in shared-types,
`STORE_ROLE_PERMISSIONS`:

| role | permissions |
|---|---|
| `owner` | all 18 |
| `admin` | all but `store:manage` (17) |
| `editor` | catalogue (`products:read/write`, `inventory:write`, `collections:write`, `locations:write`, `discounts:write`) **and** the shop floor (`orders:read`, `orders:fulfill`, `customers:read/write`, `draft_orders:write`, `stats:read`) |
| `developer` | `channels:write`, `products:read` |
| `billing` | `stats:read`, `analytics:read`, `orders:read` |
| `viewer` | `products:read`, `orders:read`, `stats:read` |

Three choices in it, each argued:

- **`editor` carries the shop floor.** Every existing non-owner member is
  `staff` and Oxy has no `staff`; conversion maps `staff` → `editor`. An editor
  who could not ring up a POS draft order or fulfil one would strand every
  cashier the conversion moves.
- **`billing` gets no payment permission because none exists.** Payment
  onboarding and fee acceptance are `store:manage` (a binding commercial act,
  AGENTS.md), and `refunds:write` moves money OUT. Billing reads money in.
- **`viewer` reads the trading record only** — not `customers:read` (buyer
  personal data) and not `analytics:read` (#86 privacy 3 asks for an explicit
  grant).

### D3. Mercaria keeps exceptions, never members

`store_permission_overrides (store_id, oxy_user_id, granted[], revoked[],
updated_by_oxy_user_id, …)`. Effective permissions are
`(role defaults ∪ granted) − revoked`; a revoke beats a grant. An override
never admits anybody: no role, no access, whatever the row says. The owning
account takes no override (it holds everything and is nobody's member). CHECKs
hold the vocabulary, keep the two sets disjoint and refuse an empty row — "no
exception" is the absence of one. Writing one needs `members:manage` and only
permissions the writer holds (Oxy's own escalation rule).

### D4. Failure is closed

An Oxy outage refuses with `503 SERVICE_UNAVAILABLE`; a 403/404 from Oxy is an
answer (no access); a 401 sends the caller to sign in again. Roles are cached
in-process for 45 s (an absence for 10 s), keyed on the human actor and the
account — never on the session's account, which two people operating one
organization share. A caller whose actor Oxy did not report is never cached.

### D5. Ownership moves explicitly, and only between governors

`POST /admin/stores` takes an optional `oxyAccountId` (default: the session's
account) and requires the caller to be that account undelegated, or its owner
or admin. `PATCH /admin/stores/:storeId/owner-account` requires `store:manage`
on the store AND owner/admin of the target. The dashboard's "Convert to
organization" runs with the owner's session: `oxy.accounts.create({ kind:
'organization' })`, `accounts.members.invite` per person, then the PATCH.

### D6. Surfaces without a caller session read only Mercaria's own rows

Membership in an organization is answerable only with a member's bearer. So:

- **Notifications** (order events, low stock, reviews, moderation) go to the
  owning account — its inbox is Oxy's to fan out.
- **Self-referral** (attribution runs in a job, and the referral domain makes
  no outbound call) establishes "related" as *owning account OR override
  holder* and otherwise leaves the fact NOT ESTABLISHED — never `false`.
- **MCP capability tools** carry the effective account and no session: a store
  tool is allowed only to the owning account itself. An agent acts AS the
  organization.

## Consequences

- **Existing non-owner members lose access at `0161`** — `admin`, `staff`, and
  any second `owner` — until the store's owner converts it to an organization
  and adds them. Their non-default grants survive as overrides and take effect
  again the moment they are members. A member who held only their role's
  defaults leaves no trace: count and notify before deploying
  (`docs/stores.md`).
- `store_linkage_requests.impact_store_members` is dropped: a count of a
  membership model that no longer exists.
- Every admin request for a non-owner costs one Oxy round trip per 45 s per
  person and account.

## Rejected

- **Keep `store_members` and sync it from Oxy.** Two lists that can disagree is
  the problem, with a sync job added.
- **Treat a delegated session as the owning account.** See D2.
- **Let an override grant access by itself.** It would rebuild the member list
  under another name.
