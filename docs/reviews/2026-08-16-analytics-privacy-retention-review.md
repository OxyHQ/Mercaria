# Privacy and retention review — discovery analytics (#77 acceptance 8)

**Date:** 2026-08-16
**Scope:** `services/analytics/`, `db/analytics/`, `db/schema/analytics.ts`,
`db/expiryTargets.ts`, `POST /analytics/events`, `/internal/analytics/*`,
`GET /admin/stores/:storeId/analytics/summary`.
**Revision reviewed:** `origin/main` at `c25d3c3`, plus the two fixes this review
landed (below).
**Status of the subject:** `ANALYTICS_COLLECTION_MODE=off` in production.
`docs/analytics.md` §"The privacy and retention review" says it stays off until
this document exists. **This document does not by itself authorise turning it
on** — see §9.

Every finding below is marked **MEASURED** (I ran it), **READ** (I read the code
and am reporting what it says) or **INFERRED** (a conclusion I drew that nobody
has executed). Numbers I did not produce myself are not in this document.

---

## 1. Summary

The domain's central design claim — *an allow-list of typed columns, and the
ABSENT columns are the enforcement* — holds. I could not find a property bag, a
contact column, a second identity column, a way to UPDATE a stored event, a
bypass of the query reporting floor, or a path by which a client asserts a
payment. The gates that claim vacuity floors and mutation self-tests have real
ones.

What does not hold is the part of the design that is **arithmetic rather than
structure**. The three highest findings are all of that shape: a retention
window applied twice, a redaction pattern set whose separator classes do not
match how people paste, and a merchant figure that is structurally unmeasurable
and is published as zero. None of them is visible to a functional test, and two
of them disable the very detector that exists to notice them.

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F1 | Pseudonym salt is deleted at **90 days, not 45** — the window is applied twice | **High** | **Fixed here** |
| F2 | Redactor leaks full PANs, non-ASCII emails, lowercase IBANs and Spanish national ids; the leak persists in `normalized_tokens` **longer** than in the text | **High** | **Must fix before enabling** |
| F3 | Redactor destroys barcode queries and reports them as `payment_card`; ES street keywords redact whole queries | **Medium** | **Must fix before enabling** |
| F4 | `ANALYTICS_PSEUDONYM_ROTATION_HOURS` is unvalidated in both directions | **Medium** | **Must fix before enabling** |
| F5 | Merchant `checkoutStarts` / `paidOrders` are structurally 0 for every store, forever, and are published as 0 | **Medium** | Must fix before the **merchant surface** is enabled |
| F6 | A second exported reader returns query text with no floor; the module docblock says there is none | **Low** | Report — owner decision |
| F7 | Append-only binds UPDATE only; delete-then-insert is unprevented | **Low** | Accepted residual, stated |
| F8 | Two docblock statements in `redact-query.ts` contradicted the code | **Low** | **Fixed here** |

---

## 2. F1 — the salt outlives the events it is supposed to predecease (High, fixed)

### What the design says

`db/expiryTargets.ts:234-240` and `db/schema/analytics.ts:727-748`:

> A pseudonym SALT is deleted long before the events derived under it — 45 days
> against a discovery event's 90 — so for the second half of an event's life its
> actor dimension is already permanently unlinkable to any session handle.

`services/analytics/identity.ts:167-169` states the failure it is avoiding by
name: measuring the retirement clock from closure rather than from opening is
*"the shape that quietly turns a 45-day guarantee into a 90-day one."*

### What it did

**MEASURED.** Three facts compose:

1. `services/analytics/identity.ts:171` stamps
   `expiresAt = now + RETENTION_SECONDS.analyticsSalt * 1000`, i.e.
   **`opened_at + 45 days`**.
2. `db/expiryTargets.ts:551` (pre-fix) set
   `retentionSeconds: ANALYTICS_SALT_RETENTION_SECONDS`, i.e. **45 days again**.
3. `@oxyhq/db`'s sweep predicate is
   `column <= now() - make_interval(secs => retentionSeconds)`
   (`node_modules/@oxyhq/db/dist/esm/expiry.js:90`).

So the delete fires when `opened_at + 45d <= now - 45d` — **`opened_at + 90
days`**. That is exactly the shape `identity.ts` says it is avoiding, arriving
through the other door.

