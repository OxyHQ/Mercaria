# CrowdSource moderation: reports, cases, decisions, enforcement


Abuse reports leave Mercaria durably, CrowdSource decides them with a randomly
drawn jury, and decisions come back signed. **CrowdSource owns cases, reviews and
decisions; Oxy Trust owns reputation; Mercaria owns only its own catalogue
enforcement.** Mercaria never computes reputation and never suspends an Oxy
account.

Code lives in `packages/backend/src/services/moderation/`, over four Postgres
tables/repositories (`abuse_reports`, `moderation_outboxes`,
`moderation_events`, `moderation_enforcements` — schema in
`db/schema/moderation.ts`, repositories in `db/moderation/`) and two routes
(`routes/reports.ts`, `routes/crowdsource-webhook.ts`).

### "Report" is two unrelated things in this repo

`report.service.ts`, `shared-types/src/report.ts` and
`/admin/stores/:storeId/reports/*` are the store **SALES ANALYTICS** surface and
have nothing to do with moderation. Abuse reports are `AbuseReport`,
`services/moderation/` and `POST /reports`. Never merge them.

### The four rules that are load-bearing

- **A 201 from `POST /reports` means stored, never "CrowdSource accepted it."**
  `report-intake.service` commits the `abuse_reports` row and its
  `moderation_outboxes` row in ONE `db.transaction(...)`; no outbound request is
  made in the handler. **`enqueueModerationOutboxEvent` refuses the ROOT
  connection** — `db/moderation/transactionGuard.ts`'s `requireTransaction`
  discriminates a real transaction handle from `getDb()` by whether `.rollback`
  is a function (a type alone is not enough: the root `Database` and a
  transaction share the same `DatabaseOrTransaction` type, so a caller that
  forgets to pass the transaction handle would otherwise compile, commit the row
  alone, and pass any test that only asserts the row exists). It is also the
  ONLY writer of that table, so the row IS the job.
- **`routes/crowdsource-webhook.ts` MUST stay mounted before `express.json()`**
  in `app.ts`, beside `/channels/webhooks`, which is there for the same reason.
  The SDK reads the stream itself and REFUSES if a parser got there first, so a
  wrong order breaks every delivery rather than weakening the check.
- **Enforcement is idempotent on `UNIQUE(decision_id, revision, action)`** on
  `moderation_enforcements`. Each action CLAIMS its row with
  `.onConflictDoNothing()` before acting. `revision` is in the key so a
  correction's `restore` is a *different* action from the removal it supersedes;
  drop it and an accepted appeal can never relist the item.
- **Evidence carries bare Oxy `fileId`s, never a `mercaria.co` URL.** A
  reviewer's browser fetching such a URL would tell this host when its content is
  under review.

### Mercaria's enforcement levers

`CROWDSOURCE_ENFORCEMENT_MODE` is `observe`, `manual` or `automatic`, defaulting
to **`observe`**, which computes and RECORDS the identical plan and changes
nothing. The mapping lives in `enforcement-plan.ts` (pure, table tested).
Mercaria maps `recommendedActions`, not findings, with severity as a fallback
only.

- `restrict` sets `Listing.status = 'restricted'` (or `Review.status = 'hidden'`).
  Every catalogue read filters `status: 'active'`, the cart marks a non-active
  line stale, and checkout refuses stale lines, so ONE field delists AND unsells
  with **no query to edit**. The seller's real status survives in the enforcement
  row for the restore.
- `freeze_transaction` sets `Order.moderationHold`, refused by
  `order.service.transition`. **This is distinct from `restrict`**, which only
  stops NEW sales; the two survive collapse together, because a delisted
  counterfeit whose in-flight orders still ship is the bug that pairing prevents.
  `cancelled` stays reachable so a buyer is never trapped.
- `request_changes` returns the listing to `draft` and notifies the seller
  (`listing_changes_requested`). It is the commerce-only middle ground: the
  seller can fix and republish it themselves.
- `label`, `age_gate` and `reduce_distribution` become `manual_review`. Mercaria
  has no middle setting between listed and unlisted, and recording an effect that
  did not happen is worse than mapping honestly.

**Two enforcement ESCAPES are closed in pre-existing commerce code**, and a
reviewer reading `services/moderation/` would never see them, so do not remove
them: `catalog-write.service.updateListing` refuses to set `restricted` or to
move a listing out of it (a seller could otherwise PATCH `status:'active'` and
undo a jury silently), and `order.service.transition` refuses to advance a held
order.

### Subject providers: what Mercaria sends, and what it deliberately does not

`subjects/registry.ts` decides DELIVERY and nothing else. **A reported type with
no provider is stored locally, NOT refused**: gating the route on the registry
would make adopting CrowdSource a breaking change for every report surface not
yet wired to it.

