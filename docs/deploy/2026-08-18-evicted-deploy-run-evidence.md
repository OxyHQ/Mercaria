# Evicted deploys: the measured run history behind #574

> **Read 2026-08-18.** Raw evidence for #574 and for
> `docs/deploy.md` §"What is merged is asserted to have shipped". Committed
> because **GitHub Actions run history ages out of easy reach** — retention
> expires, and once these runs are gone a workflow change defended by "an
> evicted deploy skips its migration" is a paragraph of YAML reasoning wearing a
> measurement's clothes. The run ids below are the citation.
>
> **The window is pinned to run numbers, not to a date range**, because the
> repository is live and every figure here moved while it was being written: the
> first pass over this same history counted 300 runs, 41 cancelled and 36
> windows; twenty minutes later it was 298 completed, 42 and 37. Re-deriving
> against "the last four weeks" will not reproduce this table. Re-deriving
> against runs 60–358 will.
>
> Runs still in flight at read time are EXCLUDED — an unfinished run is not an
> unshipped commit, and counting it inflates the window count by one.

## The mechanism

`deploy-aws.yml` uses one concurrency group per ref with
`cancel-in-progress: false`. GitHub keeps at most one PENDING run per group, so
a third arrival **evicts the queued second**, which then executes nothing: no
rollout, no migration, no notification. The setting is correct and is not what
#574 changed — see `docs/deploy.md` for why the two alternatives are unsafe
rather than merely expensive.

An eviction is harmless **exactly when the run that evicted it succeeds**. The
evictor is always a descendant, so it ships a superset of the code, and the
post-migration step applies whatever the ledger says is pending. Nothing
asserted that condition, which is the hole.

Window read: `deploy-aws.yml` runs on `main`, run numbers 60–358
(2026-07-29T04:19:13Z .. 2026-08-17T21:55:18Z), 298 runs.

Conclusions: **232** success, **15** failure, **9** action_required, **42** cancelled.

## Every window in which a merged commit was not in production

A maximal run of consecutive non-success runs. `run id` is the Actions run,
citable at `https://github.com/OxyHQ/Mercaria/actions/runs/<id>` while retention lasts.

| # | opened (UTC) | runs | head shas | run ids | new `post` migration |
|---|---|---|---|---|---|
| 1 | 2026-08-08 14:16:41 | 10 | `0046e27a`/failure<br>`02466121`/failure<br>`43314cc8`/action_required<br>`43314cc8`/action_required<br>`42a2f8ad`/action_required<br>`084f4af2`/action_required<br>`3cced488`/action_required<br>`c592de83`/action_required<br>`ddb02576`/action_required<br>`7e4858e6`/action_required | 31261550068<br>31263548514<br>31263904439<br>31263963083<br>31264185956<br>31265955289<br>31267084375<br>31267900322<br>31269963537<br>31272853192 | **`0003_retire_legacy_payment_columns.sql`, `0005_drop_empty_string_defaults.sql`** |
| 2 | 2026-08-08 21:48:26 | 1 | `9d334714`/action_required | 31280197474 | — |
| 3 | 2026-08-09 06:08:33 | 1 | `ece8c46a`/failure | 31298220813 | — |
| 4 | 2026-08-09 21:44:19 | 1 | `66261a79`/failure | 31337606367 | — |
| 5 | 2026-08-09 22:55:32 | 1 | `7e22da69`/failure | 31340612727 | — |
| 6 | 2026-08-10 02:15:29 | 1 | `360dffb4`/failure | 31349297966 | — |
| 7 | 2026-08-10 06:21:52 | 1 | `13daab33`/failure | 31361691343 | — |
| 8 | 2026-08-10 10:18:00 | 1 | `c609cce3`/failure | 31378525024 | — |
| 9 | 2026-08-10 11:24:28 | 1 | `2159b212`/cancelled | 31383361891 | — |
| 10 | 2026-08-15 16:56:26 | 1 | `8107c41f`/failure | 31896899491 | — |
| 11 | 2026-08-15 18:18:40 | 1 | `c10761c0`/failure | 31900773365 | — |
| 12 | 2026-08-16 08:12:01 | 1 | `045a797b`/cancelled | 31935845770 | — |
| 13 | 2026-08-16 08:38:17 | 3 | `a5190279`/cancelled<br>`9d91b462`/failure<br>`675bd8f1`/cancelled | 31936954122<br>31937267361<br>31938087391 | — |
| 14 | 2026-08-16 11:59:01 | 1 | `1286f733`/cancelled | 31945806523 | — |
| 15 | 2026-08-16 13:33:33 | 1 | `f1ae6c84`/cancelled | 31950159309 | — |
| 16 | 2026-08-16 14:05:28 | 1 | `4f41b296`/cancelled | 31951694859 | — |
| 17 | 2026-08-16 14:20:28 | 2 | `350db3c6`/cancelled<br>`08d4171d`/failure | 31952422785<br>31952609836 | — |
| 18 | 2026-08-16 19:59:18 | 1 | `c203df85`/failure | 31969202900 | — |
| 19 | 2026-08-16 21:58:53 | 1 | `7e9e73a1`/cancelled | 31975054436 | — |
| 20 | 2026-08-16 23:25:41 | 1 | `c867eada`/cancelled | 31979096666 | — |
| 21 | 2026-08-17 01:19:47 | 1 | `f046c3e8`/cancelled | 31984633168 | — |
| 22 | 2026-08-17 03:38:29 | 1 | `2155037d`/cancelled | 31991808788 | — |
| 23 | 2026-08-17 04:39:48 | 1 | `59ee9c40`/cancelled | 31995255833 | — |
| 24 | 2026-08-17 07:06:06 | 1 | `9e5347af`/cancelled | 32004324536 | — |
| 25 | 2026-08-17 07:22:33 | 3 | `0f93aecd`/cancelled<br>`01a5e50c`/cancelled<br>`61e21d7f`/failure | 32005528306<br>32005570116<br>32005700194 | — |
| 26 | 2026-08-17 08:31:34 | 2 | `9cd331aa`/cancelled<br>`fad018f1`/cancelled | 32010780014<br>32011215334 | — |
| 27 | 2026-08-17 08:45:07 | 4 | `81448ac6`/cancelled<br>`c82ed408`/cancelled<br>`ae0bcdef`/cancelled<br>`ac56755b`/cancelled | 32011847827<br>32012251125<br>32012280460<br>32012340644 | — |
| 28 | 2026-08-17 09:18:13 | 7 | `6fda8c76`/cancelled<br>`4af9503c`/cancelled<br>`192ff190`/cancelled<br>`9176f49c`/cancelled<br>`ef1edc46`/cancelled<br>`2aed333a`/cancelled<br>`857463b0`/cancelled | 32014515804<br>32014609174<br>32014620262<br>32014631825<br>32015135856<br>32015409794<br>32015425128 | — |
| 29 | 2026-08-17 09:35:19 | 3 | `7fc80a2d`/cancelled<br>`e1a66322`/cancelled<br>`472bfd03`/cancelled | 32015992207<br>32017004975<br>32017017915 | — |
| 30 | 2026-08-17 09:59:46 | 3 | `7bbb8055`/cancelled<br>`581c0dba`/cancelled<br>`431e38e8`/cancelled | 32017981848<br>32018206539<br>32018331570 | — |
| 31 | 2026-08-17 17:27:41 | 2 | `ca2722a8`/cancelled<br>`7071d999`/cancelled | 32050424488<br>32050471530 | — |
| 32 | 2026-08-17 18:16:35 | 1 | `203d8754`/failure | 32054129508 | — |
| 33 | 2026-08-17 18:39:57 | 1 | `ff072d6e`/cancelled | 32056000086 | **`0106_panoramic_patch.sql`** |
| 34 | 2026-08-17 19:07:11 | 1 | `f4691434`/cancelled | 32058574249 | — |
| 35 | 2026-08-17 19:17:53 | 1 | `b7e96bed`/cancelled | 32059562905 | — |
| 36 | 2026-08-17 19:31:56 | 1 | `d5fb6d8f`/cancelled | 32060862290 | — |
| 37 | 2026-08-17 21:55:18 | 1 | `b0dd47c9`/cancelled | 32073541804 | — |

