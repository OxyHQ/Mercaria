# The eBay Browse catalog source

- **Status:** Implemented; **not production-approved** — see §11.
- **Date:** 2026-08-09
- **Issue:** [#65](https://github.com/OxyHQ/Mercaria/issues/65), part of epic
  [#37](https://github.com/OxyHQ/Mercaria/issues/37). Selected by
  [#64](https://github.com/OxyHQ/Mercaria/issues/64)
  (`docs/catalog-sources/2026-08-09-launch-sources.md`, binding). Built on
  [#62](https://github.com/OxyHQ/Mercaria/issues/62)'s adapter contract, matched
  by [#58](https://github.com/OxyHQ/Mercaria/issues/58), offered through
  [#57](https://github.com/OxyHQ/Mercaria/issues/57).
- **Provider docs current as of:** 2026-08-09. Anything that cannot be verified
  without an approved production account is marked **requires account approval**
  rather than guessed — #64's precedent, and #65's own instruction.

---

## The failure mode that shapes this integration

**A search API is not a catalogue, and treating one as the other retires a
healthy catalogue.**

#62's retirement rule is exactly right for a feed: enumerate it completely, and
anything you did not see has stopped being published. eBay grants no enumeration
at all. It grants SEARCH, and it refuses a search `offset` beyond 10,000 — so a
sweep of a category with 40,000 items has provably not seen 30,000 of them, and
an item found last week can be perfectly public today and simply not be in this
week's results because a price change moved it out of a filtered query.

Reporting `AdapterFetchPage.complete` from a discovery sweep would therefore
mass-expire everything below the depth cut, on the first sweep after a category
grew. Every other decision in this document follows from refusing to do that.

---

## 1. Approved account and environment

| | |
|---|---|
| Developer account | developer.ebay.com — **requires account approval** |
| Production keyset | **requires account approval** (Buy API application + contracts) |
| EPN account | partnernetwork.ebay.com — free; yields the 10-digit `affiliateCampaignId` |
| Environment switch | `EBAY_ENVIRONMENT` = `sandbox` \| `production`, defaulting to **`sandbox`** |

`EBAY_ENVIRONMENT` defaults to `sandbox` and anything unrecognised resolves
there too, never to `production`. The two are different key spaces, and the
asymmetry is deliberate: a sandbox keyset pointed at the production host fails
every call with an auth error, which is loud, while a production keyset pointed
at sandbox would quietly ingest eBay's TEST catalogue into a live comparison
surface.

Production access is the real gate and is not a formality. eBay's own words:
*"use of the APIs in production is restricted"*, and meeting the eligibility
criteria *"is not a guarantee that production access will be granted"*. The
chain is an EPN account → the Buy API Application (business model, UX mocks,
data flows) → an EPN decision → a Developer Support ticket → Buy-API-specific
contracts, possibly MNDAs.

## 2. Authentication and secret storage

OAuth 2.0 **client credentials**, scope
`https://api.ebay.com/oauth/api_scope` — the public-data scope the Browse API
needs and nothing wider.

- `catalog_source_configs.credential_ref` names WHERE the secret lives, in #62's
  `env:<NAME>` form. The adapter reads `<NAME>_ID` and `<NAME>_SECRET` from the
  process environment; the values reach production through the existing GitHub
  secret → SSM → task-definition pipeline.
- **The access token is never written down.** It is minted per process, held in
  memory with a 90 s expiry skew, and dies with the task. It is not in a table,
  not in a cache, not in a log line, and `ebay-isolation.test.ts` fails the build
  if any module in the domain learns to persist one. A two-hour bearer credential
  in a database is a row that grants API access on eBay's side, in something with
  backups, replicas and operator surfaces — to save one HTTP call every two
  hours.
- The consequence is stated rather than hidden: N tasks mint N tokens. eBay does
  not meter the token endpoint against the Browse quota, and N is single digits
  against 5,000.
- One in-flight mint per key, so twenty concurrent pages on a cold cache make one
  token request rather than twenty.
- The `connection:` and `ssm:` credential schemes are REFUSED rather than falling
  back: `connection:` belongs to the connector domain (a merchant's own shop
  credential, which an application keyset is not), and `ssm:` already resolves
  into the environment at deploy time. A silent fallback would make a mis-typed
  locator look like a missing secret.

## 3. Supported countries, languages and currencies

Launch set — #64 §2, and the closed tuple `EBAY_MARKETPLACE_IDS`:

| Marketplace | Market | Public item host |
|---|---|---|
| `EBAY_ES` | ES | `www.ebay.es` |
| `EBAY_DE` | DE | `www.ebay.de` |
| `EBAY_FR` | FR | `www.ebay.fr` |
| `EBAY_IT` | IT | `www.ebay.it` |
| `EBAY_GB` | GB | `www.ebay.co.uk` |

The tuple is closed because every member costs a rights review, an EPN campaign
and a category cohort; a marketplace nobody reviewed is one Mercaria has no terms
for. `EBAY_MARKETS` narrows it further at runtime and can never widen it — a
value the tuple does not name is DROPPED, so a wholly unrecognised list resolves
to nothing and the adapter queries nothing at all. Fail-closed, and visible
immediately as a source that fetches no records.

**Currencies** are whatever eBay trades in per marketplace (EUR for ES/DE/FR/IT,
GBP for GB). Mercaria stores them verbatim — `offers.price_currency` is
shape-checked and deliberately NOT tuple-checked (ADR 0002 D18's documented
exception), because refusing the record over a currency Mercaria does not present
would break the observation rather than the price. `parseEbayMoney` converts to
minor units using the currency's own precision and REFUSES anything it cannot
read exactly: a price that needed rounding is a price nobody published.

**Languages** are the marketplace's, and eBay localizes item aspects and the
condition display name. That localization is why the condition ID rather than the
display text is what reaches #90 — see §6.

## 4. Which ingestion modes eBay actually permits

| Mode | Available | What Mercaria does |
|---|---|---|
| Bulk catalogue export | **No** | — |
| Change feed | **No** | — |
| Query-driven discovery | **Yes** (`item_summary/search`) | The discovery phase |
| Scheduled item refresh | **Yes** (`item`, ≤20 ids per call) | The verification phase |

The Feed API and Order API are Limited Release and outside #64's decision;
nothing here calls them. There is no simulated full export, which #65 forbids in
as many words.

So an eBay marketplace's "catalogue" inside Mercaria is **exactly the union of
the discovery queries an operator configured** (`ebay_discovery_queries`). That
is a table rather than an environment variable because it IS the rollout cohort
#65 acceptance 7 asks for: an operator widens it one row at a time, with the
evidence of what each sweep returned beside it.

### A pass is DISCOVERY then VERIFICATION, and only the second may complete

```
discovery (search, per configured query)  →  verify (getItems, by tracked id)  →  done
        never complete                              may complete
```

- **Discovery** sweeps each enabled query, page by page, at `limit` clamped to
  eBay's own 200. It NEVER reports completeness, for the reason at the top of
  this document.
- **Verification** enumerates the items Mercaria already tracks for that source
  and asks eBay about them by id, twenty at a time. Items eBay no longer answers
  for are simply not re-observed, and #62's sweep retires them. This is the only
  thing that establishes "no longer publicly available on eBay", which is the API
  License Agreement's deletion trigger.
- Verification asks only about what discovery did NOT just re-observe (the pass
  anchor in the cursor). The completeness claim is unchanged — every tracked item
  was either re-observed or asked about by name — and a sweep that re-found most
  of a catalogue leaves only the remainder to verify.
- An **incremental** pass (`since !== null`) is discovery-only and never
  completes: asking what changed since a watermark by construction does not
  mention what did not change.

`mayClaimCompleteEnumeration` states the whole conjunction in one expression:
verification phase, cohort exhausted, nothing truncated, not incremental. Every
failure mode — a budget refusal, eBay's offset ceiling, a rate limit, an auth
failure, a disabled query, an unreadable cursor — lands on `false`, and `false`
means #62 retires nothing.

## 5. Pagination, quota and rate limits

- **`search`**: `limit` ≤ 200, `offset` < 10,000. The offset ceiling is a
  provider refusal, and reaching it marks the pass TRUNCATED rather than merely
  ending a query.
- **`getItems`**: ≤ 20 item ids per call.
- **Quota: 5,000 calls/day per APPLICATION**, raised through eBay's free
  application growth check.

`ebay_call_budgets` is keyed on the CREDENTIAL and the UTC day, not on the
source. Mercaria runs one source per marketplace; a budget per source would let
five of them each spend 5,000 against one 5,000-call agreement, and eBay would
start refusing at breakfast.

The reservation is one conditional `UPDATE`
(`… where calls_used + $n <= daily_limit returning …`) which grants the whole
reservation or nothing, under the row lock Postgres takes anyway. N ECS tasks
racing produce N serialized updates and the sum can never pass the limit — where
a counter in each process bounds each process and nothing else. An empty
`RETURNING` set IS the refusal; it is not an error to catch. A CHECK
(`calls_used <= daily_limit`) states the same bound at the row, so a replay or a
repair typed during an incident cannot exceed it either.

Refusals are COUNTED beside grants: `calls_used` alone cannot tell a quiet day
from a day the budget spent hours refusing everything, and those need opposite
responses (leave it alone; file the growth check). Reservations are never
returned — a call reserved and then not made is spent, because refunding it would
need the caller to be trusted to report a failure it may not survive to observe.

The UTC day matters: eBay resets at midnight UTC, and a budget on any other clock
disagrees with the one being enforced, in the direction that gets an application
throttled.

## 6. Data storage, caching, image display and deletion

Encoded as #62 rights on the source's own policy version, from #64 §6:

| #64 rule | How it is enforced |
|---|---|
| Store observations | `may_store`. The RAW payload is digested and discarded; what is stored is #62's allow-listed projection. |
| **Delete when no longer publicly available** | The verification phase, by ASKING eBay about each tracked item. TWO channels, §9: a per-item not-found warning is a #68 `AdapterRemoval` and retires that item from any run; silence retires only from a complete pass. |
| Display price and availability as returned | `may_display_price`. #62 shapes the offer by the right rather than checking after it: no `display_price` ⇒ no price on the offer at all. |
| Outbound links are `itemAffiliateWebUrl` or the plain item URL only | §7. |
| No AI training | Not a code path this integration has. Stated here because the contract states it, and because the stored projection is the only eBay content Mercaria holds. |
| Third-party sellers shown as the merchant | §8 — this is the whole `per_record` seller-identity path. |
| Image caching duration | **requires account approval** (Buy API contract). Until signed, Mercaria stores eBay-hosted image URLs and hot-links them; it re-hosts nothing. |

**Condition** reaches #90 as the eBay **`conditionId`**, never the `condition`
display name. The display name is LOCALIZED — "Used" on EBAY_GB and "Usado" on
EBAY_ES for the identical `3000` — so a ruleset keyed on it would need one rule
per language per condition and would silently answer `unmapped` for every market
nobody wrote rules for. The id is stable across marketplaces and locales, which
is the only property a lookup key needs.

`EBAY_RECOMMENDED_CONDITION_RULES` (shared-types) is the ruleset an operator
publishes through #90's own surface. It is a recommendation and not an
enforcement, which is #90's arrangement working rather than a gap: a
`condition_mapping_rulesets` row is published by a named operator on a date, and
one written into a migration would be a policy nobody signed. Until it is
published, every eBay offer is `unmapped` with its `conditionId` preserved.

The confidences are not decoration. `1500` ("New other") and `2750` ("Like New")
describe a range of real conditions and sit BELOW
`CONDITION_MAPPING_CONFIDENCE_FLOOR` deliberately, so #90 records them as
`review_pending` and no product page ever claims them.

| `conditionId` | eBay's name | #90 key | Confidence |
|---|---|---|---|
| 1000 | New | `new` | 0.99 |
| 1500 | New other (see details) | `open_box` | 0.60 · below the floor |
| 2000 | Certified - Refurbished | `refurbished_manufacturer` | 0.90 |
| 2010 / 2020 / 2030 | Excellent / Very Good / Good - Refurbished | `refurbished_seller` | 0.85 |
| 2500 | Seller refurbished | `refurbished_seller` | 0.90 |
| 2750 | Like New | `used_like_new` | 0.65 · below the floor |
| 3000 | Used | `used_good` | 0.80 |
| 4000 | Very Good | `used_good` | 0.85 |
| 5000 | Good | `used_fair` | 0.80 |
| 6000 | Acceptable | `used_poor` | 0.85 |
| 7000 | For parts or not working | `for_parts` | 0.98 |

## 7. Affiliate approval and link generation

Passing `X-EBAY-C-ENDUSERCTX:
affiliateCampaignId=<10 digits>,affiliateReferenceId=<free-form>` makes every
response carry `itemAffiliateWebUrl`. **Mercaria's whole part in EPN attribution
is deciding whether to send that header.**

`EbayOutboundDestination` is a discriminated union with exactly two branches —
`affiliate` and `plain` — and BOTH carry a URL that came out of a response body.
There is no branch taking a campaign id, a base URL, a template or a parameter
map, so "Mercaria composes an EPN link" is not something this codebase can
express. `EBAY_FORBIDDEN_LINK_OPERATIONS` states the prohibition as a VALUE,
disjoint from the destination kinds by a gate, and
`ebay-isolation.test.ts` scans the whole domain for URL construction against an
eBay item host, for campaign parameters, and for surgery on a destination's
parameters — with a mutation self-test on each detector.

The reason is commercial, not tidy: commission attribution lives entirely in the
parameters eBay put in that URL, and a link Mercaria rebuilt, shortened or
"cleaned" is indistinguishable from a working one until a month of revenue is
missing. There is no error, no rejection and no signal anywhere.

- The offer's `destination_url` is the ORIGINAL page and the attributed URL is
  routing metadata (#57's rule), so a #37 routing failure degrades to the plain
  link rather than to a dead one.
- **Running unattributed is a working configuration**, and it is what a
  deployment without EPN approval has: eBay answers with plain item URLs, #62
  makes the offers `external` rather than `affiliate`, and nothing pretends a
  commission is being earned.
- A malformed campaign id resolves to "unattributed" rather than being sent: eBay
  IGNORES an unrecognised one and answers with plain URLs, so a typo would
  present as "attribution silently stopped working".
- `affiliateReferenceId` is the constant `mercaria`. A reference id travels to
  eBay and is echoed in EPN reporting, so a buyer-shaped value there would be an
  identifier Mercaria exported to a third party for no purpose the feature needs.
  #67 owns per-click attribution and has its own carrier.
- **Approval loss has exactly one detector.** A page on which attribution was
  requested and NOT ONE item carried it is reported (and recorded by
  reconciliation as `affiliate_attribution_missing`). Nothing else errors, rate
  limits or 4xxs, because an unattributed link is a perfectly good link. It
  reports rather than throws: refusing the page would turn a revenue problem into
  a catalogue outage.

Current EPN state: **requires account approval**. Exact commission rates and the
payout threshold are visible only inside an approved account.

## 8. Seller and marketplace identity — three things, mapped as three things

This is eBay's distinguishing strength over every other #64 candidate, and #65
acceptance 2 depends on it.

| Role | Where it lives |
|---|---|
| Marketplace OPERATOR (eBay) | `catalog_source_configs.merchant_id` — bound once by an operator |
| STOREFRONT (eBay Spain) | `catalog_source_configs.storefront_id`, whose `storefronts.merchant_id` is the operator |
| SELLER (per item) | `seller.username` → `merchantHint` → `marketplace_seller_identities` → `offers.merchant_id` |

ADR 0002 D8 then derives marketplace-ness by comparing the offer's merchant
against the storefront's operator — one join away, never a stored flag. So "Sold
by Shop X on eBay" and "Sold by eBay" are different rows, and twenty sellers of
one product produce twenty offers under one canonical variant, because
`offers.commercial_key` is `(variant, merchant, storefront, condition)`.

`catalog_source_configs.seller_identity` is the opt-in, `source_bound` by default
so every source that predates #65 behaves exactly as it did. A `per_record`
source additionally REQUIRES both bindings (a CHECK): a marketplace with no
operator has nothing to be a marketplace OF.

- A minted seller merchant grants NOTHING: `claim_state = 'unclaimed'`,
  `merchant_type = 'marketplace_seller'`, a provider-namespaced slug, no
  relationship (#55), no native-store link (#84), no claim (#83), no native
  checkout. A scanned gate fails the build if the domain reaches any of them.
- The identity key is `(provider, external_seller_id)`, not `(source, …)`: an
  eBay username is one account across every marketplace it sells on, and scoping
  to a source would split one seller into five merchants the moment DE and FR
  come up beside ES.
- An item that names NO seller produces no offer — #62's own answer for a source
  with no merchant. Falling back to the bound merchant would attribute the sale to
  the MARKETPLACE, which is the one wrong answer available.
- A merge rehomes the identity and leaves a COLLIDING one on the tombstone
  (`merge-plan.ts`), because this row is the only path from an ingested item to
  its seller and two of them for one account would let the next pass attribute
  one seller to two merchants.

## 9. Source-specific offer TTL

`catalog_source_configs.freshness_ttl_seconds` becomes `offers.stale_at` and
`source_records.stale_at`. eBay publishes no TTL of its own, so this is
Mercaria's own freshness policy and the recommended launch value is **1 hour**
for a marketplace whose prices and availability move continuously.

Freshness is NOT the deletion obligation. Staleness says "this may have changed";
deletion says "eBay no longer publishes it".

**There are two ways to establish the second, and #68 supplies the faster one.**
A complete verification pass establishes it from SILENCE — eBay was asked about
every tracked id and did not mention this one — which takes as long as the whole
cohort takes to come round. A per-item not-found WARNING (`errorId` 11006 inside
an otherwise successful 200) is eBay saying it outright about one item, which is
#68's `AdapterRemoval`: `applyExplicitRemovals` retires it from ANY run, a
targeted refresh of a single id included, with no complete enumeration involved.

The two are kept apart at the point they are read, in `ebayGetItems`, because
`AdapterRemoval` is a positive-statement channel and feeding it anything weaker
is the mass-expiry failure this whole source is shaped around:

| What eBay did | Field | May retire? |
|---|---|---|
| Named the id in a not-found warning | `removedIds` | Yes, immediately, from any run — `retirement_kind = 'explicit_removal'`, offer `retirement_reason = 'source_unavailable'`. |
| Simply did not describe it | `unansweredIds` | No. A truncated response, a marketplace restriction or a bad minute all land here. It is retired by the ordinary completeness rule when a full pass finishes — `retirement_kind = 'snapshot_omission'`, offer `retirement_reason = 'source_disappeared'`. |

Both sets feed the reconciliation sample as `vanished`, because that report asks
"how much of what Mercaria shows can eBay still be asked about" and repairs
nothing either way.

> **Requires account approval:** `11006` is the documented Browse API per-item
> "item not found" id, and the shape it arrives in (a `warnings` entry whose
> `parameters` carry the offending item id) has not been observed against a live
> approved keyset. `readNotFoundIds` degrades to "no positive statement" on any
> shape it does not recognise, so an unverified assumption here delays a
> retirement to the next complete pass and can never cause one.

## 10. Provider error taxonomy and retry rules

`retryable` decides whether the run is RELEASED (cursor intact) or CLOSED
(outcome recorded, health moved). Neither branch can retire anything — a failed
fetch never sets `complete` — so #65 reliability 6 holds whatever this table gets
wrong. What it decides is whether Mercaria hammers eBay or backs off.

| Provider answer | #62 kind | Retryable | Why |
|---|---|---|---|
| 403 + `errorId` 10001/11001 | `rate_limit` | yes | A quota refusal wearing a 403. Reading it as an auth failure would page somebody about a working credential. |
| 400 + `errorId` 1001/1002 | `auth_failure` | **yes** | An expired token wearing a 400. The next attempt mints a fresh one. |
| 429 | `rate_limit` | yes | `Retry-After` honoured in both RFC forms. |
| 401 / 403 (otherwise) | `auth_failure` | **no** | Credential or approval loss. A revoked keyset answers identically every time; retrying spends the day's budget re-asking. #62 marks the source `failed` and retires nothing — "stop safely". |
| 404 | `schema_drift` | no | A whole-request 404 means the path is wrong. A single GONE item is reported per id inside a 200, never as a transport failure. |
| ≥ 500 | `source_outage` | yes | |
| 400 / 422 (otherwise) | `schema_drift` | no | |
| Anything else | `source_outage` | yes | #62's own reading of an unrecognised failure: something Mercaria does not control went wrong and nobody said what. |
| Unparseable body | `parse_failure` | no | Different repair from drift: drift is a renamed field, a parse failure is usually one bad page. |

The classifier reads the HTTP STATUS first and the `errorId` second. eBay's
`errorId` set is large, versioned and partly undocumented, so a switch over it
would be a table nobody could keep current with a default that is wrong in the
expensive direction. The two ids above are used because they are the two
distinctions the status genuinely cannot make.

`Retry-After` is honoured when the provider sent one; #62 takes it when it is
LONGER than the computed backoff and never when it is shorter, so a provider
cannot talk Mercaria into hammering it.

## 11. Rollout, kill switches and reconciliation

### Two switches, deliberately not the same lever

#65 adapter rule 10 asks for a hard fetch kill switch and a separate
public-display switch. They are separate here, and only one is an environment
variable:

- **`EBAY_FETCH_ENABLED`** is the FETCH kill switch: deployment-wide, in front of
  every per-source right, the thing somebody flips at 3am. The adapter answers it
  with a RETRYABLE outage, so #62 releases the run with its cursor intact, moves
  no health, retires nothing, and resumes from the same page when it is flipped
  back. An empty page would instead close the run as `partial_feed`, which is
  indistinguishable in the health read from a feed that truncated — precisely the
  distinction an incident needs.
- **The DISPLAY switch is `may_display` on the source's own rights policy**
  (#62): versioned, per source, reviewed, attributable. It is not an environment
  variable because withdrawing display is a rights decision with a paper trail and
  a per-market grain, where stopping fetch is a deployment lever. An env var for
  it would be a second answer to what `catalog_source_policies` already answers,
  and the two could disagree.

`EBAY_MARKETS` is an ALLOW-list defaulting to `EBAY_ES` alone — the opposite of
ADR 0006's block-list kill switches, because this is a ROLLOUT cohort rather than
an incident lever and the default has to be the smallest set.

### Reconciliation

`POST /internal/ebay/sources/:sourceId/reconcile` re-reads a random,
budget-bounded sample of tracked items and records what disagreed
(`ebay_reconciliation_samples`). It REPAIRS NOTHING — the
`payment_discrepancies` posture: every finding already has an idempotent remedy,
and a sweep that quietly corrected itself would destroy the only evidence that
the cadence is too slow or that the campaign id stopped working.

Findings, worst first: `vanished` · `affiliate_attribution_missing` ·
`price_drift` · `availability_drift` · `condition_drift` · `agrees`, plus
`unreadable`, which is kept apart from `vanished` on purpose — an item eBay
refused to answer for is not an item eBay says is gone.

The sample is RANDOM because taking the first N would re-check the same corner of
the catalogue forever and report it as a fact about all of it. It spends the same
budget everything else does; a sweep that ignored the allowance would fix a
measurement problem by creating a freshness one.

### The operator surface

`/internal/ebay/*`, behind the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
#54/#56/#57/#58/#60/#62 use. Empty = not mounted (404, never a 401 that would
advertise it). It stays mounted while `EBAY_ENABLED` and `EBAY_FETCH_ENABLED` are
off, because reading the budget is exactly what somebody does after flipping the
kill switch.

| Route | What it does |
|---|---|
| `GET /budget` | today's and recent days' allowance, used and REFUSED (#65 acceptance 4) |
| `GET /sources/:id/discovery-queries` | the rollout cohort, and how many items the source tracks |
| `POST /sources/:id/discovery-queries` | widen or narrow it |
| `GET /sources/:id/reconciliation` | the findings and a seven-day summary |
| `POST /sources/:id/reconcile` | run one sweep now |

**Deliberately absent:** any credential read or write; "retire this item"; "mark
this source complete"; a campaign-id write; a budget write. The last one is worth
naming: `EBAY_DAILY_CALL_LIMIT` is what eBay GRANTED, and a route that raised it
would raise Mercaria's opinion of the allowance and nothing else — the first
symptom being eBay throttling the application.

## 12. Environment

```
EBAY_ENABLED=false                 # registers the adapter at all
EBAY_FETCH_ENABLED=true            # the HARD fetch kill switch
EBAY_ENVIRONMENT=sandbox           # sandbox | production; anything else is sandbox
EBAY_MARKETS=EBAY_ES               # the rollout cohort, an ALLOW-list
EPN_CAMPAIGN_ID=                   # ten digits; empty means run unattributed
EBAY_DAILY_CALL_LIMIT=5000         # what eBay granted; NOT a tuning knob
EBAY_RECONCILIATION_SAMPLE_SIZE=40
EBAY_KEYSET_ID=                    # named by credential_ref (`env:EBAY_KEYSET`)
EBAY_KEYSET_SECRET=
```

## 13. Production-readiness checklist

Nothing below can be done by an agent, and #65 acceptance 6 is not met until
every line is green.

1. [ ] eBay developer account and PRODUCTION keyset.
2. [ ] EPN account; a 10-digit campaign id in `EPN_CAMPAIGN_ID`.
3. [ ] **Buy API production application approved** and the Buy-API contracts
       signed. A sandbox keyset never feeds public pages (#64 §9.1).
4. [ ] `CATALOG_OPERATOR_OXY_USER_IDS` populated, or nobody can configure the
       source or review its policy.
5. [ ] The source configured with `seller_identity = per_record`, an eBay
       operator merchant BOUND, and a marketplace storefront BOUND.
6. [ ] A rights policy version published encoding §6, reviewed against the signed
       terms — including the image-caching answer, which is currently
       **requires account approval**.
7. [ ] The #90 condition ruleset for `ebay_browse` published from §6's table.
       Until then every eBay offer is `unmapped`.
8. [ ] A bounded discovery cohort configured (#65 acceptance 7) — start with one
       category in ES.
9. [ ] Drained by hand from `/internal/ingestion/drain` and its metrics read,
       BEFORE `CATALOG_INGESTION_ENABLED=true`.
10. [ ] One reconciliation sweep run and its findings read.
11. [ ] One real tracked click → conversion → commission row observed through EPN
        reporting before any revenue claim (#64 §9.4).
12. [ ] Measured refresh volume inside the documented quota with ≥50% headroom;
        beyond that, file eBay's application growth check BEFORE launch.
13. [ ] Alerting on `healthState` other than `full_feed_success`, on a climbing
        `consecutiveFailures`, on `callsRefused` moving off zero, and on
        `affiliate_attribution_missing`. Scraping belongs to `oxy-infra`.

## 14. What #65 deliberately did not build

Each is a named contract that fails closed, never a stub that lies.

- **#37 — the outbound/affiliate redirect.** The routing metadata is modelled and
  `destination_url` stays the ORIGINAL; nothing here composes a tracked URL.
- **#68 — refresh and expiry SCHEDULING.** #65 supplies the two pass shapes and
  what each may conclude; when they run is a cadence decision with numbers
  attached.
- **#74 — ranking.** A scanned gate fails the build if any module here reaches it.
- **#59 — review and correction** of an ambiguous match. The pipeline routes to
  the queue and resolves nothing in it.
- **#60 — minting** the canonical product a `create_new` recommends.
- **Per-seller eBay STOREFRONTS.** A seller with their own eBay Store could be a
  second storefront row; today every eBay offer sits on the marketplace
  storefront, which is what ADR 0002 D8's comparison needs and no less true.
- **#94's attribute registry.** eBay's `localizedAspects` are localized in both
  name and value, so they are carried as option assignments for #58 to score and
  are NOT claimed as registry values, which need a stable key and a unit.

## 15. This domain defines no freshness rule of its own — a scanned wall

`ebay-isolation.test.ts` scans for a SIXTH thing beside the five URL/redirect
walls: a local content TTL, a local staleness derivation, a local outage-grace
window or a local retirement decision. #68 owns how long an offer is worth
showing (a per-source policy, its derivation, its outage grace) and #62 owns
what may retire one; #65 consumes both and defines neither.

The gate exists because the tempting bug is a LOCAL one: this domain knows eBay
prices move hourly, so a private `EBAY_OFFER_TTL_SECONDS` or an `isStale(offer)`
helper reads as diligence rather than as a second authority. A second TTL does
not announce itself — it silently wins wherever it is consulted, and the
source's own reviewed rights policy stops meaning anything. The allowance is
narrowed to exactly one file, `token.ts`, whose lifetime is the OAuth ACCESS
TOKEN's — a credential's expiry, not content freshness — never to a pattern
another file could reuse. Both floor and mutation self-test: the scan asserts
at least 18 files scanned, and each detector is proven against a literal it
must catch.

## 16. Two `ingest.service.ts` bugs this suite caught, neither visible to a mocked test

Both are in #62's shared framework, exposed because this is the first REAL
adapter — the fixture adapter's fixed-past timestamps hid them.

1. **A page's `now` was captured before the adapter ran.** Any adapter stamping
   the real read instant produced `observedAt > now` and violated
   `catalog_source_objects_seen_order_check` and `offers_confirmed_order_check`
   on every record. Fixed by clamping the record's `observedAt` to the page
   clock (`max(now, observedAt)`), which preserves an earlier observation
   exactly and caps only the physically impossible direction — the same fix
   `docs/feed-importer.md` §"Two framework bugs" describes for #63.
2. **A record counted `stored` that then failed while matching was ALSO counted
   `rejected`.** `catalog_source_runs_intake_total_check` is the equality
   `fetched = stored + unchanged + rejected + quarantined`, so double-counting
   one record refuses the WHOLE run row — one bad downstream record took the
   entire page's bookkeeping with it. A post-intake failure is now isolated,
   caught and logged rather than rethrown; the object stays `observed` and the
   next pass retries it.
