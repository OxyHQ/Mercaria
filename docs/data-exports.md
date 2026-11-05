# Store data exports

A store's own orders, products and customers as CSV — **on demand, free, for
every store** — and the paid `scheduled_exports` capability, which produces the
same file on a schedule. Code: `services/data-exports/`, routes
`/admin/stores/:storeId/exports/*`, tables `data_export_schedules` and
`data_export_runs` (`db/schema/dataExports.ts`). Dashboard: Settings → Export
data (`settings/exports.tsx`, free) and Tools → Scheduled exports
(`tools/scheduled-exports.tsx`, behind `PlanToolGate`).

## One file, two ways to ask for it

An on-demand export and a scheduled occurrence are the same `data_export_runs`
row shape, read by the same dataset reader (`services/data-exports/datasets.ts`)
and stored the same way, so a scheduled file is the file an on-demand export of
the same moment would be. Each reader pages through the call the dashboard's
list screen already makes — `getStoreOrders` (the merchant projection: no buyer
account email), `findStoreListingsPageForAdmin` + `hydrateListings` (one row per
variant), `listCustomers` + `toCustomerDTO` — so an export never carries more
than the merchant already reads. Amounts are plain decimals in the currency's
own precision, never through a float; every text cell is guarded against
spreadsheet formula injection. Columns are only ever appended.

A dataset needs the permission reading it already needs: orders `orders:read`,
products `products:read`, customers `customers:read`
(`DATA_EXPORT_DATASET_PERMISSIONS`). That applies to exporting, scheduling,
listing and downloading alike; a schedule or run for a dataset the caller cannot
read answers 404.

## What the plan gates

`scheduled_exports` is `per_period` and buys only the SCHEDULE:

| Action | Plan |
|---|---|
| Export on demand, list schedules and runs, download, pause, delete | never asked |
| Create a schedule; an edit that leaves one enabled (incl. re-enabling) | `requireCapability` |
| Each scheduled occurrence | `consumeCapabilityOrThrow` — one unit, in the transaction that materializes the run, before any file is produced |

A refused occurrence is recorded on its run (`skipped_limit` or
`skipped_not_entitled`) and the schedule moves on to its next occurrence — no
retry. A unit is never given back: a period allowance measures use. When a plan
ends nothing is deleted: schedules stay (and keep recording skipped
occurrences until paused), past runs and files in retention stay downloadable,
and on-demand export is unaffected.

## The worker

`startDataExportWorker` runs on every task (`DATA_EXPORT_WORKER_ENABLED`,
default on; `DATA_EXPORT_POLL_INTERVAL_MS`, `DATA_EXPORT_BATCH_SIZE`,
`DATA_EXPORT_LEASE_MS`). Each pass:

1. **Releases expired files** — clears `file_id` once `file_expires_at` (30 days)
   passes; the `data_export_file` reference trigger withdraws the Oxy reference
   and Oxy collects the bytes. The row stays (swept after a year,
   `db/expiryTargets.ts`).
2. **Materializes due schedules**, one transaction each: lock the schedule
   `FOR UPDATE SKIP LOCKED`, insert the occurrence's run (unique per
   `(schedule_id, occurrence_at)`), take the allowance, advance the schedule to
   the next occurrence after NOW — so a schedule reached late runs once, never
   once per missed day.
3. **Produces pending runs** under a renewed lease with an owner check: read the
   dataset (at most 100,000 rows, newest first; more marks the run `truncated`),
   upload a PRIVATE application file to Oxy Files, complete. A failure backs off
   (1 min doubling, capped at 30) and is `failed` after four attempts.

The lever gates the loop and nothing durable: an on-demand export is also
produced inline by the request that asked, so the free path works with the loop
off. One OPEN on-demand run per store and dataset (a partial unique) keeps a
repeated click from reading the store twice.

## Schedules

Daily, weekly (a weekday) or monthly (a day 1–28, which every month has), at a
local hour in an IANA time zone (checked against the runtime). A local hour in a
spring-forward gap runs at the end of the gap; one that repeats runs at the
first. At most 20 schedules per store — a bound on configuration, not a plan
limit.

## Downloads

`GET …/runs/:runId/download` answers a short-lived URL minted by Oxy for the
private file, after the dataset permission check; 410 once the file is gone. The
URL is never cached or stored.

## Not built

No notification on completion (Mercaria's notifications are per Oxy user and
the dashboard has no feed; a store has no member list to address), no email, no
formats beyond CSV, no delivery to an external destination (SFTP, webhook,
cloud bucket) and no column selection.
