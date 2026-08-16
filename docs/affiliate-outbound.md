# Affiliate outbound redirects, attribution and commission (#67)

Part of #37. Consumes #57 (the offer), #62 (the rights), #65 and #66 (the two
launch sources), #68 (the freshness gate) and #143 (the traffic classifier).
Closes #71's outbound seam and #144's `affiliate` funding port.

Code: `services/outbound/`, `services/outbound/reconciliation/`,
`db/affiliateOutbound/`, `db/schema/affiliateOutbound.ts`, `routes/outbound.ts`,
`routes/internal-affiliate.ts`. Schema decisions live in
`packages/backend/src/db/schema/CONVENTIONS.md` §"Affiliate outbound redirects
and commission (#67)".

---

## The two failure modes that shape everything

**An open redirect wearing a marketplace's name.** `GET /out/:token` exists to
send a visitor to somebody else's site, so the whole design is about making the
set of places it can send them not a function of anything a caller supplies.

**A commission Mercaria booked that the network never paid.** A pending
commission is a claim the network may still decline, so nothing reaches the
ledger until it says `approved`, and a reversal is a new balanced transaction
rather than an edit.

---

## How the open redirect is made unrepresentable rather than checked

Three independent things, and only the third is a check.

1. **The token cannot carry a destination.**
   `AffiliateOutboundTokenClaims` has ONE member and it is an offer id. There is
   no field a URL could arrive in, so requirement 1 is settled before any code
   runs. The HMAC signature buys something narrower and it is worth not
   confusing the two: it stops a stranger minting a token naming a GUESSED offer
   id, so nothing unverified reaches a database read.
2. **The route reads no query and no body.** `admitOutboundDestination` takes a
   stored offer row and an allow-list and nothing derived from the request — the
   SIGNATURE is the version of that a reviewer can check. `outbound-isolation.test.ts`
   scans the whole domain for `req.query`, `req.body`, `req.get('host')` and
   `x-forwarded-host`.
3. **The stored URL is still admitted rather than trusted.** A feed row is a URL
   a stranger writes into a CSV, so "it came out of our own database" is not the
   same as "we chose it".

The admission itself, in order: `https:` only (a downgrade is not a
destination, and `data:`, `javascript:` and `blob:` all parse); no credentials
in the authority; the host is not a Mercaria host (requirement 10's loop,
checked BEFORE the allow-list so an operator cannot create one by mistake); and
then the host must be either a network's own redirector (a code constant) or on
the source's operator-approved allow-list.

**Every comparison is EXACT, on a parsed `URL.hostname`, lower-cased.** Never
`endsWith`, under which `example.com.evil.test` matches `example.com`. The
isolation gate's third wall is the one that matters most here, and it is
receiver-scoped: `host.endsWith(x)` is refused, `arrayOfHosts.includes(host)` is
the correct shape and is not. That distinction was measured rather than assumed
— the first version of the pattern flagged the two lines that implement the rule
it exists to enforce, which is a gate whose cheapest green is to weaken the
correct code.

---

## Mercaria composes NOTHING

The URL handed over is the provider's OWN, verbatim: `affiliate_tracking_template`
when present (Awin's `aw_deep_link`, admitted against `AWIN_TRACKING_HOSTS` at
ingestion by #66; eBay's `itemAffiliateWebUrl`, minted by eBay under the campaign
id Mercaria sends in an INGESTION header), else `destination_url`.

The column's name is a leftover: #57 described it as "a template carrying a
`{destination}` placeholder", and **nothing in this repository has ever
interpolated one** — `ingest.service.ts` writes the provider's complete
attributed URL into it. The docblock has been corrected. #65 states
`EBAY_FORBIDDEN_LINK_OPERATIONS` as values and #66 records that "attribution
belongs to the link"; a rebuilt link is indistinguishable from a working one
until a month of revenue is missing, which is why composing is worse than doing
nothing.

**The host DISCLOSED is the merchant, not the network.** On an Awin offer the
URL actually handed over is `www.awin1.com/…`, which is a hop rather than a
shop; the product page discloses `destination_url`'s host — the retailer, as the
source published it — because requirement 5 asks for "the real destination
merchant". Getting these backwards would tell a shopper they are going to an
affiliate network they have never heard of.

---

## The live rights check #67 added to #68's gate

`assertOfferOutboundEligible` checked `catalog_sources.may_display` — the coarse
umbrella — and never the `outbound_link` RIGHT. The offer's KIND is derived from
that right at INGESTION time (no `outbound_link` ⇒ `informational` ⇒ a CHECK
refuses a destination), so a source that never granted it produces nothing to
redirect to. What that left uncovered is the case #67 closes: a source that
GRANTED the right, produced `affiliate` offers with destinations, then published
a new policy version WITHDRAWING it. Those rows keep their kind and destination
until re-ingested.

The check lives in the GATE rather than in the redirect, because two authorities
answering "may this link out" is the shape that ends with one of them stale.
`outbound_not_permitted` already existed for it and needed no new vocabulary. A
source with NO ingestion config at all is left to `may_display` alone — #60's
backfill and the hand-created operator source are the two that exist, they
predate #62's rights model, and inventing a refusal would withdraw offers from a
surface that never had a policy to consult.

---

## The click record

Written on BOTH paths. A refusal that stored nothing would make "why is this
merchant's button dead" unanswerable, which is the question an operator gets.

**There is no actor column of any kind.** #67 click requirement 5 offers a
signed-in Oxy id "when permitted and needed" or a pseudonymous session id, and
the answer taken here is NEITHER: every metric the issue names is a count or a
sum over offers, merchants, sources and markets, so a per-person handle on a
commercial record retained for accounting buys nothing and is a correlation key.
`consent_mode` is still recorded, because the lawful basis for the measurement
is a fact about the request even when the measurement names nobody.

The forbidden set is named as VALUES (`AFFILIATE_FORBIDDEN_CLICK_FACTS`, sixteen
of them) and is disjoint from the recorded set by a test, plus a WALK of the real
drizzle tables — because a value list goes stale while a column is added.

**Retention** is `retention_expires_at`, stamped at write time from
`AFFILIATE_CLICK_RETENTION_DAYS` (400 by default) and swept by the shared expiry
sweep. Longer than every network's correction window, because a click whose
commission is reversed eleven months later must still be traceable to the offer
it was for; shorter than the commission record it supports, which is accounting.

---

## Bots, previews and internal traffic

Classified by #143's `classifyReferralTraffic` — REUSED, never re-implemented,
because two answers to "is this a person" would disagree. It reads a
`User-Agent`, four purpose headers and #77's internal-traffic token, stores
nothing, and returns a bounded `signal` enum rather than the header that
produced it.

**A classification never changes the destination.** A bot gets the redirect and
gets a click row; it is excluded from `humanClicks` by `traffic_class`. Varying
the destination by user agent is cloaking, and it is the one thing this route
must not do. A crawler that LIES is classified `organic`, which is the safe
direction — the answer to that is velocity analysis, not behavioural inference.

---

## Commission: what the network says, and what Mercaria books

Five states — `pending`, `approved`, `declined`, `reversed`, `paid` — and they
are the NETWORK's word. Mercaria's own bookkeeping is in separate columns.

- **`pending` books NOTHING.** Booking a claim the network may still decline is
  the invented sale trust principle 4 forbids.
- **Accrual** (`approved` or `paid`): debit `affiliate_receivable`, credit
  `affiliate_commission_revenue`.
- **Reversal**: the exact inverse, as a NEW balanced transaction. There is no
  `reverseTransaction(id)` helper, because one would make a correction a
  function of what is stored rather than of what the network decided.
- **Settlement** (`paid`): debit `platform_funds`, credit
  `affiliate_receivable`.

Booked in the commission's OWN currency, with no FX anywhere — which is what
makes "sums to zero per currency" hold with no rate involved.

`affiliate_commission_revenue` is a new account because #89 acceptance 6 asks
that subscription revenue, marketplace fees and affiliate commission report
separately, and the third had nowhere to go. Booking it into `commission_revenue`
would make the one figure ADR 0001 D3 says exists nowhere else stop meaning what
it means.

---

## Attribution, and the honest state of it

**Every network-reported transaction is `unmatched` today, under
`network_supplies_no_reference`.** That is not a gap in the matching code; it is
a consequence of #65 and #66.

`AFFILIATE_CLICK_REFERENCE_SUPPORT` records both networks as `not_supported`.
Mercaria may not compose or mutate an affiliate link, so there is no per-click
parameter it can add and therefore no reference for the network to echo back.
eBay's publisher reference is sent in an INGESTION header, once per read, not per
click.

Conversion requirement 6 names exactly this outcome — "attribution without a
Mercaria click id, marked as unmatched rather than guessed" — so `unmatched` is a
first-class state with a reason that says WHICH kind of unmatched it is, rather
than a failure. The matching function is real, pure and tested directly with a
reference that resolves; what would close the seam is a network contract that
carries a publisher reference, plus the adapter change to send it, and nothing in
the matching path would move.

---

## Reporting

`GET /internal/affiliate/report` returns human clicks, non-human clicks and
refusals. It returns NO conversion or commission figure, and the two halves are
never divided: #37 acceptance 3 forbids deriving a network conversion from a
click, and a network report is revisable for weeks while a click is not, so the
ratio would move without either input being wrong. #77's `affiliate_commission`
metric names `affiliate_reports` as its source and that stays true.

---

## Environment

| Variable | Default | What it gates |
|---|---|---|
| `OUTBOUND_REDIRECT_ENABLED` | `false` | The `/out` MOUNT. Requires `OUTBOUND_TOKEN_SECRET` (half-configuration rule). |
| `OUTBOUND_TOKEN_SECRET` | — | HMAC key for the opaque token. |
| `AFFILIATE_RECONCILIATION_ENABLED` | `false` | The report-poll LOOP only. |
| `AFFILIATE_CLICK_RETENTION_DAYS` | `400` | The click retention deadline. |
| `AFFILIATE_REPORT_LOOKBACK_DAYS` | `45` | How far back a scheduled poll asks. |
| `AFFILIATE_REPORT_POLL_INTERVAL_MS` | `3600000` | Between polls. |
| `AFFILIATE_REPORT_LEASE_MS` | `300000` | One poll's lease. |

The MOUNT gate is the Stripe-webhook reasoning rather than "gate the loop, never
the record": the token is signed, so without a secret there is nothing to verify
and resolving one would be acting on a stranger's opinion about which offer to
redirect to. **It gates no durable record** — clicks are written BY the route, so
an unmounted route writes none and no queue can strand. With it off the product
page renders its existing `redirect_unavailable` branch.

The operator surface is on `PAYMENT_OPERATOR_OXY_USER_IDS` and is NOT gated on
the redirect: a host must be approvable before the redirect is switched on, and
the evidence must be readable during the incident that switched it off.

---

## Seams, each failing closed

- **A per-click network reference.** See "Attribution" above. Needs a network
  contract, not code.
- **eBay commission reconciliation.** No EPN reporting reader exists; a poll for
  the `ebay` network answers `network_not_configured`, which is an
  `AffiliateReportFailureReason` that exists for exactly this. It is deliberately
  NOT a stub returning an empty list — an empty list is indistinguishable from
  "no conversions" and would report a healthy zero forever.
- **`resolveChannelOutbound` (#73's merchant channel page)** still refuses
  unconditionally, and that is left rather than closed: a channel visit is not
  an offer click. There is no offer to revalidate, no per-offer source right to
  check and no commission to attribute — it would be a plain link to a
  storefront's own public URL, which is #73's decision to make.
- **Anchor-level `rel="sponsored nofollow noopener"`.** `OUTBOUND_LINK_REL` is
  published as DATA on the DTO, and the redirect answers
  `X-Robots-Tag: noindex, nofollow` itself. The storefront renders a `Pressable`
  rather than an anchor, so there is no `rel` attribute to set; whatever renders
  real server-side HTML (#75's public routes) applies it from the field rather
  than re-deriving it.
- **#77's client-side `external_outbound_click` event.** The storefront has no
  analytics client (#111 owns it). The server-side click ROW is the durable
  record and is what the operator report counts.