### Why it matters more than a doubled number

- `RETENTION_DAYS_BY_CLASS` (`services/analytics/envelope.ts:176-181`) gives a
  **discovery** event 90 days. So the salt lived *precisely as long as* the
  largest event class. For a discovery event there was **no** period in which
  its actor dimension was unlinkable — the guarantee was not weakened, it was
  absent. For `commerce_funnel` (180 days) the linkable window doubled from 45
  to 90 days.
- **It disabled its own detector.** `countOverdueSalts`
  (`db/analytics/pseudonymSaltRepository.ts:128-134`) counts
  `expires_at < now`, i.e. the *stamped* deadline. `docs/analytics.md`
  §Operations says `retention.overdueSalts` *"must be ZERO on a healthy
  deployment"* and is *"the one failure in this domain that is invisible from
  everywhere else."* Under the doubled window every epoch is reported overdue
  for a 45-day stretch. At the default 24-hour rotation that is roughly **45
  permanently-overdue salts at steady state**, from day 45 onward, forever. An
  alert on the one counter that can see this failure would have fired
  continuously from day 45 and been muted.
- **Nothing tested it.** `db/__tests__/expirySweeper.realdb.test.ts` asserts the
  registry *names* `analytics_pseudonym_salts` (`:416`) and never asserted a
  salt is actually deleted. Every functional analytics test passes either way.

### The fix

`retentionSeconds: 0`, matching **every other** deadline-column target in the
file. **MEASURED**: of the 30-odd targets, every one whose column is an
`expires_at` / `purge_at` / `retention_expires_at` uses `retentionSeconds: 0`;
the non-zero ones sit on `dismissed_at`, `revoked_at` or `window_started_at`,
plus two deliberate graces (`guest_sessions`, `guest_abuse_interventions`) that
document themselves. The file's own docblock states the rule at `:24` and
`:341`: *"`retentionSeconds: 0` here — the column IS the deadline."* The salt
entry was the only analytics target disobeying the paragraph directly above it.

`RETENTION_SECONDS.analyticsSalt` is kept as the **writer's** stamping offset
and is now documented as such.

### The gate

`expirySweeper.realdb.test.ts` gains *"reaps a retired salt past its stamped
deadline and leaves one still inside it"*, plus a salt in the existing
one-tick-covers-every-target case. It follows the file's own discipline: one
fixture that must GO and one that must STAY, differing only in the measured
column.

**MEASURED — mutation-tested.** With the fix: 12/12 pass. With
`retentionSeconds` restored to the doubled window (mutation applied and diffed
before running): **exactly 2 fail** — the new case and the one-tick case — and
the other 10 pass unchanged. The case is a real discriminator, not a
green-either-way addition.

---

## 3. F2 — what the redactor actually leaks (High, must fix before enabling)

**MEASURED.** I ran ~57 inputs through the **real** `redactSearchQuery`
(imported, not re-implemented), with a positive control asserting the redactor
was reached at all (`redactSearchQuery('ana.lopez@example.com')` → `[redacted]`,
kind `email`). Full corpus in the PR description; the leaks are below. "Leak"
means the value survived in **both** `redactedText` and `normalizedTokens`.

### 3.1 Card numbers with any separator but a space or an ASCII hyphen

The rule is `/\b(?:\d[ -]?){12,18}\d\b/g` (`redact-query.ts:107`). The separator
class is **space or hyphen only**. Measured leaks, every one a complete PAN
surviving with `redactionKinds: []`:

| Input | Result |
|---|---|
| `4111.1111.1111.1111` | untouched |
| `4111/1111/1111/1111` | untouched |
| `4111_1111_1111_1111` | untouched |
| `4111\t1111\t1111\t1111` (tab) | untouched |
| `4111 1111 1111 1111` (NBSP) | untouched |
| `4111 1111…` (narrow NBSP) | untouched |
| `4111 1111.1111 1111` (mixed) | untouched |
| `3782.822463.10005` (Amex, 15) | untouched |

The generic `long_digit_run` catch-all does not save these: it needs
`\b\d{9,}\b`, and no run between separators reaches nine digits.

These are not exotic. A tab is what a spreadsheet paste produces; NBSP is what a
banking app or a PDF produces; a dot is simply how many people write groups.

