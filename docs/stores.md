# Stores: ownership, access and the move to Oxy accounts

The decision is [ADR 0012](adr/0012-store-ownership-is-an-oxy-account.md). This
is how it works and how to operate it.

## The model in one paragraph

`stores.oxy_account_id` is the Oxy account that owns the store. Who may act for
the store is that account's membership in Oxy, resolved per request with the
caller's own bearer; their Oxy role becomes Mercaria permissions through
`STORE_ROLE_PERMISSIONS` (`packages/shared-types/src/store.ts`), adjusted by
their row in `store_permission_overrides`, if any. The code is
`services/store-access.service.ts` (the decision), `services/oxy-account-graph.ts`
(the two Oxy calls), and `middleware/store-authz.ts` (`loadStore` attaches
`req.store` and `req.storeAccess`; `requireStorePermission` gates on it).

## API

| Route | Gate | What |
|---|---|---|
| `POST /admin/stores` | owner/admin of `oxyAccountId` (default: the session's account) | create a store under that account |
| `GET /admin/stores` | — | every store owned by an account Oxy lists for the caller (one `GET /accounts`), each with the caller's `access` |
| `GET /admin/stores/:storeId` | any role on the owning account | the store, `oxyAccountId` and the caller's `access: { role, permissions }` |
| `PATCH /admin/stores/:storeId/owner-account` | `store:manage` here AND owner/admin of the target | move the store to another Oxy account |
| `GET /admin/stores/:storeId/permission-overrides` | `members:manage` | every exception on the store |
| `PUT /admin/stores/:storeId/permission-overrides/:oxyUserId` | `members:manage`, and only permissions the caller holds | replace one person's exception; two empty sets delete it |
| `DELETE …/permission-overrides/:oxyUserId` | `members:manage` | remove one exception |

`503 SERVICE_UNAVAILABLE` from any store route means Oxy could not be asked; the
request was refused, not guessed.

## Who belongs, and how to add people

Mercaria has no "invite member". People are added to the OWNING ACCOUNT in Oxy —
from the Oxy account settings, or in the dashboard's People & permissions screen,
which reads the organization's members with the Oxy SDK. A store still owned by
a personal account has exactly one person: its owner. To add anybody, the owner
converts it:

1. `oxy.accounts.create({ kind: 'organization', username, name: { displayName } })`
   with the owner's session — they become the organization's `owner`;
2. `oxy.accounts.members.invite(orgId, { usernameOrEmail, role })` per person
   (Oxy invites by username or email only; the dashboard resolves the ids it
   knows with `users.getMany`);
3. `PATCH /admin/stores/:storeId/owner-account { oxyAccountId: orgId }`.

A failure after step 1 leaves an organization with no store; nothing in the SDK
reverses it, and the dashboard reports it rather than cleaning up.

## Deploying `0158`/`0161`, and who loses access

Both ship in ONE release with the GoWay place migrations: `Migrate (pre)`
applies `0158`, `0159` and `0160`, `Migrate (post)` applies `0161` and `0162`
(the full order and why it is forced: `docs/pickup.md`, "One release").

`0158` (pre) adds the column and the overrides table and backfills each store's
owning account from its EARLIEST `owner` member. `0161` (post) re-runs that
backfill for stores the previous image created during the rollout, refuses to
apply if any store still has no owner, copies every non-owner member's
NON-DEFAULT grants into overrides, and drops `store_members`.

**Every member other than the chosen owner loses access at `0161`** — `admin`,
`staff` and any second `owner` — until the owner converts the store and adds
them. Count them before the deploy, and keep the list: after `0161` Mercaria no
longer knows who they were. Run the third query too: a store it lists makes
`0161` refuse, and the post phase applies in one transaction, so `0162` waits
with it until the store has an owner and `Migrate (post)` is re-run.

```sql
-- Stores that will lose people, and how many.
select store_id, count(*) - 1 as losing_access
from store_members group by store_id having count(*) > 1 order by 2 desc;

-- Who, with the owner each store will keep.
select m.store_id, m.oxy_user_id, m.role, m.permissions, m.joined_at
from store_members m order by m.store_id, m.joined_at;

-- Stores 0161 will refuse: no owner member at all.
select s.id from stores s
where not exists (select 1 from store_members m where m.store_id = s.id and m.role = 'owner');
```

## Where a caller session is not available

- **Notifications** go to `stores.oxy_account_id`.
- **Self-referral** treats the owning account or an override holder as related;
  anything else is NOT ESTABLISHED (the job has no session, and the referral
  domain makes no outbound call).
- **MCP store tools** are allowed only to the owning account itself.
- **Socket `subscribe-store`** asks Oxy with the handshake's bearer.

## Known gaps in Oxy (`@oxy.so/core` 4.2.0)

- There is no service-token endpoint that answers "is X a member of Y", so every
  membership question needs the member's own bearer.
- `accounts.members.invite` takes a username or email, never an account id.
- A capability ticket carries the effective account but not the operator, so
  an editor operating an organization through an agent gets the organization's
  full store authority there (D6 of the ADR).
