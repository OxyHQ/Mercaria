# Runbook — catalog translation regressions (#367 W17)

A locale's translation coverage fell, or its stale count rose, or its machine
share went the wrong way. Reference:
[../catalog-observability.md](../catalog-observability.md) and
[../catalog-localization.md](../catalog-localization.md).

**Four of the five translation metrics measure what the CATALOGUE contains. The
fifth measures what a shopper hit, and since W17 line 771 it is MEASURED** —
`translation_fallback_use_rate`, fed by `recordLocalizedResolution` at the one
wrapped resolver every localized read goes through. **Its limit is that it is an
in-process counter over `since_process_start`**: a task restart zeroes it, tasks
do not share it, and it cannot answer a question about yesterday. So this runbook
can now tell you whether anybody is hitting a fallback right now, and still
cannot tell you whether they were last week. Coverage cannot substitute: an
untranslated category nobody visits costs nothing, and a translated one whose
locale variant is missing costs every visit.

**Owner:** whoever owns the localization review desk. Escalate to the API on-call
only if a status is moving without anybody reviewing.

---

## The alert

| Signal | Where | Condition |
|---|---|---|
| `translation_coverage` | `GET /internal/catalog-metrics` → `.data.readings[] \| select(.key=="translation_coverage")` | a fall in `ratio`, **per locale**, read off the `by` buckets rather than the roll-up |
| `translation_stale_count` | same report | a rise in `numerator` |
| `translation_missing_count` | same report | a rise, or a flip to `state: "unmeasured"` |
| `translation_machine_share` | same report | a rise, per locale from `by` |
| `translation_fallback_use_rate` | same report | a rise in `ratio` — but per TASK and since ITS start, so compare within one process lifetime and never across a deploy. `0 / 0` (a task that served no localized read) reports NO ratio, which is not zero |

`translation_coverage` comes from `readCatalogQuality`'s locale dimension —
catalog-governance is the one authority and this domain re-derives nothing.
`translation_machine_share` and `translation_stale_count` come from a UNION of
the four localization tables (`category_localizations`,
`product_type_localizations`, `attribute_value_localizations`,
`navigation_node_localizations`) grouped by locale, because the question is
"coverage for this locale" and a per-table split would invite averaging four
ratios over different denominators.

## What it means

The five stored statuses are `missing`, `machine_translated`, `reviewed`,
`approved` and `stale`, and the metrics read them like this:

| Metric | Numerator | Denominator |
|---|---|---|
| `translation_coverage` | rows that are `reviewed` or `approved` | eligible entity-locale pairs |
| `translation_machine_share` | rows that are `machine_translated` | all rows that EXIST for the locale |
| `translation_stale_count` | rows that are `stale` | not a ratio |
| `translation_missing_count` | eligible pairs with **no row at all** | not a ratio |

**`machine_translated` is deliberately NOT in the coverage numerator.** Counting
it is how a locale reports 98% while a shopper reads a machine's guess at a legal
category name.

`stale` means the SOURCE moved after a translation was settled: a source-semantics
change rewrites `machine_translated`, `reviewed` and `approved` to `stale`
(`STALE_ON_SOURCE_CHANGE_STATUSES`), and leaves `missing` alone because there is
nothing there to make stale.

## What it does NOT mean

- **Not that the translations that exist are wrong.**
  `translation_stale_count`'s own attribution limit: stale means the source moved,
  and it says nothing about how wrong the translation now is.
- **Not that a low machine share is good.** A locale with nothing translated has a
  machine share of ZERO and is the worst case, not the best. Read it against
  `translation_coverage` — the pair is the reading, not either number.
- **Not necessarily that anything a shopper sees changed.** ADR 0007 D12 names a
  `CATALOG_LOCALIZATION_ENABLED` lever and **no such variable exists in the
  code** — it is in neither `config/index.ts` nor anywhere else under
  `packages/backend/src` — so do not go looking for it and do not tell anybody to
  flip it. What decides whether a regression is visible is which surfaces read the
  affected entity in the affected locale, and this domain cannot answer that: the
  metric that could is `translation_fallback_use_rate`, which is measured since
  W17 line 771 but only `since_process_start`.
- **Not zero, when it says `unmeasured`.** `translation_missing_count` carries
  catalog-governance's OWN three-valued verdict through rather than flattening it:
  `coverage: "unmeasured"` on the `missing_translation` queue becomes an
  `unmeasured` reading with governance's reason, because reading it as zero would
  report a fully translated catalogue for a locale set nobody measured.
- **Not a fall at all, when the DENOMINATOR moved.** Coverage is a ratio over
  ELIGIBLE pairs: publishing forty new categories lowers every locale's coverage
  without a single translation changing. Read `denominator` before `ratio`.