- Delivered: `listing` to `commerce.listing`, `review` to `commerce.review`.
  Pinned by a test.
- Stored only: `seller`, `store`. `SellerProfile` stores no user-authored
  identity to pin (display name and avatar are read live from Oxy) and
  `applicationId` comes off the credential, so a case would open in Mercaria's
  tenant naming an object only Oxy can act on. That is a missing provider, not a
  refused report.

**Evidence is declared, not attached.** `AssetRef` requires a `sha256`; Mercaria
stores `{fileId, alt, position}` and never calls `configureServiceAuth`, so
`getServiceAssetMetadataByIds` would throw. Closing it needs Oxy service
credentials and nothing else, and then the digest MUST also enter the snapshot
hash.

**Nothing the envelope builder composes may vary between two deliveries of one
report.** Ingress fingerprints it, so an invented timestamp or an unsorted list
turns a legitimate outbox retry into a permanent 409, silently, days later. Hence
`submittedAt` is the report's own `createdAt`, and allegation codes are sorted
and deduped.

### Environment

Names come from the packages, not from a plan table:

```
CROWDSOURCE_ENABLED=false
CROWDSOURCE_SERVICE_KEY=            # applicationId:credentialId:secret, ONE opaque value
CROWDSOURCE_BASE_URL=               # optional
CROWDSOURCE_WEBHOOK_SECRET=
CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS=   # both accepted during a rotation
CROWDSOURCE_OUTBOX_BATCH_SIZE=50
CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS=5000
CROWDSOURCE_ENFORCEMENT_MODE=observe
```

**There is no `CROWDSOURCE_APP_ID`, and never add one.** `applicationId` is read
off the credential; a variable holding it could only ever disagree, and a surface
able to carry one independently is a cross-tenant IDOR. `CROWDSOURCE_ENABLED=true`
requires BOTH the service key and the webhook secret (enforced in
`config/index.ts`), because a half-configured integration sends reports that can
never come back.

### Lifecycle

`startModerationOutboxDispatcher` runs on EVERY task. Claims are
`SELECT ... FOR UPDATE SKIP LOCKED` against `moderation_outboxes` with an
owner check, so N dispatchers drain the queue without handing each other the
same row, and a dead task's expired lease is reclaimable. It no-ops when
CrowdSource is off: the LOOP is gated, never the durable record, so reports
taken while disabled deliver once it is switched on. The webhook dedupe store
is **Postgres backed** (`moderation-event.store.ts`, an
`INSERT ... ON CONFLICT (id) DO NOTHING ... RETURNING` claim on
`moderation_events`) because Mercaria runs several ECS tasks, and the SDK's
in-process default would dedupe only the task that received both copies. The
conflict is not an error to catch — the empty vs. one-row `RETURNING` set IS
the "already claimed" answer, so a real failure (a dropped connection, pool
exhaustion) still propagates instead of being read as a duplicate.

`app.ts` exists so the app can be built without listening, which is what lets the
raw-body invariant be asserted against the REAL middleware chain.

### Testing: the moderation writes run against a REAL Postgres server

`packages/backend/vitest.pg.globalSetup.ts` creates one throwaway,
fully-migrated Postgres database per suite run (see "PostgreSQL" above);
`services/__tests__/moderation-writes.realdb.test.ts` runs against it. **Do not
convert those tests to mocks.**

The rest of this backend's tests mock their drizzle repositories, which is fine
for logic and has one blind spot that matters here: **a mocked `insert`/`update`
accepts any statement, including one the server rejects outright** — a real
CHECK, unique index, or the `requireTransaction` guard has no mocked
counterpart. This is where `enqueueModerationOutboxEvent`'s no-op guarantee is
actually pinned: `ON CONFLICT (id) DO NOTHING` writes nothing at all on a
repeat — no tuple version, no timestamp, no lock — for a STRUCTURAL reason
rather than by matching a spelling. Mutating the enqueue to
`.onConflictDoUpdate(...)` with the SAME values still moved `updated_at` by the
duration the test waits (drizzle applies the column's `$onUpdate` to a conflict
branch's `set`, so "write the same data back" is not even a quiet write) and
moved the row's `xmin`; both are asserted, and the `xmin` check is what would
still catch a `DO UPDATE` careful enough to leave every column alone. What that
buys is worth stating plainly: a repeat is a genuine no-op by construction, not
by a flag someone has to remember to pass — and a repeat is ordinary (a
transaction retry, two concurrent duplicate submissions, a reconciliation sweep
re-deriving an event), running while the dispatcher holds leases on those same
rows.

A real server, not a mock: `db.transaction(...)`/`requireTransaction`, unique
indexes and `FOR UPDATE SKIP LOCKED` are the properties under test and none of
them exist without one.
