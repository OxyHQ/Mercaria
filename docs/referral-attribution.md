# The referral attribution edge (#143)

How an approved referral gets from a partner's link or code into the exact
customer, guest checkout or merchant-claim journey — and, much more of the work,
everything that makes sure nothing else can.

#142 shipped the MODEL: programs, partners, codes, links, touches, attributions,
conversions, and the resolver that decides a winner. It shipped with **no HTTP
surface at all**. #143 is the edge: the route a stranger reaches, the classifier
that decides whether their visit is evidence of anything, the carrier that holds
a click until there is somebody to attribute it to, the two operator levers, and
the walls that keep all of it out of the money path.

Binding decisions: **ADR 0005** (`docs/adr/0005-referral-program.md`), D3–D6 and
identity boundaries A1–A4, which the ADR assigns to this issue by name. Guest
identity: **ADR 0003**, especially D2 and T10.

---

## The problem the whole design turns on

ADR 0005 D6 says a guest touch is stored against **the checkout-scoped id from
#101/#103**. ADR 0003 T10 says a page view **never creates one**: *"browsing
creates NO row… an anonymous crawler generates zero rows."*

A referral link click by a stranger is exactly a page view. So the two rules
together forbid both obvious shortcuts — minting a guest session on the redirect,
and writing a touch against an invented subject — and what is left is the design:

> **The click's evidence travels with the browser; the touch is written at the
> first moment there is a subject to attribute it to.**

An anonymous click writes no touch row. A crawler writes no touch row. A real
shopper's touch is recorded against the very session D6 names, at the moment
they do something that has a subject. Both rules hold and neither is bent.

---

## `GET /r/:token`

Public, unauthenticated, its own rate-limit bucket (`rl:referral-redirect:`), and
its own short prefix because it is what a partner pastes into a post — ADR 0005
D3's `mercaria.co/r/<token>`.

### The destination cannot come from the request

Nothing on this path accepts a URL. The absolute location is composed from
exactly two pieces:

1. `REFERRAL_REDIRECT_BASE_URL`, which must be a member of
   `lib/allowed-origins.ts` — the ONE origin authority this backend keeps,
   shared with CORS and the guest CSRF gate. A deployment-local second list is
   the shape an open redirect takes.
