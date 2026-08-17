# The Awin product-feed source (#66)

Per-advertiser product feeds from the Awin affiliate network, ingested through
#62's framework and #63's parsing stack, plus the Publisher API budget that
commission reconciliation (#67) spends.

- **Status:** Implemented; **not activated** — every gate in §11 is red until an
  approved publisher account exists.
- **Issue:** [#66](https://github.com/OxyHQ/Mercaria/issues/66), part of epic
  [#37](https://github.com/OxyHQ/Mercaria/issues/37). Source selection is
  [#64](https://github.com/OxyHQ/Mercaria/issues/64), decided in
  `docs/catalog-sources/2026-08-09-launch-sources.md`, which is binding.
- **Depends on:** #62 (`docs/ingestion.md`), #63 (`docs/feed-importer.md`),
  #57 (offers), #58 (matching), #68 (`docs/offer-freshness.md`).
- **Provider docs current as of:** 2026-08-09, cited inline. Anything that
  cannot be verified without an approved publisher account is marked
  **requires account approval** rather than guessed — the #64 precedent, and the
  reason §12 exists.

Schema decisions: `packages/backend/src/db/schema/CONVENTIONS.md` §"The Awin
retailer-network source".

---

## The failure modes that shape it

Four, and every decision below exists to make one of them unrepresentable.
Three are #66's own; the fourth is the one a network adds that a merchant feed
does not.

1. **One advertiser's broken feed retiring every other advertiser's catalogue.**
   A network is fifty catalogues behind one credential, and the tempting
   arrangement — one Mercaria source for "Awin" — makes every advertiser share
   one health state, one enumeration, one rights policy and one kill switch. A
   parse failure on advertiser 3 then reads as an incomplete enumeration of the
   whole network, and a complete one reads as authority to retire every
   advertiser that happened not to be in this pass.
2. **A feed row choosing where Mercaria's outbound redirect points.**
   `aw_deep_link` is a URL a stranger writes into a CSV, and #37's redirect
   exists to send a buyer to it. A feed that is compromised, mis-generated or
   simply mis-mapped turns Mercaria into an open redirect with the network's
   name on it.
3. **A brand in a feed becoming a claim about the retailer.** Awin advertisers
   publish brands they resell. Reading "this feed carries Sony" as "this
   advertiser is Sony's official store" is a badge nobody verified, on a page a
   buyer trusts.
4. **A per-process rate limiter reporting a fleet-wide budget.** Awin publishes
   **20 Publisher API calls a minute per user**, and every advertiser's feed
   download goes to one host under one key. A limiter that binds one ECS task
   binds nothing; its aggregate is whatever the task count happens to be.

---

## 1. Publisher approval and credential setup

**Requires account approval for every value below.** None of it can be done by
an agent — it needs a person, a payment card and a business identity.

| Step | What it produces | Verified source |
|---|---|---|
| Publisher application at `ui.awin.com/publisher-signup` | a publisher account and a numeric **publisher id** | [application process](https://www.awin.com/gb/compliance-and-regulations/application-process-and-joining-fee) |
| A **£5 / $1 refundable card deposit**, plus manual review of the application | identity verification; the deposit is returned | [joining requirements](https://success.awin.com/s/article/What-are-the-requirements-for-joining-the-Awin-network?language=en_US) |
| "Create-a-Feed" in the publisher UI | the **product-data API key** that appears IN THE PATH of every feed URL | [product feed list download](https://help.awin.com/developers/docs/product-feed-list-download) |
| Publisher API credential | an OAuth2 token for `api.awin.com` | [Publisher API](https://help.awin.com/apidocs) |

Mercaria's promotional property is `mercaria.co`, described in the application
as a comparison and marketplace surface. Awin lists comparison and content
publishers as a core publisher type, which is why #64 rated its contract risk
low.

**Three secrets, three locators, and Mercaria stores none of them.**
`catalog_source_configs.credential_ref` and this domain's own credential columns
hold a LOCATOR — `env:<NAME>` or `ssm:<path>`, shape-CHECKed and length-bounded
so a pasted key is refused by the database. The values live in GitHub Actions
repo secrets synced to SSM `/oxy/mercaria/*`, per the existing pipeline:

```
AWIN_PUBLISHER_ID          # not secret, but configuration
AWIN_FEED_API_KEY          # the product-data key; appears in the feed URL PATH
AWIN_PUBLISHER_API_TOKEN   # OAuth2, for GET /publishers/{id}/transactions (#67)
```

**The feed API key is a credential wearing a hostname**, because Awin puts it in
the path: `https://productdata.awin.com/datafeed/list/apikey/<KEY>`. #63 already
established the rule for exactly this URL — `redactFeedUrl` keeps the host and
removes everything after it — and #66 inherits it rather than re-deciding it.
No Awin URL is ever logged, stored on a row a projection reads, or returned by
the operator surface in any form other than its host.

---

## 2. Advertiser (merchant) enrolment requirements

Awin's model is **per-advertiser approval**: a publisher joins a programme and
the advertiser accepts, declines or later suspends the relationship. The feed
list reports that relationship per feed as a membership status, and the
distinction is commercially load-bearing — a deep link only earns commission for
a **joined** publisher.

Mercaria models it as two separate facts, deliberately not one:

- `awin_advertisers.membership_status` is **what Awin says** — one of
  `joined`, `pending`, `declined`, `suspended`, `left`, `not_joined`. Mercaria
  never writes an opinion into it.
- `awin_advertisers.activation` is **what Mercaria decided** —
  `candidate` → `sampling` → `active`, plus `paused` (the per-advertiser kill
  switch) and `closed` (the advertiser left, or the publisher was
  deauthorized).

Collapsing them would make "Awin suspended us" indistinguishable from "we paused
them", which are opposite next actions: the first is a conversation with the
advertiser and the second is a Mercaria decision somebody can simply reverse.

**Only `joined` is commissionable** (`AWIN_COMMISSIONABLE_MEMBERSHIPS`, one
member). Everything else produces an `informational` offer — see §7.

Pre-join visibility exists and is used: Awin exposes feeds for advertisers who
allow it, so an advertiser can be DISCOVERED, measured for identifier coverage
and evaluated before any application is sent. Such an advertiser stays
`not_joined` / `candidate` and publishes nothing.

---

## 3. Feed discovery and download

Two calls, both to `productdata.awin.com`, both through `safeFetch`, both under
the network budget of §4.

**The list.** `GET /datafeed/list/apikey/<KEY>` returns a CSV of every feed
visible to this publisher — programmes joined, plus advertisers who permit
pre-join visibility. Its columns include the advertiser id and name, the feed id
and name, the vertical, the primary region, the language, the currency, the
product count, the membership status, and — the one that decides the whole
refresh schedule — **`Last Imported`**, the instant Awin last regenerated that
feed
([product feed list download](https://help.awin.com/developers/docs/product-feed-list-download)).

**The feed.** Each row carries a download URL parameterised for format,
delimiter, compression and the column set. Mercaria requests CSV, comma
delimiter, gzip, and the columns of §5.

**Discovery is idempotent by construction** (feed-lifecycle 1). An advertiser is
keyed `UNIQUE(account_id, advertiser_id)` and a feed `UNIQUE(advertiser_id,
feed_id)`; a discovery pass upserts, and a re-run of the same list changes
nothing but `last_seen_in_list_at`. It never activates anything and never binds
a merchant — both are operator acts, because a network that added four hundred
advertisers overnight must not be able to start publishing them.

**A feed-list row Mercaria cannot fully parse is SEEN, not skipped**, and the
alternative is silently destructive. Closure is inferred from ABSENCE (§11), so
dropping a row whose membership word Awin added last week would make the
advertiser it names read as absent — closing a live programme and retiring its
catalogue. `AwinFeedListEntry` therefore has two branches and BOTH carry the
advertiser and feed ids: a `listing` was understood, an `unreadable` was merely
seen, and only the first applies a membership change. It is deliberately not
defaulted to `not_joined`: that is a real state Awin also reports, and the two
would become indistinguishable.

**An object's identity is `aw_product_id`, a code CONSTANT and not a
configuration surface.** #63 freezes its own `identity_key_fields` by trigger
because re-keying re-mints every object, retires the catalogue behind the old ids
and looks exactly like a retailer replacing their catalogue overnight. #66 takes
that one step further: a per-feed column would be a surface for the one decision
that does that to every advertiser at once, so there is no such surface.
`merchant_product_id` — the advertiser's own SKU — is carried as `sku` instead,
where #58 can read it as an identifier without it becoming Mercaria's idea of
which row this is. **Requires account approval:** whether `aw_product_id` is
stable across Awin's own feed REGENERATIONS is not verifiable from the public
documentation; if it turns out not to be, the response is #63's — a NEW source,
which is honest about re-minting — and never a quiet re-key.

**A pass that scanned rows and mapped none of them is REFUSED**
(`no_records_mapped`, a `schema_drift` classification added to #63's closed
refusal set). It read the bytes perfectly well and could not make a record out of
any of them, which is a change in the source's shape — a renamed identity column,
an error page served with a 200. An EMPTY feed is deliberately different and is
not this: `scanned = 0` is a catalogue with nothing in it, which a complete
enumeration is entitled to report and which legitimately retires everything the
source had.

**An unchanged feed is not downloaded** (feed-lifecycle 3). Two independent
detectors, and both are needed:

- `awin_feeds.imported_last_imported_at` is the `Last Imported` value of the
  last pass that actually consumed the feed. The scheduler skips a feed whose
  list value has not moved past it. This is the cheap one: it costs one CSV for
  the whole network.
- The HTTP conditional request (`If-None-Match` / `If-Modified-Since`) through
  #63's `openFeedStream`, whose `not_modified` branch carries **no bytes and no
  enumeration**. This is the correct one: a provider that regenerates a feed
  without changing it still answers 304, and #63's `FeedCompletionVerdict`
  already refuses to read that as a complete enumeration of zero records.

The second is not redundant. `Last Imported` is a claim by the provider about
its own pipeline; the validator is a claim about the bytes. Trusting only the
first would re-download a fifty-megabyte feed every time Awin re-ran a job that
changed nothing, and trusting only the second would fetch the whole network
hourly to find that out.

---

## 4. Formats, compression, size and cadence — and the budget

| Property | Value | Where it is enforced |
|---|---|---|
| Format | CSV, comma-delimited, quoted, one header row | `AWIN_FEED_PARSE_OPTIONS`, passed to #63's `streamFeedRecords` |
| Compression | gzip, single member | #63's `decompressBytes`; every multi-entry container is refused by NAME from its magic bytes |
| Encoding | UTF-8 | #63's `decodeText` |
| Size | single-digit MB gzip typical; every cap REFUSES rather than truncating | #63's `FEED_IMPORT_MAX_*` |
| Cadence | per advertiser, typically daily; driven by `Last Imported` | `awin_feeds`, §3 |
| Memory | bounded — bytes → decompression → decoding → records → mapped candidates are all async generators | #63's `feed-memory.test.ts` |

**No second parser, money reader, external-id derivation or content-hash scheme
exists in this domain.** That is issue rule 1 and it is checkable: the Awin
adapter imports `boundedBytes`, `decompressBytes`, `decodeText`,
`streamFeedRecords`, `mapFeedRecord`, `buildFeedStage`, `readFeedStagePage`,
`feedCompletionVerdict` and `mayReportCompleteEnumeration` from
`services/feed-import/`, and `awin-isolation.test.ts` fails the build if it
grows a local CSV reader, a local money parser or a local id join.

### The network budget binds the FLEET, and it is keyed on the ACCOUNT

Awin's published limit is **20 Publisher API calls per minute per user**
([Publisher API](https://help.awin.com/apidocs)). Feed downloads are not
described as call-metered, but they all go to one host under one key, so the
politeness bound belongs there too.

`awin_network_leases` is #68's `catalog_source_refresh_leases` — itself #122's
`supplier_call_leases` — pointed at an Awin **account**. A slot is a ROW, so
concurrency is a row lock; each slot carries its own equal share of the
per-minute allowance, so the rate bound is serialized by that same lock.

**#68's lease is keyed on `source_id`, and that is exactly why this table has to
exist.** With one Mercaria source per advertiser (§6), #68's budget bounds each
advertiser separately and the NETWORK not at all: fifty advertisers with an
allowance of twenty each is a thousand calls a minute at one host under one key.
The two are complementary and both are claimed — #68's says how hard Mercaria
may knock on one advertiser's feed, this one says how hard Mercaria may knock on
Awin.

The trade is the same one #68 states and is stated here rather than hidden: an
uneven arrival pattern can spend one slot's share while another sits idle, so
the limiter can UNDER-admit. That errs toward not exceeding a published limit,
which is the direction a provider punishes.

---

## 5. Merchant, advertiser and storefront identity mapping

**One Awin advertiser is one Mercaria `catalog_sources` row.** Everything else
follows from that, and it is the answer to failure mode 1.

```text
awin_accounts        (one publisher account, one credential, one budget)
  └── awin_advertisers   (one per Awin advertiser)
        ├── catalog_sources  ← #62's registry row: rights, status, health, runs
        ├── merchants        ← #54's commercial actor  (offers.merchant_id)
        ├── storefronts      ← #54's channel           (offers.storefront_id)
        └── awin_feeds       (one per Awin feed; an advertiser may publish several)
```

What that buys, stated as the acceptance criteria it satisfies:

- **Acceptance 3** — each retailer is a distinct merchant AND a distinct
  storefront, because they are separate rows created per advertiser.
- **Acceptance 5** — source and advertiser health are observable separately: the
  ADVERTISER's health is its own `catalog_source_configs.health_state`, and the
  NETWORK's is `awin_accounts` (the list poll, the deauthorization state, the
  budget). Had "Awin" been one source, these would be one number.
- **Feed lifecycle 7** — a malformed advertiser feed fails ITS run, marks ITS
  source, and nothing else. There is no shared enumeration to be incomplete.
- **Quality control 5** — the per-advertiser kill switch is
  `activation = 'paused'`, and #62's own `status = 'paused'` on that
  advertiser's source stops refresh while leaving display, which is the
  distinction #62 already drew.

**The merchant is BOUND, never inferred.** #62's rule is unchanged: the merchant
comes from `catalog_source_configs.merchant_id`, and a source with no merchant
produces no offers. Discovery creates the advertiser row and stops; binding is
an operator act. `merchant_hint` and `storefront_hint` from a feed row remain
hints that resolve nothing.

**An advertiser's feed can never establish a brand relationship.** This is
failure mode 3 and it is structural in three places:

1. The adapter emits `brandHint` on the `NormalizedSourceRecord` — #62's own
   type, documented as "a HINT; it resolves nothing" — and there is no field on
   it through which a provider module could assert a relationship.
2. `SUFFICIENT_EVIDENCE_KINDS` (#55) deliberately excludes anything a feed can
   supply, and `verification_method` has no `name_match` member, so *official
   store* and *authorized reseller* are unrepresentable from feed content.
3. `awin-isolation.test.ts` fails the build if any module in this domain
   references the relationship layer, with a mutation self-test on the detector.

An operator who believes an Awin advertiser IS a brand's official store files
that through #55, with evidence, four eyes and a validity window.

---

## 6. Data, image, caching and deletion rights

Encoded as a #62 rights policy, per the §6 rules of the #64 decision document.
Nothing here is a Mercaria default: a source permits nothing until a policy
version is published and reviewed, and withdrawing a right is a NEW version.

| #62 right | Awin verdict | Why |
|---|---|---|
| `store` | yes | the observation is Mercaria's own record of what was published |
| `cache` + `cache_ttl_seconds` | yes, keyed to `Last Imported` | Awin publishes no global TTL; per-programme terms override, so the number is a per-source #68 freshness version and never a constant |
| `display_price` | yes | the feed exists to be promoted |
| `display_media` | yes for a joined programme | feed content is licensed for PROMOTING the advertiser |
| `outbound_link` | yes | the deep link is the point |
| `affiliate_params` | **only while `membership_status = 'joined'`** | attribution belongs to the link, and a non-joined programme's link attributes to nobody |
| `index` | per programme | some advertisers restrict indexed comparison; a per-source policy is where that belongs |
| `automated_refresh` | yes | feed download is the supported mechanism |
| `extraction` | `disallowed`, always | the adapter declares `extraction: false` and there is no crawl anywhere in it |

**A relationship ending revokes display without deleting history.** An
advertiser that declines, suspends or leaves moves to `closed`, its source moves
to #62's `revoked`, and its offers retire — while `source_records`,
`catalog_source_objects`, the runs, the quality snapshots and every published
rights version survive. That is #62's acceptance 6 (`no UPDATE could delete the
history and no DELETE anywhere in this domain`) applied to a membership change,
and it is why revocation is a status transition rather than a cleanup.

**Images are hotlinked, not re-hosted.** Nothing in this domain uploads a
provider image to Oxy's file service; `NormalizedSourceRecord.media` carries the
advertiser's own absolute URLs, which is what `may_display_media` licenses.

---

## 7. Deep links, tracking, and not becoming an open redirect

This is failure mode 2, and it is the part of #66 with the most surface.

Every feed row can carry two URLs, and Mercaria keeps them as two different
facts for the whole of their lives:

| Feed column | Mapped to | What it is |
|---|---|---|
| `merchant_deep_link` | `NormalizedSourceRecord.sourceUrl` | the advertiser's OWN product page — the destination, preserved verbatim (adapter rule 10) |
| `aw_deep_link` | `NormalizedSourceRecord.affiliateUrl` | Awin's tracked redirector URL, **unmodified** |

`offers.destination_url` stays the ORIGINAL — #57's decision, unchanged — so
disclosure ("you are going to `retailer.example`") and reconciliation both have
a stable answer that no tracking layer can rewrite.

### The tracking link is validated against a CLOSED HOST SET, not sanitised

`AWIN_TRACKING_HOSTS` names the network's own redirectors, exactly:
`awin1.com`, `www.awin1.com`, `zenaps.com`, `www.zenaps.com`. A candidate
`aw_deep_link` is admitted only if it is `https:`, parses, and its host is a
member — compared **label-wise** against the registrable host, so
`awin1.com.evil.example` is not a match. Anything else is REFUSED and the row
keeps no affiliate URL at all.

Three properties fall out of that, and the third is the one worth stating:

1. **Mercaria cannot be made to redirect to an arbitrary host by a feed.** The
   set is a code constant, not a column, so a compromised feed, a mis-mapped
   column and an operator's typo all fail the same way.
2. **A refusal is recorded, never guessed.** `AwinTrackingVerdict` is a closed
   union — `approved`, `absent`, `rejected_host`, `rejected_scheme`,
   `rejected_shape`, `rights_withheld`, `not_commissionable` — and the reason
   reaches the quality snapshot, so "this advertiser's deep links stopped
   validating" is visible before a buyer finds it.
3. **Mercaria never CONSTRUCTS a tracking URL.** There is no code path that
   appends a click reference, a sub-id or a campaign parameter to an Awin link,
   because #64 §6 records the rule that attribution belongs to the link and #37
   must not strip or rewrite its parameters. Composing one would mean asserting
   an attribution contract Mercaria has not read.

### Informational and commission-eligible offers are separated by WITHHOLDING

Adapter rule 9. There is no `commissionable` column anywhere in this domain, and
— just as deliberately — **no second derivation of the offer's KIND**. #62's
`offerKindFor` already derives `affiliate | external | informational` from the
rights and the source kind, so a `deriveAwinOfferRouting` beside it would be two
representations of one fact and the one that eventually disagreed would be the
one nobody was reading.

So the division is exactly one question each:

```text
#66 answers: may Mercaria hand the network's tracking URL over AT ALL?
             assessAwinTrackingLink(candidate, membershipStatus, rights)
               → approved | absent | rejected_scheme | rejected_host
                 | rejected_shape | rights_withheld | not_commissionable

             withAssessedAwinTracking then WITHHOLDS a refused URL, so the
             record that reaches #62 simply has no `affiliateUrl`.

#62 answers: what kind of offer is this?
             offerKindFor(rights, sourceKind, destinationUrl)
               affiliate_network + affiliate_params ⇒ affiliate
               outbound_link, no affiliate params    ⇒ external
               no outbound_link / no destination     ⇒ informational
```

Withholding is what makes it work with no new mechanism: #62's own
`affiliate_params`-absent branch already stores no affiliate routing metadata,
leaves `destination_url` as the ORIGINAL and degrades #37 to the plain link. A
suspended programme therefore stops earning in the statement that records the
suspension, with no queue in between.

The assessment is taken TWICE and stored NEITHER time — once while the feed is
streaming, for the quality measurement, and once as each record leaves the
adapter. That is not duplication: a verdict computed at stage time and carried
in the staged line would be a stored copy of a derivation over three inputs, and
a pass that spans hours can outlive a rights withdrawal or a suspension.
`assessAwinTrackingLink` is pure, so the two calls cannot disagree about one row.

**Acceptance 4** — "tracking destinations are generated only for approved
offers" — is the host set plus the withholding, and both branches are pinned by
tests.

---

## 8. Conversion and commission-report availability

`GET /publishers/{publisherId}/transactions` returns individual transactions
with their status and commission over windows of **at most 31 days**
([endpoint reference](https://help.awin.com/apidocs/returns-a-list-of-transactions-for-a-given-publisher)),
under the 20-calls-a-minute budget of §4. The network minimum payout is
**$20/€20/£20-equivalent**, configurable upward
([payment thresholds](https://success.awin.com/s/article/What-are-the-payment-thresholds?language=en_US)).
Per-programme commission rates are visible only inside an approved account:
**requires account approval**.

**#66 still calls that endpoint from nowhere, and that stays deliberate rather
than unfinished.** ADR-level ownership is explicit: #67 owns the outbound
redirect AND commission reconciliation, and a transaction row Mercaria cannot
attribute to a click it recorded is not reconciliation — it is a number in a
table with nothing to compare it against. Storing them from #66 would have
produced exactly the "looked fine" shape this document opens with.

What #66 supplies, so #67 adds a caller and not a design:

- `AWIN_PUBLISHER_API_MAX_WINDOW_DAYS` (31) and
  `AWIN_PUBLISHER_API_CALLS_PER_MINUTE` (20) as shared-types constants.
- `splitAwinTransactionWindows(from, to)` — a pure, tested function that chunks
  a range into ≤31-day windows, inclusive of both ends, never emitting an empty
  or inverted window. #67's own reader
  (`services/outbound/reconciliation/awin.ts`) now calls it.
- The account-scoped network budget, already claimed by feed traffic, which
  #67's transaction poll joins rather than duplicating.

**#67 closed this seam.** `affiliate_transactions`,
`affiliate_transaction_observations` and `affiliate_commission_postings` store
what the reader reads, and `startAffiliateReconciliationDispatcher` is the
scheduled job that polls it — see `docs/affiliate-outbound.md`.

---

## 9. Country, currency and language coverage

Awin operates on the ground in 17 countries and is the EEA-strongest of the
networks evaluated in #64, with 30,000+ advertisers (ShareASale's ~9,500
advertisers merged in when that platform closed on 2025-10-06). Launch markets
are **Spain first**, then DE, FR, IT and GB.

- **Currency is per feed and is kept verbatim.** `offers.price_currency` is ADR
  0002 D18's documented CHECK exception precisely so a source may report a
  currency outside Mercaria's presentment set, and **Mercaria FX never re-prices
  an imported record**. A row whose currency Mercaria cannot read is REFUSED
  with the code named (#63's `unsupported_currency`), never converted and never
  defaulted — see §10.
- **Language and country ride the mapping's defaults** when the feed omits them,
  taken from the feed listing's own `Language` and `Primary Region` rather than
  invented. A feed that states neither and whose listing states neither leaves
  both absent, because #62's normalizer keeps an unknown fact ABSENT rather than
  zero.
- **Territory scoping is #62's `catalog_source_configs.territories`**, per
  advertiser. Acceptance 6 — a bounded market or category cohort before
  network-wide activation — is that column plus `activation`, and needs no new
  mechanism: an operator activates the ES cohort and leaves the rest
  `candidate`.

---

## 10. Quality controls, and per-advertiser exceptions

### Measured per advertiser, on the pass that produced them

`awin_advertiser_quality` is append-only (a trigger refuses UPDATE and DELETE)
and one row per import, citing the #62 run that produced it. It carries counts,
not opinions:

| Measured | Why it is the number that matters |
|---|---|
| `scanned`, `mapped`, `rejected` | the vacuity floor — a CHECK forces `scanned = mapped + rejected`, so a pass that swallowed rows cannot write the snapshot at all (#60's device) |
| `with_gtin`, `with_mpn`, `with_brand`, `with_image`, `with_price` | identifier completeness (quality control 1). Awin ships only MAPPED columns per feed, so coverage is per advertiser and must be measured rather than assumed |
| `duplicate_external_ids`, `duplicate_gtins` | duplicate rate (quality control 1). A duplicate external id is a broken feed; a duplicate GTIN across rows is a variant-grouping question for #59 |
| `rejected_currency`, `rejected_price`, `contradictory_availability` | quality control 2 — routed to errors, never guessed |
| `tracking_approved`, `tracking_rejected` | §7's verdicts, so a deep-link regression is visible |

**A contradictory availability is a REJECTION, not a repair.** `in_stock = 1`
beside `stock_quantity = 0`, or an availability word beside a quantity that
contradicts it, is refused for that row with the reason recorded. Picking a
winner would publish a number Mercaria invented on a page that says the retailer
said it.

### Feed-wide price-scale mistakes are #68's quarantine, not a second mechanism

Quality control 3 asks that a feed-wide price-scale mistake be detected before
publication. #68 already does exactly this and does it BEFORE any of the page is
applied: `catalog_source_distributions` holds the last sound distribution, the
detectors compare a page's median against it, and a quarantined page advances
NOTHING — `advanceObject` is unreachable, a property of the call graph. Its
`priceScaleFactor` default of 10 tells a legitimate half-price sale (well under
2×) from a minor/major units error (exactly 100×).

**#66 adds no threshold and no detector.** It supplies the per-source freshness
policy those thresholds live on, which is the supported way to say "this
advertiser's feed is volatile" without moving anybody else's number.

### Sampling before activation

Quality control 4. An advertiser cannot reach `active` from `candidate`
directly: it passes through `sampling`, and the transition to `active` requires
a recorded `awin_link_samples` verdict of `passed`.

**What the sample is TODAY: an operator's recorded verdict, not a measurement
Mercaria took.** `POST /internal/awin/advertisers/:id/samples` accepts the
verdict, the counts and the `findings` array; every value is supplied by the
caller and validated against the enum. **Nothing derives a finding.** All six
`AWIN_SAMPLE_FINDINGS` members are produced by no production code path
(measured in #573), so a `passed` sample means an operator asserted it — with an
append-only row naming them, which is a real audit trail and is not the same
thing as an automated check.

The DESTINATION half in particular does not exist. `destinationMatchesAdvertiser`
and `destinationHost` (`services/awin/tracking.ts`) are correct and tested and
have **no production caller**; `awin_advertisers.declared_host`, the expectation
they would compare against, has **no production writer**, so every row is NULL
and the helper would return `null` on every real input. #573 records the trace.

What IS measured automatically, on every ingested row rather than on a sample:
`assessAwinTrackingLink` checks the rights, the membership, presence,
parseability, HTTPS and tracking-host-in-approved-set (`isAwinTrackingHost`),
and the outcome is counted into `awin_advertiser_quality` as
`trackingApproved`/`trackingRejected`. So three of the four checks this section
used to claim are genuinely enforced — through the quality snapshot, on the
whole feed, which is stronger than a sample — and the fourth is absent.

Building the destination check, and deriving the findings rather than accepting
them, is tracked separately; until then read a `passed` sample as a human's
attestation. The row is append-only and names the operator who took it.

**A sample is evidence, not a gate that can be waived quietly.** There is no
"activate anyway" parameter; an advertiser whose sample failed is re-sampled
after the feed or the mapping changes.

Activation reads the NEWEST sample, never any passing one — a sample taken
before the advertiser's last feed change is evidence about a feed that no
longer exists, and reading the newest is what makes re-sampling after a
regression meaningful: a FAILED sample newer than a passed one blocks
activation, which is the point. **Resuming a `paused` advertiser goes back to
`sampling`, never straight to `active`** — whatever caused the pause may have
been a deep-link regression, and the sample is what tells that apart from an
unrelated incident.

### Per-advertiser exceptions and opt-out

Everything an advertiser-specific exception could need already exists per
advertiser, because the advertiser is a source:

| Exception | Where it lives |
|---|---|
| kill switch | `activation = 'paused'` + #62 source `status = 'paused'` |
| withdraw a right (no images, no indexing, no affiliate params) | a NEW #62 rights policy version on that source |
| different freshness / cache TTL / anomaly thresholds | a #68 freshness version on that source |
| different refresh cadence, page size, territories | `catalog_source_configs`, per source |
| opt out entirely | `activation = 'closed'` + source `revoked`; observations and audit survive |
| a column the advertiser does not publish | measured, not configured — the mapping is built from the feed's DECLARED columns |

**An advertiser's mapping is built in memory from its declared columns and
touches none of #63's tables.** `docs/feed-importer.md` states this explicitly as
the contract for #66: `ResolvedFeedMapping` holds no row id, so an Awin
advertiser — which has no `feed_configurations` row and should not have one —
gets a mapping without a merchant-facing configuration nobody registered it in.
`resolve.ts`, `configuration.service.ts`, `report.service.ts` and
`preview.service.ts` are #63's own surface and are NOT reused; the isolation gate
enforces that.

### Policy and mapping versions are recorded

Quality control 6. Every observation already cites #62's `policyVersion` and
`normalizationVersion`. #66 adds `AWIN_MAPPING_VERSION`, a code CONSTANT (the
`CATALOG_BACKFILL_MAPPING_VERSION` reasoning — a table would let somebody publish
a version whose rules nobody shipped), stamped on `awin_feeds.mapping_version`
at every import. Bumping it schedules a re-import rather than reinterpreting
stored facts.

---

## 11. Advertiser closure and publisher deauthorization

Feed lifecycle 8. Three events, three different responses, and the difference is
whether Mercaria may still READ.

| Event | Detected by | Response |
|---|---|---|
| An advertiser leaves or is declined/suspended | the feed list's membership status, or the feed disappearing from the list | `membership_status` updated; `activation` → `closed`; source → `revoked`; offers retire through #62's ordinary path |
| A feed is withdrawn but the programme stands | the feed missing from the list while the advertiser is still listed | the FEED is closed; the advertiser stays; other feeds continue |
| The publisher account is deauthorized (key revoked, account closed) | any list or feed call answering 401/403 | the ACCOUNT moves to `deauthorized`, every one of its advertisers stops refreshing, and **nothing is retired** |

**The third row is the one that costs money if it is wrong.** A revoked key
makes every feed unreadable, which looks exactly like a network whose catalogue
shrank to nothing. #62 already refuses to read that as retirement — an
`auth_failure` outcome is outside `CATALOG_SOURCE_RETIRING_OUTCOMES` and
`catalog_source_runs_retirement_check` refuses to store a non-zero retirement
count beside it — and #66 adds no path around that rule. Deauthorization stops
refresh and leaves display, which is #62's `paused` semantics applied at the
network level.

**Prior offers survive a transient failure until their TTL** (feed lifecycle 6),
which is #68's grace: an offer past its deadline leaves comparison immediately
(derived, at read time), while the durable RETIREMENT waits while the source is
in a fetch failure. `rights_suspended` earns no grace, and neither does
`schema_drift`.

---

## Surfaces

### Operator — `/internal/awin/*`

On the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#55/#56/#57/#58/#60/
#62/#63/#68 use. Empty list = not mounted (404, never a 401 that would advertise
the surface). It stays mounted while `AWIN_ENABLED` is off, for
`/internal/ingestion`'s reason: bringing a network up by hand is the supported
path, and the evidence has to be readable during the incident that turned the
loop off.

| Route | What it does |
|---|---|
| `GET /accounts` | every publisher account, its state, its budget, its last list poll |
| `POST /accounts` | register or reconfigure one. Permits nothing until reviewed |
| `POST /accounts/:accountId/state` | pause, resume, or record a deauthorization. A reason is mandatory |
| `POST /accounts/:accountId/discover` | poll the feed list NOW and reconcile advertisers and feeds |
| `GET /accounts/:accountId/advertisers` | this account's advertisers, with membership and activation |
| `GET /advertisers/:advertiserId` | one advertiser's trace: feeds, quality history, samples, its #62 source |
| `POST /advertisers/:advertiserId/activation` | move the activation. The per-advertiser kill switch |
| `POST /advertisers/:advertiserId/samples` | record a destination/tracking sample verdict |

**Deliberately absent:** any credential read or write; any delete of an account,
an advertiser, a feed, a quality snapshot or a sample; "set this offer's
tracking link"; "bind this merchant" (that is `/internal/ingestion`'s
`POST /sources`, where the binding already lives); and any flag write.

### There is no merchant surface

An Awin advertiser is not a Mercaria store and has no members. #63's
`/admin/stores/:storeId/feeds/*` is for a store's OWN inventory arriving by
file, and reaching for it here would make a network's catalogue depend on a
store nobody registered it under.

---

## Environment

```
AWIN_ENABLED=false                        # registers the adapter; gates the LOOP, never a record
AWIN_FEED_LIST_BASE_URL=https://productdata.awin.com
AWIN_PUBLISHER_API_BASE_URL=https://api.awin.com
AWIN_NETWORK_CONCURRENCY=2                # slots per account
AWIN_NETWORK_CALLS_PER_MINUTE=20          # Awin's published Publisher API limit
AWIN_NETWORK_LEASE_MS=120000
AWIN_LIST_TIMEOUT_MS=30000
AWIN_SAMPLE_SIZE=25                       # rows checked before an advertiser may activate
```

`AWIN_ENABLED` gates the adapter registration and nothing durable: accounts,
advertisers, feeds, quality snapshots, samples and every #62 row are stored and
readable either way, every run refuses with #62's own `adapter_missing`, and
turning it on drains the backlog. The download caps, the encoding and the record
limits are #63's `FEED_IMPORT_*` values — one set of refusal thresholds for
every feed this deployment reads, not a second set that could disagree.

**`AWIN_ENABLED` does not require a credential to be set**, unlike
`FEED_IMPORT_ENABLED`. The difference is real: #63 demands its encryption key
because a feed's credential has nowhere to GO without it, so a configuration
would be unstorable. Awin's key is a LOCATOR on a row, storable and reviewable
with no key present, and a deployment that registered the adapter before the
locator resolves gets an honest `auth_failure` naming the missing secret rather
than a silent no-op.

---

## Tests

| File | What it pins |
|---|---|
| `services/awin/__tests__/awin-rules.test.ts` (29 cases) | the feed-list reader, including the unreadable-row branch and case-insensitive headers; the in-memory mapping (`search_price` → the payable role, the two URL roles kept apart, the option axis names, Awin's `1`/`0` stock flag); tracking-link validation (approved host, look-alike host, scheme, shape) and the WITHHOLDING, including that the destination is untouched; the rights-and-membership refusals checked BEFORE the provider's string; quality measurement including the contradiction, the duplicate and the currency-versus-amount distinction; unchanged-feed detection on both detectors; credential-locator resolution including the placeholder case; URL composition; and the ≤31-day window chunker over 200 randomized ranges |
| `services/awin/__tests__/awin-isolation.test.ts` (18 cases) | no relationship layer, no canonical write, no offer write, no matcher, no ranking, no money domain, no second parser/money reader/id derivation/hash scheme, none of #63's four configuration modules; exactly ONE module makes an outbound call; no table has a URL column and the operator projection reports only whether a locator is configured; the disjoint claim vocabulary; the tracking hosts are bare lower-case hostnames — each with a vacuity floor, an enumeration floor read off the real directories, and a mutation self-test on every detector |
| `services/ingestion/adapters/__tests__/awin-feed-contract.test.ts` (20 cases) | #62's thirteen contract cases against the real adapter over a real GZIPPED CSV in Awin's own column names, plus the refusal classification over every member of the refusal set, the 304-is-not-an-enumeration branch, the `no_records_mapped` refusal, and the adapter's declarations |
| `services/__tests__/awin-writes.realdb.test.ts` (14 cases) | the CHECKs, the triggers, the uniques, the two append-only tables, the identity freeze, the pasted-key refusal, the activation service's two refusals a CHECK cannot express, the network lease's fleet-wide bound and its window roll — and the two acceptance criteria: TWO advertisers ingesting end to end as distinct merchants and storefronts, and a product shared with another source converging on ONE canonical variant with an `affiliate` offer beside an `external` one |

Acceptance criteria 1 and 2 are each a real test rather than a claim, per the
issue. Criterion 2 does not wait for #65: convergence is a property of #58's
identifier stage, so it is exercised with an Awin advertiser feed and a second,
non-Awin source publishing the same GTIN — which is what "where evidence
supports it" means and is testable today.

---

## Production-readiness checklist

Nothing below is green. Each is a gate, in the §9 sense of the #64 decision.

1. **Contract gate.** Publisher application approved, deposit paid, at least one
   advertiser programme joined. A pre-join preview feed never feeds public
   pages.
2. **Secrets.** `AWIN_PUBLISHER_ID`, `AWIN_FEED_API_KEY` and (for #67)
   `AWIN_PUBLISHER_API_TOKEN` in GitHub Actions repo secrets → SSM
   `/oxy/mercaria/*` → the task definition. Never a placeholder.
3. `CATALOG_OPERATOR_OXY_USER_IDS` populated, or `/internal/awin` is not mounted
   and nobody can register an account.
4. Per advertiser: a MERCHANT and a STOREFRONT bound on its #62 source (no
   merchant, no offers), a rights policy published and reviewed against the
   signed programme terms (§6), a #68 freshness version if its cache term
   differs, and the source moved to `active`.
5. Per advertiser: a `passed` sample recorded (§10) before `activation` reaches
   `active`.
6. **Sample gate** (#64 §9.3): ≥1,000 real records per launch advertiser mapped
   through this adapter with measured GTIN coverage, duplicate rate and
   field-quality numbers committed as a dated addendum in
   `docs/catalog-sources/`. Blocked until step 1.
7. `AWIN_ENABLED=true` and `CATALOG_INGESTION_ENABLED=true` only after one
   advertiser has been drained by hand from `/internal/ingestion/drain` and its
   metrics read.
8. A bounded market cohort (ES) activated before any network-wide activation
   (acceptance 6).
9. Alerting on: an account state other than `active`; an advertiser whose
   `health_state` is not `full_feed_success`; `tracking_rejected` climbing on
   any advertiser; and #62's `countsAgree` reading false. Scraping and alerting
   wiring belong to `oxy-infra`.

---

## What is deferred, and to whom

Each is a NAMED contract, not a stub that lies.

- **#67 is built.** `aw_deep_link` is validated, stored unmodified as
  `offers.affiliate_url` and never composed into a Mercaria URL — this domain
  never builds the outbound redirect itself; the destination stays the
  original. #67's own reader now calls the transactions endpoint (§8),
  consuming the window chunker and the network budget this domain supplies.
- **#59 — review and corrections.** A duplicate GTIN across an advertiser's own
  rows, a `create_new` recommendation and an ambiguous match all route to #58's
  queue, which #59 reads. This domain resolves none of them.
- **#74 — ranking.** No signal here is a ranking input, and a scanned gate fails
  the build if a feed, search or catalogue module reaches this domain.
- **#65 — the eBay Browse source.** Independent; the two share #62's framework
  and none of this. Convergence between them is exercised generically (see
  §Tests).
- **#84 — merchant→store linkage.** An Awin advertiser is not a native store and
  this domain writes no `native_store_links` row.
- **Bulk re-mapping of already-observed offers** after an `AWIN_MAPPING_VERSION`
  bump. The version is stamped on every import, which is what makes the sweep
  expressible when somebody needs it.

## What this source added to #63, and what it deliberately did not reuse

#63 was EXTENDED, never forked, in exactly two places, both generic:
`BuildStageInput.observe` (watch each record as it is mapped, in the ONE pass
that reads the feed — it returns `void`, the `recordAnalyticsEvent` device, so a
slow observer cannot join the critical path) and the `no_records_mapped` refusal
reason. Everything else is CALLED: `buildFeedStage`, `readFeedStagePage`,
`feedCompletionVerdict`, `mayReportCompleteEnumeration`, `openFeedStream`,
`FeedImportRefusal`.

#63's CONFIGURATION surface — `resolve.ts`, `configuration.service.ts`,
`report.service.ts`, `preview.service.ts` — is NOT reused, and a scanned gate
says so: it reads a merchant-facing table an Awin advertiser has no row in.