### 3.2 Emails outside ASCII `\w`

`/\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)+\b/g` (`:87`) has **no `u` flag**, so `\w` is
ASCII. Measured leaks, all untouched with `redactionKinds: []`:

- `josé@example.com` → tokens `["josé","example","com"]`
- `анна@example.com` → tokens `["анна","example","com"]`
- `ana@café.example` → untouched
- `"ana lopez"@example.com` → untouched

The launch market is Spain. An accented local part is ordinary, not adversarial.
Note the domain leaks too, and a domain alone is an employer/ISP identifier.

### 3.3 Lowercase IBAN

`/\b[A-Z]{2}\d{2}…/g` (`:100`) has **no `i` flag**.
`es9121000418450200051332` survives **whole**, and — because it is 24 characters
with no separator — it becomes a **single** `normalized_token`. The uppercase
form and the spaced form are both caught correctly.

### 3.4 Spanish national identity documents

**MEASURED**, and this is the finding most specific to the launch jurisdiction.
`long_digit_run` is `\b\d{9,}\b`; a digit run **adjacent to a letter** has no
word boundary, so none of these matches anything:

| Input | Result |
|---|---|
| `dni 12345678Z` | untouched; token `12345678z` |
| `X1234567L` (NIE) | untouched; token `x1234567l` |
| `nif B12345678` | untouched; token `b12345678` |
| `passport AB1234567` | untouched; token `ab1234567` |

Each becomes **one** normalized token — i.e. the durable copy is the whole
identifier, intact and directly greppable.

### 3.5 Also leaking

- `600/123/456` — the phone rule's separator class is `[ .-]`, no slash.
- IPv6 literals — no rule covers colon-separated hex.
- `cvv 737` survives beside a correctly-redacted PAN. Low value alone; it is
  still cardholder data that must never be stored.
- Street addresses with no keyword from either branch (`14 Rue de la Paix
  Paris`, and by construction German/Italian conventions). This one is an
  **accepted residual** — the module says outright it is best-effort — but it
  should be accepted knowingly rather than discovered.

### 3.6 The compensating control is weaker than documented

`docs/analytics.md` argues the short text retention covers what the patterns
miss, and that deriving tokens from the **redacted** text prevents *"nulling the
text at 30 days leaving the thing it was redacted for standing in the column
that survives."*

That argument only holds **where redaction worked**. Where it did not, the
tokens are the **longer-lived** copy:

**MEASURED** — `redactSearchQuery('contact josé@example.com or
4111.1111.1111.1111')` returns
`normalizedTokens: ["contact","josé","example","com","or","4111","1111","1111","1111"]`.

Lifetimes (**READ**, from the writers):