2. A **relative path** built by `services/referrals/destinations.ts` (#142) from
   a closed four-member template and an opaque id matched against
   `/^[A-Za-z0-9-]{1,64}$/`.

No query parameter, header or path segment beyond the token reaches it. The
route reads no query at all, so "arbitrary campaign injector" (acceptance 2) is
**inexpressible rather than filtered**; `campaignRef` and `contentKey` go on the
TOUCH, never into the URL.

The origin check compares parsed **hostnames exactly**. A suffix test admits
`mercaria.co.evil.example`, which is the classic way an allow-list becomes an
open redirect — #66's `AWIN_TRACKING_HOSTS` makes the same call for the same
reason. `composeReferralDestination` builds with the `URL` constructor rather
than string concatenation, because concatenation admits `//evil.example` as a
protocol-relative URL, and then compares the result's origin back anyway.

### 302 and `no-store`, and why the alternatives are wrong

| Header | Value | Why |
|---|---|---|
| status | `302` | A `301`/`308` is permanently cacheable. A browser that stopped asking would keep following a **revoked** link, stop spending the click ceiling, and make the operator lever inert. |
| `Cache-Control` | `no-store, no-cache, must-revalidate, private` | No intermediary holds the `Set-Cookie` this response may carry, and every click reaches the row that decides. |
| `Referrer-Policy` | `no-referrer` | The destination page never learns the token from a `Referer` header. |

### Redirect loops

The four destination templates cannot name this route, and the composed path is
asserted against `REFERRAL_ROUTE_PREFIXES` anyway — so a fifth template added
later fails at composition rather than looping a browser.

### Two branches, and the second one had a real bug

A click by a request that **already carries a subject** — a signed-in shopper, or
a native client presenting its guest credential — is resolved COMPLETELY at
click time: the touch is written and `attributeRecordedTouch` decides the winner.
No carrier is issued, because there is nothing to defer.

The first shape of this recorded the touch and stopped. That was wrong and
silently so: with no carrier, `POST /referrals/bind` would have had nothing to
present, so a signed-in buyer's click would have sat unattributed forever,
earning the partner nothing while every gate stayed green. Found by re-reading
the branch rather than by a failing test; now pinned by a realdb case that goes
red when the `attributeRecordedTouch` call is deleted (mutation-verified).

`attributeRecordedTouch` lives in `binding.service.ts` and both paths go through
it, because two places deciding whether a recorded touch becomes a winner would
be two answers to the attribution lever.

### Refusals are uniform

An unknown token, a forged signature, an expired link, a revoked link, a spent
click ceiling and a program whose redirect lever is down all answer the **same
404**. A distinguishable refusal would let a stranger enumerate which programs
exist and which are paused. The real disposition
(`ReferralRedirectDisposition`, five members) is for the operator trace.

---

## Traffic classification (`services/referrals/traffic.ts`)

### What it reads, exhaustively

Three self-declared request headers:

1. `User-Agent`, matched lowercased against a closed list of tokens automated
   clients put there **on purpose** so servers can tell.
2. The fetch-metadata purpose headers — `Sec-Purpose`, `Purpose`, `X-Purpose`,
   `X-Moz` — which a browser sets when prefetching or previewing.
3. `ANALYTICS_INTERNAL_TRAFFIC_TOKEN`, the marker that already exists for #77
   and authorizes nothing. Reused rather than duplicated: two ways to say "this
   is us" would eventually disagree about staff traffic (#143 web rule 9).

### What it deliberately cannot see

No IP, no reverse DNS, no TLS or JA3 fingerprint, no `Accept-Language`, no
`Accept`, no screen metric, no cookie, no per-client counter, **no stored state
of any kind**. The function takes a plain record of headers and returns a value;
there is no database handle in the signature and no module-level mutable state
in the file — so "the classifier is not a fingerprint" is a property of its
shape, not a promise. ADR 0005 D17 puts edge classification outside attribution
by name.

### The failure directions, stated

- **A crawler that lies is classified `organic`.** Accepted, and it is the SAFE
  direction: inferring automation from behaviour is the device fingerprint
  ADR 0005 A2 forbids, and it misclassifies real shoppers on shared networks.
  The answer to a lying crawler is D17's velocity thresholds and the per-code
  ceilings (#148), which read Mercaria's own commerce facts.
- **A misclassified human loses their attribution and nothing else.** They still
  reach the destination — the redirect never varies on the classification,
  because one that did would be cloaking.

### What a non-organic click costs a partner: nothing

No carrier, no touch, and **no click claimed against the ceiling**. A scanner
that burned a limited link's last click would cost the partner the campaign,
silently.

---

## The carrier (`services/referrals/referral-state.ts`)

A short-lived, purpose-specific credential that **authorizes nothing**.

- **Prefix `mrf_`** — not `mgs_` (cart), not `mgp_` (portal), not `mgx_`
  (exchange). ADR 0003 I5 scopes credentials by table, resolver and prefix, and
  this shares none of the three: it is STATELESS, so there is no table, and no
  guest resolver will look at it.
- **Stateless**: `mrf_<payloadB64url>.<sig>`, HMAC-SHA256 under
  `REFERRAL_STATE_SECRET` — its **own key**, not the link token's. A link token
  is published by a partner and public by design; this one is minted by the
  server, and one key for both would make a leak of the public half a mint for
  the private one.
- **The payload is `{l, c, t, x, n}`** — link id, code id, click instant,
  deadline, nonce. There is no user id, session id, order id or scope list in
  it, so there is nothing an authorization check could read even if one were
  written. That is ADR 0005 A1 as a property of the type. Decoding it discloses
  nothing new: both ids are already inside the signed link token the partner
  published, and neither names a partner, a program or a person.
- **The window anchor is inside the signature.** `clickedAt` is stamped once, at
  the redirect, and travels signed — so presenting the carrier again does not
  move it, and neither does re-issuing the cookie. #143 web rule 7 ("do not
  extend the window forever through every page view") is arithmetic on a value
  the client cannot edit.
- **Carriage in kind** (ADR 0003 D9's shape): web gets
  `__Host-mercaria_referral` (HttpOnly, Secure, SameSite=Lax, Path=/, no
  Domain); dev gets `mercaria_referral_dev` **without** Secure under a different
  name, logged once — an explicit downgrade, never a silent one. Native gets
  `X-Mercaria-Referral-State` with `X-Mercaria-Referral-Transport: header`.
- `SameSite=Lax` rather than `Strict`, because the carrier is SET on a top-level
  navigation arriving from a partner's own site — exactly the cross-site case
  `Strict` drops.
- **Capped at 90 days** whatever a program asks for.

A precision note worth keeping: `clickedAt` is stored in epoch **seconds**, so a
touch's `occurredAt` is truncated by up to 999 ms. The direction is what makes
it safe — truncation rounds DOWN, so a carried click can only look OLDER and can
never jump ahead of a code typed in the same second, and ADR 0005 D4 resolves an
exact tie by touch id, deterministically.

---

## Binding (`services/referrals/binding.service.ts`)

The one place a subject enters the referral domain. `touchActorFor` is the whole
translation and it is a `switch` over `CommerceActor`, which has **no common
`id` field** (ADR 0003 I1) — so an anonymous visitor cannot acquire a subject
reference, and `pending` is an ordinary answer rather than an error. The
`cartOwnerForActor` (#104) and `addressBookOwnerForActor` (#105) device.

| Surface | What it does |
|---|---|
| `POST /referrals/bind` | Redeem a carried click for the resolved actor. A redeemed carrier is CLEARED, so a second call finds nothing rather than recording a second touch for one click. |
| `POST /referrals/code-entry` | The buyer typed a code, at `in_app` or `at_checkout` — ADR 0005 D4's two code kinds. |
| `POST /referrals/merchant-binding` | Bind a carried click to a merchant the caller **already holds a claim on** (#83). |
| `GET /referrals/state` | What this browser is holding, for a disclosure banner. |

**Last touch wins and the code always wins** are neither implemented nor
re-derived here: ADR 0005 D4 gets both for free, because code entry IS a touch
and is by construction the latest one. There is no precedence branch anywhere to
disagree with.

### What can never reach it

No parameter for an email, a hash, a phone number, a card fingerprint, a Stripe
customer, a wallet identity, an IP or a device signature — and no function it
calls takes one. So "separate guest checkouts remain separate even when contact
or payment details match" (#143 guest rule 7) is true because nothing here can
observe that they match. The prohibition is also a VALUE
(`REFERRAL_FORBIDDEN_IDENTITY_SIGNALS`, fourteen members, disjoint from every
identity vocabulary this domain has) so a gate can measure it.

### Session rotation is structural

#103's rotation swaps `token_hash` **in place**; the `guest_sessions` row id —
which is what an attribution's subject reference is — never moves. So "session
rotation must not duplicate or lose a valid attribution" (#143 guest rule 3) is
true by construction rather than by a merge rule, and a realdb case drives it.

---

## The two operator levers

`referral_program_controls`, one row per **stable** `program_id`.

- **Why a separate table**: a `referral_programs` row is a VERSION and its terms
  are what an attribution pins (ADR 0005 D19). An operational switch on that row
  would be a mutable field inside an otherwise frozen record, and flipping it
  during an incident would edit the terms somebody was attributed under.
- **Absence means BOTH ENABLED.** The inverse would make every freshly published
  program silently unusable until an operator discovered a table they had never
  heard of; the domain is already bounded by `REFERRALS_ENABLED` and each
  program's own status.
- **`redirect_enabled = false`** stops `/r/:token` for that program's links. A
  code typed at checkout still attributes — that is what "independently" means.
- **`attribution_enabled = false`** stops NEW attributions and **still records
  the touch**. ADR 0005 D18's "gating loops and gates, never records": an effect
  that did not happen must stay distinguishable from one that never arrived.
  Prospective only; nothing already attributed moves.

Every change appends a `program_controls_set` event with a mandatory actor and
reason.

---

## The operator surface

`/internal/referrals/*` on a **SEVENTH** allow-list,
`REFERRAL_OPERATOR_OXY_USER_IDS`. Empty = not mounted (404, never 401).

A separate list because the POWER is separate: pausing a program's attribution
stops partners **earning**, and the trace says which partner was credited for
which subject. An operator vetted to repair a payment, trace a cart merge or
read discovery metrics has been vetted for neither. #147's dashboards and #148's
fraud surface inherit this list rather than adding an eighth.

**Three routes, and the set is CLOSED.** There is no "attribute this subject to
that partner", no "create a touch", no "extend this window", no "move this
attribution", no "who is attributed to this account" and no delete. Each would
be a way to make the record say something nobody observed; the two corrections
an operator legitimately makes already exist in #142 (`invalidateAttribution`,
`correctAttribution`), append-only and attributable. The trace opens from an
**attribution id** and nothing else.

Mounted while both levers are down and while `REFERRALS_ENABLED` is off — the
evidence has to be readable during the incident that turned the surface off.

---

## Consent

**Mercaria operates no consent framework.** There is no CMP, no stored consent
record and no jurisdiction table anywhere in this repository. What exists is a
DECLARATION the client makes, recorded verbatim on the touch
(`referral_touches.consent_mode`, #142), and acted on in exactly one way:
`denied` writes no web carrier and clears any it finds.

Where the declaration can be made is decided by what can actually be observed:

- **Native** can declare at click time (`X-Mercaria-Referral-Consent`).
- **Web cannot** — a top-level browser navigation sets no custom header and this
  route accepts no query parameter — so the declaration arrives at BIND time,
  where the body carries it.

This is recorded rather than assumed, and the framework that would let a web
client declare earlier is a named seam.

---

## Isolation, as a scanned gate

`services/__tests__/referral-attribution-isolation.test.ts`, with a vacuity
floor on both the raw and comment-stripped source and a mutation self-test on
every detector in both directions. Six walls:

1. **No payment rail.** The moment the edge could reach a PaymentIntent or the
   ledger is the moment attribution could refuse, delay or re-price a purchase
   (ADR 0005 I2/I4).
2. **No ranking.** #74's own gate forbids the reverse direction already; a
   measured partner is one join from a commission-weighted ordering (D20/I1).
3. **No forbidden identity signal**, all fourteen.
4. **No guest commerce session is created** — T10 is the reason the carrier
   exists at all.
5. **No commerce write path.** Cart, checkout, order and claim wall referral off
   from THEIR side; this is the same wall from this one, so neither list can
   quietly become one-directional.
6. **No analytics emission.** #143 privacy rule 8, and emitting nothing is the
   strongest form of it.

Plus: only `redirect.service.ts` may construct a `URL` at all, and no module may
read a host, origin or destination off the request.

**One real false positive it produced on its first run**, recorded because the
narrowing is now load-bearing: `body.redirectEnabled` — the operator LEVER, a
boolean — tripped the request-derived-destination detector. The pattern gained a
`\b` and both directions are pinned in the mutation self-test.

---

## Named seams, each failing closed

- **Verified universal links / App Links (#143 native rules 1, 9).**
  `packages/frontend` declares no `associatedDomains`, no Android
  `intentFilters` and no Apple Team ID, and none can be produced without a
  signed app-store build. Mercaria therefore serves **no association file and
  claims no universal link**, so a referral link on a device opens in the
  browser — which is native rule 7's web-fallback case, deterministic and
  correct. Shipping a fabricated `apple-app-site-association` would claim a
  verification that is not real, and a custom scheme (`mercaria://`) is exactly
  what native rule 9 excludes, since any app may claim one.
- **Deferred deep linking (native rule 2).**
  `ReferralDeferredDeepLinkSupport` has ONE member, `unsupported`. A
  single-member union is how that is made unrepresentable rather than
  unimplemented: no configuration, operator action or service bug can turn a
  device fingerprint into a deferred match. The mechanism arrives WITH the
  reviewed provider, in the change that adds a second member —
  `GuestP2PAuthorization` (#112), which still has no member meaning yes.
  `GuestSellerActivation` (#107) was the same device and is now the precedent
  for how it ENDS: #85 supplied the capability, and the change that supplied it
  (#324) is the change that added `{state: 'activated'}`.
- **A consent framework** (web rule 5), as above.
- **Client surfaces.** No storefront or dashboard screen consumes
  `/referrals/*` yet; that is #147's work, and every endpoint it needs exists.
- **A merge does not rehome a standing attribution.** #142's
  `recordSubjectMerge` is explicit that "history keeps its references; reads and
  NEW attributions resolve through the redirect", and its own realdb file pins
  that the pre-merge row is not rewritten. The consequence, asserted in
  `referral-edge.realdb.test.ts` rather than left to be discovered: **with** a
  post-merge touch — the normal course for a merchant referral, which converts
  at activation (D11) — the partner keeps credit on the survivor; **without**
  one, the pre-merge row stays `active` on the retired reference and is
  unreachable by resolution, because `resolveSubjectRef` maps from→to and
  nothing maps survivor→duplicate. Repairing one is an existing audited operator
  act (`correctAttribution`). Changing the merge to supersede instead would
  redefine semantics #142 ships and tests, so it is named here rather than done
  in passing.

---

## Environment

```
REFERRALS_ENABLED=false            # gates the MOUNT of /r and /referrals, never a record
REFERRAL_LINK_TOKEN_SECRET=        # #142's public link token
REFERRAL_STATE_SECRET=             # #143's carrier — a SECOND key, required together
REFERRAL_REDIRECT_BASE_URL=https://mercaria.co   # must be in lib/allowed-origins.ts
REFERRAL_OPERATOR_OXY_USER_IDS=    # the SEVENTH list; empty = /internal/referrals unmounted
```

`REFERRALS_ENABLED=true` requires **both** secrets — the `CROWDSOURCE_ENABLED`
half-configuration rule. A deployment that can mint links but cannot sign the
carrier would redirect every anonymous click and then throw when it tried to
hand the browser its evidence: a program that appears to work and attributes
nobody.

---

## Production-readiness checklist

- [ ] `REFERRAL_STATE_SECRET` provisioned (SSM `/oxy/mercaria/*`), distinct from
      `REFERRAL_LINK_TOKEN_SECRET`.
- [ ] `REFERRAL_REDIRECT_BASE_URL` set and present in `PRODUCTION_ORIGINS`.
- [ ] `REFERRAL_OPERATOR_OXY_USER_IDS` populated — until it is, nobody can pause
      a program or trace an attribution.
- [ ] `ANALYTICS_INTERNAL_TRAFFIC_TOKEN` set, or staff traffic classifies
      `organic` and enters attribution.
- [ ] The privacy review ADR 0005 A1–A5 owes, recorded, before
      `REFERRALS_ENABLED=true` in production.