## The first three things to check

**1. Read the per-locale buckets, not the roll-up.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-metrics \
| jq '.data.readings[]
      | select(.key|startswith("translation_"))
      | {key, state, reason, numerator, denominator, ratio,
         by: (.by // [] | map({key, numerator, denominator, ratio}))}'
```

The roll-up sums every locale, so one locale collapsing and another improving can
leave it flat. `by[].key` is the locale.

**2. Decide whether the numerator fell or the denominator rose.**

A fall in `ratio` with a stable `numerator` and a risen `denominator` is a
publication event, not a translation regression — somebody published categories,
product types or attribute values and the translations have not caught up. That is
the ordinary and expected shape after a taxonomy change, and the remedy is
translation work rather than investigation.

**3. Read the governance desk, which is where the work is queued.**

```bash
curl -s -H "Authorization: Bearer $OXY_TOKEN" \
  https://<api>/internal/catalog-governance/queues \
| jq '.data[]
      | select(.kind == "stale_translation" or .kind == "missing_translation")
      | {kind, coverage, total, unmeasuredReason}'
```

`stale_translation` and `missing_translation` are two of the desk's nine queue
kinds and are the queues a reviewer works from. `translation_missing_count` in the
metrics report should equal the desk's `missing_translation` total, because it IS
that number.

## Likely causes, most likely first

1. **A taxonomy or product-type publication widened the denominator.** The
   commonest cause of a coverage "regression" and not a regression at all. Confirm
   with step 2 and with `GET /internal/catalog-governance/audit`.
2. **A source edit rewrote settled translations to `stale`.** A rename of a
   category or a product-type name is a source-semantics change, so every
   locale's `reviewed`/`approved` row for that entity becomes `stale` — coverage
   falls and `translation_stale_count` rises in the same step. That is the
   mechanism working: the alternative is a shopper reading a translation of a name
   that no longer exists.
3. **Nobody is reviewing.** `machine_translated` rows accumulate, so the machine
   share rises while coverage does not move. The desk is the signal, not the code.
4. **A locale was added.** A new tag in the locale set creates eligible pairs with
   no rows, so `translation_missing_count` rises by the whole catalogue for that
   locale on the day it is added.
5. **An importer wrote translations Mercaria did not author.** `provenance` is
   where that shows up — `imported_source` is a feed's or connector's own
   translation, a claim by somebody outside Mercaria, and deliberately not
   `official_brand`.
6. **The governance reader is unavailable.** `translation_missing_count` flips to
   `unmeasured` and `mustStayZero.metricCollectionFailures` is non-zero. You are
   reading a partial report.

## Remedy

**Review the translations.** The localization domain has exactly ONE write
surface:

```
POST /internal/catalog-governance/reviews/localization
```

behind the same `CATALOG_OPERATOR_OXY_USER_IDS` allow-list, and every decision
lands in the one governance audit trail beside every other kind of catalogue
work.

| Cause | Action |
|---|---|
| A widened denominator | Translate the new entities. Nothing is broken. |
| `stale` after a source edit | Re-review each affected row through the endpoint above. The status is a prompt, not damage. |
| A machine share that keeps rising | Staff the desk. A `machine_translated` row is a SUGGESTION awaiting review, which is what the number is saying. |
| A newly added locale | Expected step change. Re-baseline the alert against the new denominator rather than treating the step as a regression. |
| The governance reader unavailable | An API incident, not a translation one. Follow the `metricCollectionFailures` signal. |

## What NOT to do

- **Do not bulk-approve machine translations to raise coverage.** It is the one
  action that makes the number look right and the catalogue worse, and ADR 0007
  is explicit that machine translation is a suggestion behind review. The schema
  fights back in two independent ways — a trigger refuses the TRANSITION (a
  machine write landing on human work) and two companion CHECKs make the
  resulting ROW unrepresentable — and neither covers the other, so an attempt that
  gets past one is still refused by the other.
- **Do not `UPDATE` a localization row's status directly.** Same two mechanisms,
  plus `(status = 'missing') = (the primary text is null)` as a CHECK: a
  hand-written status either fails at the database or produces a row that claims
  text it does not have.
- **Do not read `translation_machine_share` on its own.** Zero is the worst case
  as often as it is the best, and only coverage beside it says which.
- **Do not treat `unmeasured` as zero**, which is the whole reason the propagation
  exists.
- **Do not chase a fallback-use number.** There is none; it is seam 3, and closing
  it is a `void` counter at the point the chain selects a locale other than the
  requested one — never something reconstructed from coverage.