| Column | Retention | Where |
|---|---|---|
| `analytics_search_queries.redacted_text` | **30 days**, then nulled | `search-instrumentation.ts:146` |
| `analytics_search_queries.normalized_tokens` | **180 days** (the row's) | `search-instrumentation.ts:38,147` |
| `analytics_query_aggregates.normalized_query` | **365 days** | `rollup.ts:70,159` |

So a leaked PAN is written into a 365-day aggregate row as
`… or 4111 1111 1111 1111`, reassembling by removing spaces. The reporting floor
of 25 keeps it out of *reports*; it does not keep it out of the *database*, out
of a backup, or out of a replica.

### Recommendation (not applied here — see §8)

1. Widen the card separator class to any run of non-alphanumeric separators, and
   **Luhn-check** before redacting, which simultaneously fixes F3.1.
2. Add the `u` flag and a Unicode-aware local-part/domain class to the email
   rule; add `i` to the IBAN rule.
3. Add a rule for an alphanumeric identifier of 8+ characters containing 6+
   digits (DNI/NIE/NIF/passport), placed **after** the card and IBAN rules.
4. Consider normalising separators (NBSP → space, tab → space) **before** the
   rules run rather than widening every pattern.

I have deliberately not written these. Each changes what is destroyed as well as
what is kept, and F3 shows this rule set already destroys real catalogue
traffic — so the pattern set needs re-measuring against **real production
queries**, which `docs/analytics.md` item 6 already asks for and which no
synthetic corpus (including mine) substitutes for.

---

## 4. F3 — what the redactor destroys, and the false signal it produces (Medium)

**MEASURED.** The doc frames a false positive as costing *"a search term nobody
can read in a report they should not have been reading it in."* That understates
it in two ways.

### 4.1 Every 13–19 digit product identifier is reported as a payment card

| Input | Redacted as |
|---|---|
| `ean 8412345678905 water` | **`payment_card`** |
| `isbn 9788420471839` | **`payment_card`** |
| `imei 356938035643809` | **`payment_card`** |
| `gtin14 08412345678905` | **`payment_card`** |
| `order 1234567890123 status` | **`payment_card`** |

Two consequences:

- **The operational signal is destroyed in both directions.**
  `docs/analytics.md` justifies storing `redaction_kinds` because *"people are
  pasting card numbers into the search box"* is worth aggregating. In a
  marketplace whose matching pipeline (#58) is built on GTINs and whose search
  (#70) answers a bare identifier alone, barcode search is a **first-class query
  shape**. So the `payment_card` counter is dominated by ordinary catalogue
  traffic — while the *real* card leaks in §3.1 produce **no** signal at all.
  Anybody watching that number would investigate an incident that is not
  happening, and would not see the one that is.
- **The measurement is lost.** `zero_result_rate` and the top-queries report for
  every barcode search are unmeasurable, because the tokens are gone.

### 4.2 Spanish street keywords redact whole queries

The ES branch (`:114`) matches a keyword plus up to **five** following words. For
a typical short query that is everything:

| Input | Result |
|---|---|
| `camino de santiago mochila 40l` | `[redacted]` — **zero tokens** |
| `plaza sesamo peluche elmo` | `[redacted]` |
| `paseo del prado libro arte` | `[redacted]` |
| `carretera y manta camiseta` | `[redacted]` |
| `plaza de toros maqueta` | `[redacted]` |
| `cami de ronda guia` | `[redacted]` |

The rule is also **inconsistent in the direction that matters**: `calle 13
residente vinilo` survives untouched, because the first token after the keyword
must be letters — so a real address written `calle 13` is kept while a product
search for `plaza sesamo` is destroyed.

The EN branch has a milder version: `5 seconds of summer way vinyl` →
`[redacted] vinyl`.

**INFERRED** (not measured against production, because production collects
nothing): in an ES-launch catalogue these words are common enough that a
non-trivial share of the query corpus is silently destroyed, and it is destroyed
**invisibly** — the row exists, `redaction_kinds` says `postal_address`, and
nothing distinguishes it from a real address.

---

## 5. F4 — the rotation interval is unvalidated (Medium)

**READ.** `config/index.ts:4195`:

```
pseudonymRotationHours: intEnv('ANALYTICS_PSEUDONYM_ROTATION_HOURS', 24),
```

No lower bound, no upper bound, and no relation asserted against the salt
retention. `saltRotationDue` (`identity.ts:184-187`) compares the epoch's age
against it directly.

- **Set high** (e.g. `8760`), the pseudonym becomes a stable identifier for a
  year — the exact thing `db/schema/analytics.ts:730-736` says rotation exists to
  prevent (*"A pseudonymous id derived under a FIXED salt is a stable identifier
  for as long as the salt lives — which is to say, a person"*). Above ~1080
  hours the epoch also outlives its own `expires_at`, so the sweep deletes the
  **live** salt; `currentSalt` then re-mints from `(previous?.epoch ?? 0) + 1`
  (`pseudonymSaltRepository.ts:95`) and **reuses epoch numbers**, so two mutually
  unlinkable epochs share a label.
- **Set to 0**, every cache miss rotates — a new epoch each 60 s, destroying all
  session-level analysis and filling the table.

This is the one number bounding how long a pre-purchase identifier can link
activity, and it is a bare `intEnv`. The domain is inconsistent with itself
here: #82 puts *no* threshold that decides what a signal means into the
environment, and #79/#93 demand their keys under the half-configuration rule.

**Not fixed here**, deliberately: the correct behaviour (throw at boot / clamp /
warn) is a policy choice, and a new boot-time throw can take a deployment down on
its next release. **Recommendation:** refuse at boot when
`pseudonymRotationHours <= 0` or when `pseudonymRotationHours * 3600 >=
RETENTION_SECONDS.analyticsSalt`, under the existing half-configuration pattern.

---

## 6. F5 — two merchant figures are structurally unmeasurable and are published as zero (Medium)

**MEASURED.**

- `SUMMARY_METRICS` (`merchant-analytics.service.ts:57-63`) maps **both**
  `checkoutStarts` and `paidOrders` to `native_checkout_conversion`.
- `rollupConversions` writes that metric's buckets with **`storeId: ''`**
  (`rollup.ts:415`) — it is sourced from `payments` through
  `verified-conversion.ts`, which carries no store dimension.
- `readRollups` filters `eq(analyticsRollups.storeId, input.storeId)`
  (`rollupRepository.ts:109`) with the real store id
  (`merchant-analytics.service.ts:82`).

So those two rows never match. `checkoutStarts` and `paidOrders` are **0 for
every store, on every deployment, forever** — and are returned as `0` beside
three figures that are real.

This is the failure `docs/analytics.md` names in its own seam discussion — *"A
metric reading zero and a metric that cannot yet be measured look identical on a
chart and mean opposite things"* — occurring on the merchant surface, which has
no `seam` field and no `unmeasured` state to say so. A merchant who sold 400
items is told `paidOrders: 0`.

Privacy impact: **none** (the suppression threshold takes the `Math.max`, so a
structural zero cannot lower it). Honesty impact: high, on the surface a
merchant is most likely to act on.

**Not fixed here**: the two available fixes are (a) give the financial seam a
store dimension, which changes what `verified-conversion.ts` returns and is a
decision with its own privacy reasoning, or (b) drop the two fields / mark them
unmeasured. Both are owner calls.

---

## 7. What I checked and found sound

Recorded because a review that only lists faults is not a review of the design.

**The allow-list and the absent columns.** **MEASURED** — `contract-gates.test.ts:203-220`
scans `db/schema/analytics.ts` for a `jsonb(` **column** (not a mention), with a
2 000-character floor on the file it read and a two-way mutation self-test
(`payload: jsonb().notNull(),` → true; a docblock mentioning jsonb → false). The
forbidden-column scan (`:169-201`) enumerates tables from the **module** rather
than a hand list, floors at exactly 8 tables and >3 columns each, and its
mutation self-test asserts six positives *and* three must-not-fire cases
(`salt`, `pseudonymous_session_id`, `checkout_group_id`). Both floors are real:
a broken traversal fails rather than reporting a clean schema.

> **Correction, 2026-08-16 (later the same day), on the forbidden-column scan
> only.** The paragraph above is left as written — it is an accurate record of
> what was measured at the reviewed revision `c25d3c3`, and its line citations
> are to that revision. What it did **not** ask is the question this repository
> asks of every check: *what would it report if the thing it measures were
> absent?* The scan was a **deny-list**, so it reported CLEAN for every column
> outside the eighteen tokens its regex names — `shipping_address`, `full_name`,
> `latitude`, `guest_session_id` and a bare `subject_hash` all pass it, and
> `hash` is named in the schema docblock's own list of what must be impossible.
> Its mutation self-test could only ever show that the pattern matched the names
> the pattern already listed. Three of the eighteen could not fire at all: the
> traversal yielded `column.name`, which is the TypeScript property name, so
> `ip_address`, `user_agent` and `order_note` were being matched against
> `ipAddress`, `userAgent` and `orderNote`. The scan is now an **allow-list**
> over `sqlColumnName`, compared both ways against the schema, with the
> deny-list retained as a second layer — see `docs/analytics.md` §"The gate is
> an allow-list, and it was a deny-list until it was not". **The two floors this
> paragraph credits were real and were kept.** The design claim in §1 is
> unaffected: no forbidden column was found then or now; what was wrong was the
> confidence the check licensed.

**Two identity columns, mutually exclusive.** **READ** —
`analytics_events_identity_exclusivity_check` (`schema/analytics.ts:197-202`)
enforces `num_nonnulls(...) <= 1` **and** that an Oxy id implies `actor_kind =
'oxy'` **and** that a pseudonym implies it is not. `…_consent_identity_check`
(`:212-215`) refuses an Oxy id on a `denied` row. `…_pseudonym_epoch_check`
(`:206-209`) makes a hash without its epoch unrepresentable.
`deriveAnalyticsIdentity` (`identity.ts:208-216`) returns `unidentified` on
denied consent rather than falling back to a pseudonym — i.e. it does **not**
substitute a stable per-account identifier under another name.

**Two epochs are genuinely unlinkable.** **READ**, and true *once F1 is fixed*:
the salt is 32 CSPRNG bytes, `PROTECTED_COLUMNS`-registered, read by exactly one
module, and deleted. The hash is `sha256(salt:handle)` truncated to 128 bits —
not guessable without the salt, so a stolen guest token does not confirm which
rows are that session's.

**Append-only, and DELETE deliberately permitted.** **READ** —
`drizzle/0029_classy_the_order.sql:308-319` creates
`mercaria_analytics_event_append_only` as **`BEFORE UPDATE`** only, raising
`check_violation`. There is no DELETE trigger, and the migration comment says
why: *"erasure on schedule is the policy, and it is the one operation that must
never be blocked."* `db/analytics/eventRepository.ts` exports an insert and
three reads — **no update and no delete** — so the trigger backstops a surface
that does not exist rather than one that does.

**The floor on query reporting.** **READ** — `readTopQueries`
(`searchQueryRepository.ts:160-196`) applies `ANALYTICS_QUERY_MIN_OCCURRENCES`
(25) twice: `gte(occurrences, …)` on the row at `:171` and
`.having(sum(occurrences) >= …)` after the range aggregation at `:195`. There is
no `includeRare` parameter. `redacted_text` is never selected by any production
path — it appears only as `set redacted_text = null` (`:95`), as a predicate
(`:99`, `:309`), and in one test.

**Merchant suppression.** **READ** — applied to the **largest** of the five
counts (`merchant-analytics.service.ts:107-108`) with the differencing argument
stated, and suppressed values are literal `0` beside `aboveThreshold: false`
(`:114-119`) — not rounded, not bucketed. The route is behind
`requireStorePermission('stats:read')` (`routes/admin/analytics.ts:30`); the
newer `analytics:read` permission belongs to #86 and is not used here.

**The financial seam is one-way.** **READ** — `verified-conversion.ts` reads
`payments` and `orders` only, and returns `{buyerOrigin, checkoutGroups}` counts
plus a boolean — no amount, no currency, no buyer identity. Nothing under
`services/payments/` imports `services/analytics/`. Caveat worth recording:
`findFinancialSourceViolations` (`metrics.ts:159-167`) is a **static check over
metric metadata** — it compares a key's name-markers against its declared
`source` and does not inspect where a number actually came from. That is a
weaker guarantee than the prose implies, though the direction it guards is the
one that matters.

**Analytics cannot block commerce.** **READ** — `recordAnalyticsEvent` /
`emitAnalyticsEvent` return `void`, so there is nothing to await;
`sink-never-blocks-commerce.test.ts` drives it with a throwing writer and
asserts counters so a sink that quietly did nothing cannot pass.

**The loops have real callers.** **READ** — `startAnalyticsSink`,
`startAnalyticsRollup` and `startAnalyticsRetention` are all invoked from
`src/index.ts:631,639,646`, with shutdown counterparts at `:758-763`. This is
**not** a green-and-inert mechanism.

**Coercive experiments.** **READ** — the negative list is scanned against the
positive one with a mutation self-test seeded with five plausible future
additions including `guest_option_visibility`
(`contract-gates.test.ts:233-248`), plus a both-arms-reachable case that would
catch bucket arithmetic putting everyone in control.

---

## 8. Retention: every deadline, who sweeps it, and whether silence is noticed

**READ**, from `db/expiryTargets.ts:496-556` and the writers.

| Table | Deadline | Value set by | Swept by | Silent no-op noticed? |
|---|---|---|---|---|
| `analytics_events` | per event class — discovery 90 d, commerce_funnel 180 d, experiment 180 d, operational 30 d | `envelope.ts:176-181,266` | shared sweep | **No** — no counter |
| `analytics_search_queries` (row) | 180 d | `search-instrumentation.ts:38,147` | shared sweep | **No** |
| `analytics_search_queries.redacted_text` | **30 d**, nulled in place | `search-instrumentation.ts:146` | `retention.ts:39,54` (a REDACTION, not a delete) | **Yes** — `retention.unredactedExpiredQueries` |
| `analytics_query_aggregates` | 365 d | `rollup.ts:70,159` | shared sweep | **No** |
| `analytics_rollups` | 730 d | `rollup.ts:69,110` | shared sweep | **No** |
| `analytics_experiment_exposures` | 180 d | `experimentRepository.ts:205,216` | shared sweep | **No** |
| `analytics_pseudonym_salts` | 45 d from epoch OPEN | `identity.ts:171` | shared sweep | **Yes** — `retention.overdueSalts` (see F1) |

Three observations:

1. **Only two of the seven have a health counter**, and F1 had rendered one of
   them permanently non-zero. The other five fail silently and would grow
   forever with no error and no symptom until disk — which is the exact hazard
   `expiryTargets.ts` opens by describing.
2. **The text-redaction sweep is the one loop whose gate stops real work.**
   `retention.ts:124` returns early on `!config.analytics.enabled`. That is
   correct while nothing is collected, but it is the domain's only departure
   from "gate the loop, never the durable record", and it means turning
   collection **off** after a period of collection **stops the 30-day text
   nulling** on rows already written. Whoever pulls that lever in an incident
   should know it freezes redaction rather than accelerating it.
3. **Scraping and alerting are owed to `oxy-infra`** and do not exist. Both
   counters are currently JSON on an endpoint nobody polls.

---

## 9. Residual risks the accepter is taking on

Stated plainly, including the ones the design accepts on purpose.

- **Redaction is a deny-list and is best-effort by construction.**
  `redact-query.ts:14-31` says so honestly. Even with F2 fixed, an unrecognised
  shape survives 30 days as text and — because tokens are derived from the
  redacted text — **indefinitely within the row's 180 days and the aggregate's
  365** wherever redaction missed. §3.6 is not a bug to close; it is the
  standing cost.
- **Guest experiment and return-rate continuity ends at each salt rotation.**
  Already stated in `docs/analytics.md` and in `saved_intent_return_rate`'s
  attribution limit, and it biases that metric **down**. Fixing F1 makes this
  *more* true, not less: an experiment longer than the rotation interval sees one
  person as several units, and `analytics_experiment_exposures` says so at
  `schema/analytics.ts:683-687`. An experiment needing more continuity must run
  on `oxy_user`.
- **Consent is a client-declared header and Mercaria operates no consent
  framework.** `readAnalyticsRequestContext` (`request-context.ts:100-104`)
  reads `x-mercaria-analytics-consent`, and an unrecognised or absent value is
  `unknown`. **Both `unknown` and `not_required` permit recording the Oxy
  account id**; only `denied` withholds it. Nothing authenticates the header and
  nothing stores a consent record. `docs/analytics.md` item 1 asks this review to
  *"confirm or narrow that"* — **I am not competent to confirm it and it is not a
  code question.** It is the single largest open item and it belongs to whoever
  owns the launch jurisdiction's lawful basis. Note the fallback is at least the
  safe direction (`unknown`, never `granted`).
- **A guest deletion request cannot be honoured per person, by design.** Stated
  in `docs/analytics.md` and correct: a domain that could find "this person's
  rows" is one that could do the correlation this design exists to prevent. The
  accepter is accepting that erasure here is **schedule-based only**.
- **Append-only binds UPDATE, not rewrite-by-delete-then-insert (F7).** The
  trigger is `BEFORE UPDATE` only. Nothing in the service layer deletes (the
  sweep is the only deleter and `eventRepository` exports no delete), and event
  ids are server-minted uuid v7, so a re-inserted row is visibly a different row
  — but the guarantee is narrower than "append-only" reads. Accepted residual.
- **A second exported reader returns query text with no floor (F6).**
  `aggregateSearchQueriesForDay` (`searchQueryRepository.ts:224-250`) selects
  `array_to_string(normalized_tokens, ' ')` with no occurrence floor. Its only
  caller is `rollup.ts:147`, which feeds it straight into `upsertQueryAggregates`
  and returns counts, so **no text escapes today**. But the module docblock
  (`:11-13`) claims *"no second exported reader and no raw-text accessor at
  all"*, which is false on the first clause, and nothing structural stops a
  future caller. Recommend either narrowing the export or correcting the
  docblock — a wrong statement in a docblock is where this class of belief
  survives.
- **`ANALYTICS_INTERNAL_TRAFFIC_TOKEN` distribution is unaddressed.**
  `docs/analytics.md` item 10 asks who holds it and how it rotates. There is no
  answer in the repository; empty (the default) means nothing can declare itself
  internal, which is the safe failure.
- **The reporting floors (25 / 10) are unvalidated against launch volume.**
  `docs/analytics.md` item 4 asks for this and it cannot be answered before
  collection: *"a floor that suppresses everything is a surface nobody uses, and
  one that suppresses nothing is not a floor."* The accepter is accepting that
  both numbers are **unmeasured judgements** at enable time, and that the
  merchant surface will very likely report `aboveThreshold: false` for most
  stores at launch.
- **Two of the five merchant figures are structurally zero (F5)** until the
  financial seam grows a store dimension or the fields are withdrawn.

---

## 10. `docs/analytics.md` items this review does **not** close

Item 1 (lawful basis and consent), item 4 (the floors against real volume),
item 6 (the pattern set against **real production queries** — my corpus is
synthetic and adversarial, which is the other half of that item, not the whole
of it), item 7 (who is on each of the operator allow-lists), item 10 (the
internal-traffic token's distribution) and item 11 (each seam contract re-read
by its owner) are all **open**. Items 2, 3, 5, 8 and 9 are addressed above.

---

## 11. Sign-off (unsigned)

**This review does not authorise enabling collection. Producing the analysis is
the reviewer's job; accepting the risk is the owner's.**

Before `ANALYTICS_COLLECTION_MODE` may leave `off`, the accepter should record
that they are accepting each of the following, by name:

**Must be fixed first (this review's position):**

1. **F2** — the redactor leaks complete card numbers on any non-space,
   non-hyphen separator; emails with non-ASCII local parts or domains; lowercase
   IBANs; and Spanish DNI/NIE/NIF/passport numbers — and the leaked value
   persists in `normalized_tokens` for up to 365 days, longer than the text it
   was redacted out of.
2. **F3** — the redactor reports every EAN-13/ISBN-13/IMEI/GTIN-14 as
   `payment_card`, making the one operational privacy signal unusable in both
   directions, and destroys whole queries containing ordinary Spanish words
   (`camino`, `plaza`, `paseo`, `carretera`, `avenida`, `cami`).
3. **F4** — `ANALYTICS_PSEUDONYM_ROTATION_HOURS` has no bound in either
   direction; the value that decides how long a pre-purchase identifier can link
   activity is an unvalidated environment integer.

**Accepted as fixed by this change:**

4. **F1** — the pseudonym salt was retired at 90 days rather than 45, so a
   discovery event had no unlinkable period at all, and the health counter that
   exists to detect exactly this was permanently non-zero. Fixed, gated and
   mutation-tested.
5. **F8** — two `redact-query.ts` docblock statements contradicted the code.

**Accepted as standing residual risk:**

6. Redaction is best-effort by construction; what it misses persists in the
   tokens beyond the text's own 30 days.
7. Consent is an unauthenticated client-declared header; `unknown` and
   `not_required` both permit recording the Oxy account id, and Mercaria stores
   no consent record. **The lawful basis for the launch jurisdiction is not
   established in this repository and is not established by this document.**
8. Guest experiment and return-rate continuity ends at each salt rotation, and
   `saved_intent_return_rate` is biased down as a result.
9. Per-person erasure is impossible by design; erasure is schedule-based only.
10. Five of the seven retention deadlines have no health counter, and neither of
    the two that do is scraped or alerted on — that wiring is owed by
    `oxy-infra`.
11. Append-only binds UPDATE only.
12. Both reporting floors (25 and 10) are unmeasured judgements at enable time.
13. Two of the five merchant summary figures are structurally zero (**F5**), so
    the merchant surface should not be enabled on the same lever as collection.

**Accepter:** ______________________  **Date:** ____________

**Reviewer:** this document. Findings are reproducible from the citations; the
adversarial corpus and the mutation test are in the PR that introduced it.