**37 windows; 2 contained a newly added `post` migration.**
Longest window: 10 consecutive runs.

Time each unshipped commit waited for a covering success: min 12.4 min, median 23.1 min, max 358.2 min (n=65).

## What the check reports, replayed over the same history

| workflow | runs | covered | deferred (run in flight) | REPORTED |
|---|---|---|---|---|
| `deploy-aws.yml` | 298 | 150 | 125 | **23** |
| `deploy-cloudflare.yml` | 213 | 191 | 13 | **9** |
| `deploy-dashboard.yml` | 203 | 184 | 11 | **8** |
| `deploy-pos.yml` | 200 | 179 | 11 | **10** |

`deploy-aws.yml` shows more deferrals than the web deploys because it is the one
workflow that SERIALISES: with `cancel-in-progress: false` there is almost
always a successor already running when an evicted run reports. That is the
column which turns 65 non-success runs into 23 reports rather than 65.

## Two windows that carried an unapplied schema change

- **Window 1, 2026-08-08 14:16:41, 271.6 minutes, 10 runs.** Carried
  `0003_retire_legacy_payment_columns.sql` and
  `0005_drop_empty_string_defaults.sql`. These are `action_required`/`failure`
  rather than evictions — it is the day every run was held by GitHub's
  malicious-workflow detection — but the invariant that failed is the same one:
  `main` held post-phase migrations that were not in the database, for four and
  a half hours, with nothing reporting it.
- **Window 33, 2026-08-17 18:39:57.** `ff072d6e` (#562's merge) carried
  `0106_panoramic_patch.sql` and was evicted by `f38227b7`, run
  `32056447359`, which succeeded four minutes later and applied it. This is the
  window #574 was opened for.

`f38227b7` added **no migration of its own**. It applied `0106` because the
detection step greps the whole journal rather than the release's diff, so the
post task runs on every release and applies whatever is pending. **That is the
recovery, and narrowing that grep would delete it** — guarded by
`deployWorkflow.test.ts`.

## The branch that makes eviction unsafe, and it has happened

**Window 25, 2026-08-17 07:22:33.** `0f93aecd` evicted, `01a5e50c` evicted, and
then `61e21d7f` — the run that was covering both — **failed**. Three merged
commits, none shipped, for 16.4 minutes, and nothing said so. Across the pinned
window, **19 evictions had an evictor that did not itself succeed.**

This window is also what caught a bug in the check itself. Ordering coverage by
when a run FINISHED reports 1 unshipped commit here, because the covering
success (`ae3ed27e`) was created first and completed last, so it sorts above the
cancellations it never covered. Ordering by `run_number` reports the true 3.

## Reproducing this

`.github/scripts/require-deploy-coverage.mjs` exports `judgeCoverage`, which
takes a run list and returns the verdict, so the replay is the production
function over the API's own history — not a second implementation. The scripts
that produced these tables read
`/repos/OxyHQ/Mercaria/actions/workflows/<file>/runs?branch=main`, reconstruct
each run's state as of each completion instant, and call it.
