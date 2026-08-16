# Guest commerce: the M8 security and privacy review (#101)

- **Date:** 2026-08-16
- **Reviewed revision:** `c25d3c3` (`origin/main` at the time of review)
- **Scope:** ADR 0003 (`docs/adr/0003-commerce-actor-guest-identity.md`) as
  implemented by #103–#112, plus ADR 0006's guest card rail where it touches
  identity.
- **Why this document exists.** ADR 0003 M8 and its acceptance criterion 8 make
  a recorded security review and a recorded privacy/retention review binding
  preconditions for `GUEST_COMMERCE_ENABLED=true` in any non-test environment.
  #111 turned that into two rows of a machine-readable register —
  `security_review_complete` and `privacy_and_retention_review_complete` in
  `GUEST_LAUNCH_GATES` (`packages/shared-types/src/guest-governance.ts:767-768`),
  both `evidenceKind: 'document_approval'`, both required from
  `stage_1_staff_canary`. This document is the evidence those two gates name.
  The privacy gate's criterion additionally says it "is also what unblocks
  `ANALYTICS_COLLECTION_MODE` moving off `off`"
  (`packages/shared-types/src/guest-governance.ts:1817`).
- **Outcome: NOT SIGNED OFF.** `security_review_complete`'s criterion is "a
  recorded review covering all five surfaces, **with no unresolved critical or
  high finding**" (`packages/shared-types/src/guest-governance.ts:1810`). Four
  High findings are unresolved. Three of them are in the privacy half, and one
  of those — a data-subject erasure path that erases nothing and reports success
  — is the kind of defect that is only harmless because nobody wired it up.

The credential machinery is in good shape and I say so with measurements. The
**retention and erasure** half of ADR 0003 is not: it is designed, typed,
registered, tested and largely **unexecuted**. That asymmetry is the headline of
this review, and the volume of good news in §4A–§4D must not be read as diluting
it.

---

## 1. How to read this

Every claim is tagged. The distinction is the point, not decoration — this
repository has been bitten hardest by confident sentences with no measurement
behind them.

| Tag | Meaning |
|---|---|
| **MEASURED** | I ran something and read its output. The command is stated. |
| **READ** | I read the code or a comment and am reporting what it says. Reading a docblock is not verifying its claim, and several findings below are exactly the gap between the two. |
| **INFERRED** | A conclusion drawn from the above, stated as such so a later reader can re-derive it. |

Absence claims carry the control that proves the instrument could see the thing
it reports missing. A scan that reports zero and a scan that read nothing look
identical.

Findings were produced by me and by three parallel read-only audits working in
the same worktree at the same revision. **Every High and Medium finding below
that originated with an audit was re-measured by me before publication**, with
the command stated; where I am relaying a measurement I did not repeat, I say
so.

**Everything here was measured on 2026-08-16 against `c25d3c3`.** "X does not
exist" is the one observation that expires on its own.

### The five surfaces the gate names

`security_review_complete` names session, CSRF, magic links, provider identity
and order authorization. They are §4A, §4B, §4A + §4C, §4D and §4C
respectively. All five are covered.

---

## 2. Findings

| # | Severity | Finding | Disposition |
|---|---|---|---|
| M8-01 | **High** | The buyer-facing D15 erasure path is unreachable dead code that erases nothing and would report success. Being unreachable is the only thing preventing a false erasure receipt. | **Must fix before enabling** |
| M8-02 | **High** | There is no scheduled contact-minimization loop, and the configuration says there is. `GUEST_RETENTION_JOB_ENABLED` (default `true`) and its poll interval are declared and read by nothing; a controller docblock cites a loop that does not exist. | **Must fix before enabling** |
| M8-03 | **High** | The documented anti-farming control for session issuance (T10) is inert by default, and with it off no abuse counter is written either — so turning it on later starts from zero, which its own docblock denies. | **Must fix before enabling** |
| M8-04 | **High** | Nothing could have caught M8-02 or M8-03. The lever-coverage gate runs **register → config only** and the two unread levers are precisely the two the register omits; the retention-policy gate compares two declared numbers; the data-inventory census checks the inventory against a hand-maintained list carrying the same error. All three are green. | **Must fix before enabling** |
| M8-05 | **Medium** | The production CORS and CSRF allow-list contains eleven development origins unconditionally, inverting D10's stated relationship between Origin verification and `SameSite=Lax`. | **Must fix before enabling** |
| M8-06 | **Medium** | `GUEST_EMAIL_HASH_KEY` cannot be rotated: no key id, no previous-key path. A rotation silently and permanently breaks recovery for every existing guest order, with no observable symptom, because the recovery endpoint is deliberately non-enumerating. | **Decision required before enabling** |
| M8-07 | **Medium** | `GUEST_PII_ENCRYPTION_KEY` rotation is documented as supported and is not implemented. | **Must fix before enabling** (the comment at minimum; the capability before any rotation) |
| M8-08 | **Medium** | `guest_contact_suppressions.email_hash` survives erasure forever — the same HMAC, key and preimage as the record erasure clears. Deliberately unswept, for a good reason, which makes it a conflict to resolve rather than an oversight to delete. | **Decision required before enabling** |
| M8-09 | **Medium** | The governance registries contradict each other and the schema: a class declares a mechanism nothing implements, a table is assigned to a sweep it is not in, and the inventory names a table that does not exist. | Fix with M8-02 |
| M8-10 | **Medium** | `purchase_orders.destination_*` is a second full postal-address copy of a buyer that ADR 0003 D15 does not anticipate and no erasure path reaches. | **Decision required before enabling** |
| M8-11 | **Medium** | The storefront portal screen accepts the `mgx_` exchange token as a **query parameter** and does not strip it, defeating T4 for any link that arrives in that shape. Latent: nothing here produces such a link. | **Must fix before enabling** |
| M8-12 | **Low** | D11 presents the 30-day idle window as a retention property. It is an authorization property only: no column, no index, no sweep predicate — an idle session and its cart survive to day 97. | Correct the ADR/doc; decide whether the sweep should honour it |
| M8-13 | **Low** | Four of six abuse policies have no caller; only `session_issuance` runs. `recovery_spraying` carries a rationale and does not execute. | Fix with M8-03 |
| M8-14 | **Low** | `PROTECTED_COLUMNS`' implicit-whole-row-read detector cannot see `.returning()`; four live bypasses exist on protected guest tables. A gate gap, not a proven disclosure. | Accepted residual + fix the detector |
| M8-15 | **Low** | The guest and portal cookie profiles decide both their NAME and their `Secure` flag from `NODE_ENV`, with no boot-time assertion. The same variable also decides `mockPayEnabled` (which defaults **on** when it is unset) and auth debug logging. | Accepted residual + recommended boot assertion |
| M8-16 | **Informational** | Documentation drift, three instances: `rl:guest-issue:` is described as the primary anti-farming control (it is now the residual); `AGENTS.md` says two of the portal's throttle axes are durable (all three are); guest-prefixed limiters are described as actor-keyed (they key per hashed IP — only the six `makeActorRateLimiter` scopes key per session). | Fix the prose |

**Positive results are recorded too**, in §4A–§4D and §5, with the controls that
make each absence claim non-vacuous. The credential design, the scope
containment, the provider-identity boundary and the analytics identity model all
hold under measurement.

---

## 3. What I ran

```
git -C .worktrees/w-disco rev-parse HEAD          # c25d3c3 == origin/main
bun install

# static gates (no database)
bun run vitest run \
  src/services/__tests__/guest-portal-isolation.test.ts \
  src/services/__tests__/guest-claim-isolation.test.ts \
  src/services/__tests__/guest-governance-isolation.test.ts \
  src/services/__tests__/order-access-isolation.test.ts \
  src/services/__tests__/cart-merge-isolation.test.ts \
  src/services/__tests__/checkout-contact-isolation.test.ts \
  src/services/__tests__/guest-stripe-checkout-isolation.test.ts \
  src/services/__tests__/guest-p2p-isolation.test.ts \
  src/services/__tests__/guest-session.service.test.ts
# → 9 files, 72 tests passed (2.86 s)

bun run vitest run src/db/__tests__/guest-data-inventory-census.test.ts
# → 1 file, 10 tests passed

# real-server gates, postgis/postgis:17-3.5 on 127.0.0.1:5480
TEST_DATABASE_URL=postgres://…/mercaria_ci bun run vitest run \
  src/services/__tests__/guest-portal.realdb.test.ts \
  src/services/__tests__/guest-session.realdb.test.ts \
  src/services/__tests__/guest-claim.realdb.test.ts \
  src/services/__tests__/guest-governance.realdb.test.ts \
  src/db/guests/__tests__/guest-checkout.realdb.test.ts
# → 5 files, 94 tests passed (4.94 s)
```

**MEASURED.** All green on `c25d3c3`. That is a real result and a bounded one: a
green isolation suite says the walls it scans for are standing, not that they
are the right walls. M8-04 is what happens when nobody asks the second question.

---

## 4. Surface by surface

### 4A. Credential handling — `mgs_`, `mgx_`, `mgp_`

**Mint and storage.** All three are `<prefix>` + base64url of 32 CSPRNG bytes,
stored as hex SHA-256 only — `services/guest-session.service.ts:52,55,86-94` and
`services/guest-portal/grant-token.ts:41,44,47,65-79`.

**MEASURED.** I enumerated every mint and issuance call site in non-test source:

```
grep -rn "mintGuestToken(\|mintExchangeToken(\|mintPortalToken(\|issueGuestSession(\|\
rotateGuestSession(\|mintPostCheckoutGrant(\|mintExchangeGrant(\|\
exchangeMagicLinkToken(\|issueGuestActor(" --include=*.ts . | grep -v __tests__
```

Eight production sites, all accounted for: two credential-setting helpers
(`setGuestCredential`, `setPortalCredential`) and one URL composition
(`services/guest-portal/message.service.ts:517-523`) which places the token in a
**fragment** (`services/guest-portal/templates.ts:515`).

**No pepper — is that still the right call? Yes, and the reasoning has a
consequence.** The preimage is 256 bits of CSPRNG output, so a plain SHA-256
column is neither invertible nor dictionary-attackable: a dump of
`guest_sessions` or `guest_order_access_grants` yields no usable credential —
which is the property a pepper would be bought to provide and is already held. A
pepper would additionally make every stored hash unverifiable the day it rotated.
**INFERRED:** the decision is correct, and the argument is precisely what does
*not* transfer to `guest_checkouts.email_hash`, whose preimage has
dictionary-scale entropy. That one *is* keyed — and its missing key version is
M8-06.

`token_hash` is nonetheless in `PROTECTED_COLUMNS`
(`db/protectedColumns.ts:237`), because an irreversible digest handed to a client
is still an offline oracle to test guesses against. **MEASURED** present.

**The accept decision is constant-time on the portal side.**
`portalTokenMatches` (`grant-token.ts:114-116`) re-decides with `verifySecret`
after the indexed lookup narrows. `guest-session.service.ts` compares by index
equality alone. **INFERRED:** the asymmetry is defensible — a 256-bit-preimage
digest offers no secret-dependent branch worth riding — but the two modules now
differ in posture and only one explains itself. Not a finding; noted so nobody
"tidies" the portal's extra comparison away.

**Rotation and the 60-second grace.** `rotateGuestSessionToken`
(`db/guests/guestSessionRepository.ts:137-158`) is one conditional
`UPDATE … WHERE token_hash = <current> AND revoked_at IS NULL RETURNING`, so two
concurrent rotations mint exactly one credential and the loser's token still
resolves through the parked hash. The grace predicate is a real inequality
against the passed clock — `previous_token_hash = $1 AND previous_token_expires_at > now`
(`:77-85`). **MEASURED.** The 7-day rotation never fires on a grace-window match
(`middleware/commerce-actor.ts:380`), which is correct: rotating a token already
being replaced would burn the grace.

**Revocation.** `revokeGuestSession` (`guestSessionRepository.ts:165-176`) and
`revokePortalGrant` (`services/guest-portal/grant.service.ts:430-434`) are
idempotent CAS forms. A claim revokes **every** outstanding portal credential for
its group including the presenting one; "secure my access" spares the presenting
one (`grant.service.ts:410-427`). **MEASURED** through the realdb suite, whose
log output shows `revokedGrantIds` on a claim.

**Expiry.** `guest_sessions.expires_at` is the stored 90-day absolute deadline;
idle expiry is enforced in the resolver (`guest-session.service.ts:107-125`),
not as a column. Portal grants do not slide at all — `resolvePortalGrant` touches
`last_used_at` for audit and the expiry is absolute
(`grant.service.ts:367-399`). **MEASURED.** The retention consequence of the
first is M8-12.

#### The load-bearing claim: plaintext exists in exactly two response carriages

ADR 0003 D3 and `AGENTS.md` assert the plaintext token exists only in
`Set-Cookie` or the `X-Mercaria-Guest-Token` / `X-Mercaria-Portal-Token`
response header — "NEVER a response body, log line, URL or analytics event".

**MEASURED, with a positive control.** I wrote a scanner (session scratchpad,
not committed) that: enumerates tracked TypeScript under `packages/backend/src`
and `packages/frontend`, excluding tests; strips block comments, line comments
and string/template literals, so a docblock explaining the prohibition cannot
inflate the count; builds **two** views of each file — line-by-line and
statement-joined — so a multi-line call cannot hide from a line-anchored regex;
and flags any unit where a token-bearing identifier (`token`, `portalToken`,
`exchangeToken`, `presented`, `credential.token`, `rotated.token`,
`result.credential.token`, `plaintext`) is an argument to `sendSuccess` /
`res.json` / `res.send` / `sendError`, a `log.*` structured field, a `console.*`
call, a `URLSearchParams.set` or an interpolated query string, or
`emitAnalyticsEvent` / `recordAnalyticsEvent`.

```
POSITIVE CONTROL: detectors fired = analytics, console, log_line, response_body, url_query
FILES SCANNED: 1616
FILES CONTAINING A TOKEN-BEARING IDENTIFIER (code, comments stripped): 73
HITS: 0
```

The positive control is a synthetic module exercising all five forbidden shapes,
including a **multi-line** `sendSuccess(res, { token }, 201)` to prove the
statement view works. The scan exits non-zero if any detector fails to fire on
it, if fewer than 500 files are scanned, or if fewer than 10 files carry a token
identifier after stripping — which would mean the stripper had eaten the code.
All three floors passed.

**Second, empirical.** The 94 real-database tests emitted 361 lines of structured
log covering issuance, rotation, revocation, exchange, claim and operator
revocation:

```
grep -c "guestSessionId\|grantId\|checkoutGroupId"        → 52   (positive control: the grep can see content)
grep -c "mg[sxp]_[A-Za-z0-9_-]\{43\}"                     → 0    (no plaintext token)
grep -cE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" → 0    (no email address)
grep -cE "\b[0-9a-f]{64}\b"                               → 0    (no SHA-256 / HMAC digest)
```

**INFERRED:** the claim holds for every path these tests exercise, and the static
scan extends it across both packages. What neither covers is a credential
reaching a log through a third-party library's own logging, or through an
exception message composed elsewhere — I found no mechanism for either and I did
not measure either.

**M8-11 is the one gap in this family.** `packages/frontend/app/(app)/guest-orders/portal.tsx:94`
reads `takeTokenFromFragment() ?? params.token ?? null`. The fragment path
captures then strips with `history.replaceState` (`portal.tsx:69-79`, and the
order of those two statements is correct and commented as such). The
**query-parameter** path does neither: `params.token` is never removed. A
fragment is never sent to a server and never appears in `Referer`; a query string
is in both, plus browser history and the Cloudflare Worker's access log.
**MEASURED** that nothing in either package composes a `?token=` portal link, so
the path is latent. **INFERRED** that it is reachable by anything that rewrites a
link. The backend is clean: the exchange reads `req.body` only
(`routes/guest-orders.ts:172`).

### 4B. Transport, the `__Host-` cookie, CSRF, and the dev downgrade

**The cookie.** Production is `__Host-mercaria_guest` / `__Host-mercaria_portal`,
`HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`
(`middleware/commerce-actor.ts:140-165`, `middleware/guest-portal.ts:66-90`).
The `__Host-` prefix is what closes T1's subdomain-shadowing path. **MEASURED**
that both profiles are constructed identically.

**Is the dev downgrade still explicit and logged? Yes.** **MEASURED** at
`middleware/commerce-actor.ts:167-180` and `middleware/guest-portal.ts:92-105`:
the dev profile uses a **different cookie name** (`mercaria_guest_dev`,
`mercaria_portal_dev`) rather than the same name with a weaker flag, and logs
once per process at first use. That is the right shape — a differently-named
cookie cannot be mistaken for the production one, and the log makes the downgrade
observable rather than silent.

**M8-15** is the caveat. The switch is `process.env.NODE_ENV === 'production'` in
both files. **MEASURED** that `Dockerfile:110` sets `ENV NODE_ENV=production`, so
the deployed image is correct today, and that nothing asserts it at boot.
**MEASURED** that the same variable decides `config.orders.mockPayEnabled`
(`config/index.ts:3908-3909`: `false` in production, and
`boolEnv('MOCK_PAY_ENABLED', true)` otherwise — i.e. defaulting **on**) and
`AUTH_DEBUG` (`middleware/auth.ts:60`). **INFERRED:** one unset variable
simultaneously downgrades both guest cookies, enables the mock payment rail and
turns on auth debug logging. A boot assertion is cheap and the blast radius is
not.

**CSRF (D10).** Strict `Origin`, else the `Referer`'s origin, checked against
`isAllowedBrowserOrigin`, applied to every cookie-carried state-changing request
**and** to cookie-transport issuance and the exchange
(`middleware/commerce-actor.ts:244-262,334-340,450-452`;
`middleware/guest-portal.ts:155-169,228-234`; `routes/guest-orders.ts:182,246`).
Neither header present is a refusal. **MEASURED** at each call site, and
**MEASURED** that the check runs *before* resolution, so a cross-site write never
reaches the database.

**Header transport is correctly exempt and cannot be abused to skip the gate.**
`issueGuestActor` derives transport from `headerValue(req, GUEST_TRANSPORT_HEADER)`
(`middleware/commerce-actor.ts:447-448`); a cross-site attacker cannot attach a
custom header without a preflight the CORS layer answers, so a simple cross-site
form POST always lands on the `cookie` branch and is checked. **INFERRED**, and
it holds.

**M8-05 is the finding.** `packages/backend/src/lib/allowed-origins.ts:51-55`:

```ts
export const ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  ...(process.env.WEB_URL ? [process.env.WEB_URL] : []),
  ...PRODUCTION_ORIGINS,
  ...DEV_ORIGINS,
]);
```

`DEV_ORIGINS` (`:33-45`) is eleven entries including `http://localhost:5173`
(Vite's default port), `http://localhost:8160-8162`, `exp://localhost:*` and
`http://10.0.2.2:*`, included **unconditionally** — there is no `NODE_ENV` guard.
The same frozen list is the CORS origin allow-list in `app.ts:138-152`, with
`credentials: true`. **MEASURED.**

**INFERRED, with its limit stated:** the concrete cookie-CSRF attack from
`http://localhost:5173` is blocked today by `SameSite=Lax`, which withholds the
cookie from a cross-site `fetch`. This is therefore not a live exploit. It is a
finding because D10 says in as many words that Origin verification is *the
control* and `SameSite=Lax` is *defence in depth* — and here that relationship is
inverted for eleven origins in production. The fix is one line: gate
`DEV_ORIGINS` on `process.env.NODE_ENV !== 'production'`. I did **not** make it:
it changes the CORS surface of the whole API rather than the guest domain, which
is the owner's call, not a reviewer's.

Two smaller notes on the same file, both **MEASURED**: `WEB_URL` is prepended
with no validation of any kind, and `packages/backend/.env.example:28` ships
`WEB_URL=http://localhost:8160`, which an operator copying the example into a
production environment would carry across. It adds nothing today only because
`DEV_ORIGINS` already contains that value.

### 4C. Scope containment

**I1 — a guest id can never be an Oxy id.** `CommerceActor` has no common `id`
field (`services/commerce-actor.ts`), and every translation is a total `switch`:
`cartOwnerForActor` (`services/cart-owner.ts:33-44`), `addressBookOwnerForActor`
(`services/checkout/destination.ts`), `orderAccessSubjectForCommerceActor`
(`services/orders/order-access.service.ts:166-181`). **MEASURED** — no
fallthrough in any of them.

**I3 — a cart token can never become order access.** Two mechanisms, both
properties of the call graph rather than of a predicate:

- `orderAccessSubjectForCommerceActor` maps a `guest` actor to `null`
  (`order-access.service.ts:172-177`). **MEASURED.**
- The portal resolver is a *second* resolver with its own anchored token
  patterns, so an `mgs_` token fails its shape gate before any hashing
  (`grant-token.ts:53-54,88-106`). **MEASURED** — there is no shared
  "read any token" helper for a caller to reach for.

The one path that looks like an exception is `POST /guest/orders/confirmation`,
which does read a live guest session (`routes/guest-orders.ts:229-268`). It is
not one: the session is a precondition for minting a **separate, narrower,
separately revocable** `post_checkout` grant over one group, and the database
refuses to let that grant become more —
`guest_order_access_grants_verification_origin_check` forbids a verification
instant on a `post_checkout` row and
`guest_order_access_grants_unverified_scope_check` holds an unverified portal row
to `tracking:read` (`db/schema/guestPortal.ts:258-278`). **MEASURED** both CHECKs
in the schema and **MEASURED** that they hold on a real server via
`guest-portal.realdb.test.ts`.

**A portal credential authorizes exactly one checkout group.** Every grant row
carries `checkout_group_id` and every portal read scopes through it
(`routes/guest-orders.ts:601-643`;
`services/orders/guest-order-portal.service.ts:132-157`). **MEASURED** that no
type, repository signature or route in the domain can express "every order for
this address" — the shape does not exist, so the request is unrepresentable
rather than refused.

**I4/I6 — the claim conjunction.** `claimGuestCheckoutGroup`'s input type is
`{ grant, oxyUserId, presentedGuestSessionId?, now }`
(`services/guest-claims/claim.service.ts:143-157`). **MEASURED:** there is no
parameter for an email, an order number, a card, a wallet, a merchant message or
an operator-typed account id — #109's nine "insufficient by themselves" rules
fall out of the parameter list rather than out of branches. `refusalFromProofs`
(`:160-172`) additionally requires the `claim:write` scope and a non-null
`email_verified_at`, and the two schema CHECKs above make a paying device
structurally incapable of holding either.

**MEASURED** that the claim stamp has exactly one writer,
`stampCheckoutGroupClaim`, reached only from `claim.service.ts:370`; and
**MEASURED** the whole operator route set
(`routes/internal-guest-commerce.ts:73-147`, fourteen routes) — there is no
"claim this group for account X" and no "move it to another account". Revocation
is a three-step, two-operator flow (`:110-112`). Listing what *is* there is what
makes "I found no such route" distinguishable from "I did not look".

**I7 — origin survives a claim.** `orders.buyer_origin` is immutable by trigger
and the claim pair moves NULL→value or value→NULL but never value→value
(`db/schema/orders.ts:389-420` for the identity CHECK). **MEASURED** the CHECK;
**READ** the trigger's stated behaviour; **MEASURED** its effect through
`guest-claim.realdb.test.ts`.

**The seller projection.** `MerchantOrder` is
`Omit<Order, 'buyer' | 'buyerOxyUserId' | 'buyerContact'>`
(`packages/shared-types/src/order.ts:477`) — a real `Omit` of three real fields,
not the `Omit<T, never>` shape #110 found and deleted. **MEASURED** that it is
actually applied on the merchant read paths
(`services/order.service.ts:442,456,572,595`;
`services/order-hydration.service.ts:632`), which is the half that would
otherwise be a type nobody uses.

### 4D. Provider identity (ADR 0006 / T13)

**MEASURED.** `services/payments/guest-correlation.ts:57-65` selects exactly one
column — `guest_checkouts.id` — and the file has no write path. The select list
*is* the boundary: adding `emailCiphertext` to it would be a visible diff in a
file whose only purpose is that it cannot carry one.

`buildPaymentMetadata` (`services/payments/checkout-payment.service.ts:375-384`)
composes `{ paymentId, checkoutGroupId, guestCheckoutId?, orderCount, orderIds? }`
and runs `assertPaymentMetadataKeys` (`:392-407`), which THROWS on a key outside
`PAYMENT_METADATA_KEYS` and, separately, on any key whose lowercased form
contains a forbidden substring. **MEASURED** the composition and both gates.

**INFERRED, and it is the T13 question:** `guestCheckoutId` is `UNIQUE` per
checkout group, so one person's three guest purchases carry three different ids
into Stripe. No value in provider metadata correlates two of a guest's
checkouts, and nothing in the metadata authorizes anything on Mercaria's side.

**Stated limit, deliberately.** The metadata gate checks key *names* only, not
values. The values here are composed from server-minted ids so this is not a live
gap, but a future key carrying a caller-supplied string would pass it. I did
**not** trace `services/payments/redact.ts` or the full `PAYMENT_METADATA_KEYS`
tuple, so this section must not be read as "the payment metadata surface is
verified clean" — it verifies the guest composition path and nothing wider.

### 4E. Retention, erasure and PII — the half that does not run

This is where the review's Highs are. The design is good; the execution is
largely absent, and several mechanisms that look like they would have caught
that are green and inert.

#### The crypto is sound

AES-256-GCM, 96-bit random IV per call, key-id-prefixed self-describing value
(`lib/guest-pii.ts:92-103`). Keys are validated on first use and an unset key
**throws** rather than falling back to plaintext (`:65-77`). `guestEmailHash`
(`:143-146`) is HMAC-SHA-256 under a key separate from the encryption key and
takes an **already-normalized** address, so the normalization policy lives in one
place. **MEASURED.**

**MEASURED** that `decryptGuestPii` has exactly one production caller — the
transactional-mail send path (`services/guest-portal/message.service.ts:408`) —
so "who can read a guest's email" is answerable by grepping one function name, as
the docblock claims. **MEASURED** that the ciphertexts and every sibling digest
are registered in `PROTECTED_COLUMNS`: `guest_checkouts` (`:171`),
`guest_contact_suppressions.emailHash` (`:248`),
`guest_recovery_attempts.subjectHash` (`:260`),
`guest_abuse_counters`/`guest_abuse_interventions.subjectHash` (`:450-451`),
`guest_order_access_grants.tokenHash` (`:237`).

#### M8-01 — the erasure path erases nothing and would report success

**MEASURED.** `requestGuestData`
(`services/guest-governance/data-request.service.ts:78-153`) has **zero
callers**:

```
grep -rn "requestGuestData" --include=*.ts .
# → only its own declaration (:78) and its own docblock (:7). Nothing else, tests included.
```

No route in `routes/` files an export or a deletion. Relayed and consistent with
what I read: `grep -n "\.update(\|\.delete(\|minimize\|revoke"` over that file
returns no matches — it performs no mutation of any kind. Yet
`composeDispositions` (`:199-203`) returns
`affectedRowCount: alreadyAnonymized ? 0 : 1`.

**INFERRED, and this is the sentence to carry:** *being unreachable is currently
the only thing preventing a false erasure receipt.* Wire this endpoint up as it
stands and Mercaria answers a data-subject erasure request with a per-class
report claiming a row was affected, having changed nothing. That is worse than
having no erasure path at all, because the second is a gap somebody notices and
the first is a gap that documents itself as closed.

ADR 0003 D15 states a post-payment erasure regime — revoke sessions and grants,
delete the guest cart, anonymize the contact — as a commitment. **There is no
path by which a buyer or an operator can invoke it.** The operator surface has a
`GET /internal/guest-governance/data-requests/:checkoutGroupId`
(`routes/internal-guest-governance.ts:67`) that lists requests, and nothing that
creates or executes one. **MEASURED.**

#### M8-02 — no scheduled minimization loop, and the config says otherwise

**MEASURED.**

```
grep -rn "retentionJobEnabled\|GUEST_RETENTION_JOB_ENABLED\|retentionPollIntervalMs" --include=*.ts .
# → config/index.ts:1469 (a comment), :1494-1495 and :1499 (the interface),
#   :4094 and :4096 (the assignment). NO READER ANYWHERE.
```

```
grep -c "start[A-Z][A-Za-z]*(" src/index.ts        → 38 dispatcher starts
grep -n "etention" src/index.ts                    → only startAnalyticsRetention (:646)
                                                      and comments; no guest retention loop
```

So `GUEST_RETENTION_JOB_ENABLED` defaults `true`, is declared as "gates the LOOP
only", and gates nothing, because the loop does not exist. **READ:** the operator
controller's docblock (`controllers/guest-governance.controller.ts:146`) says the
route "drives the SAME function the scheduled loop drives", and
`minimizationClasses()` is exported "so the scheduler and the tests agree"
(`services/guest-governance/retention.service.ts:82-84`) — **MEASURED** that its
only callers are the operator controller (`:68,144,159`). The scheduler those two
comments name does not exist.

**What DOES run.** `startExpirySweeper()` is started (`src/index.ts:618`) and the
`expiry_sweep` classes are hard DELETEs it performs. **MEASURED.** So the
retention picture is:

| Mechanism | Classes | Runs? |
|---|---|---|
| `expiry_sweep` | 9 of 13 inventory records | **Yes** — `startExpirySweeper()`, `src/index.ts:618` |
| `minimization_job` | 3 of 13 records declare it; `MINIMIZATION_CLASSES` has **2** (`retention.service.ts:77-80`) | **No scheduler.** Operator-triggered only, and see below |
| `none` | 1 | n/a |

**MEASURED** the counts: `grep -c "mechanism: 'minimization_job'"` → 3;
`grep -c "mechanism: '"` → 13; `MINIMIZATION_CLASSES` = `['unpaid_pending_checkout',
'plaintext_equivalent_contact']`.

**And the operator-triggered pass is a no-op by default.**
`GUEST_RETENTION_DRY_RUN` defaults `true` (`config/index.ts:4097`) and
`runRetentionPass` reads it at `retention.service.ts:110`, taking the `dry_run`
branch (`:145-153`) which increments a counter and continues without calling
`minimizeGuestContact`. **MEASURED.** So the two contact-minimization classes are
both callerless *and* dry-run — which makes the flag moot rather than
protective, and is worth stating plainly so nobody "fixes" retention by flipping
it.

**INFERRED:** ADR 0003 D11's contact-minimization commitment and D15's
anonymization are, on a default deployment, unexecuted. The session/cart/grant
expiry half of D11 does run.

#### M8-03 and M8-13 — the abuse control is off, and its docblock denies the consequence

**MEASURED.** `GUEST_ABUSE_CONTROLS_ENABLED` defaults `false`
(`config/index.ts:246`, `:4092`, via `resolveGuestAbuseControlsEnabled`), and
with it off `checkGuestAbuse` returns `{ outcome: 'permitted' }` at
`services/guest-governance/abuse.service.ts:81` — **before**
`countAbuseAttempt` at `:104`. **READ:** the module docblock (`:22-27`) says the
flag gates whether FRICTION is applied and that the counters still run, so
turning controls back on "does not start from zero". With the flag off — the
default — nothing is counted and it *does* start from zero. That is a docblock
stating the opposite of the code it sits on.

**MEASURED** the residual bound on issuance:

- `POST /guest/session` carries `makeRateLimiter('guest-issue')`
  (`routes/guest-session.ts:205`) with no options, so it resolves to the SDK's
  `anonymousMax = 600` per 15 minutes, keyed on a hashed IP
  (`node_modules/@oxyhq/core/dist/cjs/server/rateLimit.js:159`).
- `POST /cart/items` — which is the *real* issuance path since #104
  (`controllers/cart.controller.ts:135` calls `issueGuestActor`) — carries
  `makeActorRateLimiter('cart')` (`routes/cart.ts:66`), **not** the dedicated
  bucket, and for an anonymous caller that is also 600 per 15 minutes per IP.

**INFERRED:** a single address may mint on the order of 1,200 guest sessions per
15 minutes across the two routes, with no durable counter recording that it did,
and multiplied by the running task count if `REDIS_URL` is unset (§5). ADR 0003
D3 calls lazy issuance plus the per-IP limit "the primary anti-farming control
(T10)"; the code's intended primary control is `checkGuestAbuse`, and it is
switched off.

**M8-13, relayed and consistent with what I read:** `checkGuestAbuse` has exactly
one non-test call site (`middleware/commerce-actor.ts:465`, scope
`session_issuance`). Four of the six declared abuse policies have no caller,
including `recovery_spraying`, which carries a rationale about not rebuilding the
enumeration oracle and does not execute.

#### M8-04 — nothing could have caught M8-02 or M8-03

This is the finding that makes the three above durable rather than accidental,
and each of its three parts was re-measured because the first characterisation I
was given was close but not exact.

- **The lever-coverage gate runs in ONE direction, and the unread levers are
  outside its input.** `services/__tests__/guest-governance-isolation.test.ts:250-274`
  reads `config/index.ts` and asserts `configSource.includes(lever)` for every
  lever named by `GUEST_FEATURE_GATE_REGISTER`. **MEASURED:** it has a real
  vacuity floor (`configSource.length > 10_000` plus a known-present example), so
  it is not measuring nothing — but the floor proves the *file was read*, not
  that the lever has a *reader*, and the failure message it would print is
  literally "`${lever}` is named by a gate and read by nothing", which is the one
  claim `includes` cannot make. **MEASURED, and this is the sharper half:**
  `GUEST_RETENTION_JOB_ENABLED` and `GUEST_ABUSE_CONTROLS_ENABLED` are **not in
  the register at all** (`grep -n "GUEST_RETENTION_JOB_ENABLED\|GUEST_ABUSE_CONTROLS_ENABLED"
  packages/shared-types/src/guest-governance.ts` → no matches; the register names
  ten levers, `:1640-1771`). So the gate never looked at either. There is no
  assertion in the other direction — "every guest lever in `config/` is either
  registered or demonstrably read" — and that is the assertion that would have
  fired.
- **The retention-policy gate compares two declared numbers.** `:337-346` is
  `a lookup hash never outlives the value it digests`, and it asserts
  `GUEST_RETENTION_SCHEDULE`'s `lookup_hash.retentionSeconds ===
  plaintext_equivalent_contact.retentionSeconds`. **MEASURED.** That is a real
  and worthwhile *policy* assertion — a hash is not anonymous while it can still
  support lookup — and its limit is exactly M8-02: neither number is enforced by
  anything that runs, and `lookup_hash` additionally declares a mechanism no job
  implements (M8-09). A schedule two classes agree on and nobody executes passes
  this test forever.
- **The data-inventory census checks against a hand-maintained list carrying the
  same error.** **MEASURED:** `db/__tests__/guest-data-inventory-census.test.ts`
  passes (10 tests) and its expected-table list at `:48-60` **itself contains**
  `guest_contact_routing` — a table that does not exist in `db/schema/` (`grep`
  over the whole schema directory returns nothing). So the phantom entry is in
  the inventory *and* in the list the inventory is checked against, and the
  census agrees with itself. `db/guestPortal/contactRoutingRepository.ts` imports
  `guestCheckouts` — routing is a query over an existing table, not a table.

**INFERRED:** three gates in this domain are green, and none of them measures
whether the mechanism it names executes. Two assertions would each have failed
the build today: *every guest lever declared in `config/` has a reader outside
`config/`*, and *every retention class declaring `minimization_job` appears in
`MINIMIZATION_CLASSES`*. A third — deriving the census's expected table set from
the drizzle barrel rather than from a hand-written list — would have caught the
phantom.

#### M8-08, M8-09, M8-10 — what erasure would not reach even if it ran

- **M8-08 (relayed, exemption re-measured).**
  `guest_contact_suppressions.email_hash` is the same HMAC, under the same key,
  over the same preimage as `guest_checkouts.email_hash` — so it is the same
  exact-match oracle. `minimizeGuestContact` touches only `guest_checkouts`, and
  the governance domain never references the suppression table. **MEASURED** that
  it is deliberately unswept: `db/expiryTargets.ts:443-448` names it and
  `guest_portal_operator_actions` as the two of #108's five tables that are never
  swept, **for good reasons** — a suppression is a person's standing request to
  stop receiving mail and does not expire because they waited, and an audit of
  what staff did on a buyer's behalf with a retention shorter than the record it
  is about "answers the only question it exists for with silence". This is a
  genuine conflict between two correct commitments and needs a decision, not a
  deletion.
- **M8-09 (relayed, re-measured).** The registries disagree with each other and
  with the schema. **MEASURED:** the `lookup_hash` class declares
  `minimization_job` (`packages/shared-types/src/guest-governance.ts:1284-1288`)
  and is **not** in `MINIMIZATION_CLASSES`, so `runRetentionPass` refuses it with
  `mechanism_not_minimization` (`retention.service.ts:99-102`) and nothing else
  performs it — three records declare that mechanism and the implementing list
  has two. **MEASURED:** `GUEST_DATA_INVENTORY:1037` names
  `guest_contact_routing` in a record's `tables`, and no such table exists in
  `db/schema/`. **Relayed:** `guest_contact_suppressions` is assigned to
  `expiry_sweep` by the inventory and is not in the sweep — which
  `expiryTargets.ts:443-448` states as a deliberate exemption, so the two
  registries describe the same table two incompatible ways.
- **M8-10 (relayed).** `purchase_orders.destination_*` is a second full postal
  address — nine columns via `...addressColumns('destination')`
  (`db/schema/procurement.ts:901`) carrying recipient name, street, city, postal
  code and phone. The domain's docblock says payloads are "redacted by SHAPE",
  which is the narrower claim that no *email* column exists. **The relayed
  method matters and is worth repeating**: a name-based grep does not find this;
  `grep -rn "\.\.\.addressColumns(\|\.\.\.optionalAddressColumns("` does.

#### M8-06 and M8-07 — key management

- **M8-06. MEASURED:** `email_hash` carries no key id — the column is a bare hex
  digest, `guestEmailHash` emits no prefix (`lib/guest-pii.ts:143-146`), and
  `grep -n "GUEST_EMAIL_HASH_KEY" config/index.ts` returns `:214` and `:4043`
  only, so there is no second key. **INFERRED:** rotating that key makes every
  stored `email_hash` unmatchable, and the failure is silent in the worst
  possible way — `POST /guest/orders/recover` answers 202 with one fixed sentence
  whether or not anything matched, by design, to close T5. A rotation would leave
  every existing guest order permanently unrecoverable with no error and no
  symptom a monitor could see. This is not a reason to weaken the 202; it is a
  reason the key needs a version column before it is ever rotated.
- **M8-07. MEASURED:** `CURRENT_KEY_ID = 'v1'` is a module constant
  (`lib/guest-pii.ts:62`), `decryptGuestPii` throws on any other id
  (`:119-124`), and config holds one key (`config/index.ts:4042`). **READ:** the
  module docblock says rotation "is re-encryption at read rather than a flag day"
  (`:12-13,57-60`). That path does not exist. The honest options are to implement
  the second key or to correct the comment; I recommend the first, because a
  compromised PII key with no rotation path is an incident with no remedy.

#### M8-12 — the idle window is authorization, not retention

**Relayed, and consistent with what I measured in §4A:** `idleDeadline` exists
only in the resolver (`guest-session.service.ts:107-125`). There is no column, no
index and no sweep predicate for it. **INFERRED:** a session idle from day 1
still resolves as expired at read time — the authorization property holds — but
its row and its cart survive to the absolute deadline plus the sweep's grace,
i.e. day 97. ADR 0003 D11's table presents 30-day idle expiry as a retention
window. It is not one.

#### M8-14 — the `PROTECTED_COLUMNS` detector

**Relayed:** `findImplicitWholeRowReads` cannot see `.returning()`, and four live
bypasses exist on protected guest tables. The audit is explicit that this is a
**gate gap, not a proven disclosure**, and I am reporting it that way: nothing
was shown to reach a client.

#### Verified clean here

**Relayed with its method:** `guest_portal_messages` holds no recipient, no
subject and no body — the full column list was measured. I **MEASURED** the same
independently from `db/schema/guestPortal.ts`: the row carries
`checkoutGroupId`, `guestCheckoutId`, `kind`, `orderId`, `locale`, the lease and
retry columns, and nothing else. The recipient is decrypted at the moment of
sending (`message.service.ts:408`) and the link-bearing message mints its `mgx_`
inside the send path (`:517-523`), so no plaintext token rests in a queue row.

**Not claimed clean, deliberately:** `support_messages` free text was not traced.
Nothing in this review establishes what a buyer may type into one or where it
goes.

### 4F. Rate limiting and enumeration

**Uniform refusals — relayed, confirmed by the audit across five surfaces:**
`POST /guest/orders/recover`, `POST /guest/orders/exchange`, the guest session
resolver, the claim endpoint and `GET /guest/orders/:groupId`. The
403-vs-404 pair on the portal read is **not** a group oracle, because the group
mismatch is tested first.

**MEASURED by me** on the two that matter most:

- Recovery sends `res.status(202)` **before** any work
  (`routes/guest-orders.ts:135`), then emits the analytics event and fires
  `requestGuestOrderRecovery` as a `void` promise with an explicit catch
  (`:142-156`). Nothing is awaited before the response, so timing does not
  distinguish a match from a miss. The only thing a caller can tell apart is a
  syntactically invalid email (400), which is not an existence oracle.
- The exchange answers the same 401 for a malformed token as for an unusable one
  (`routes/guest-orders.ts:172-177`, and the comment states why: "a 400 for a
  malformed one and a 401 for an expired one is a two-value oracle over the token
  space"). **MEASURED.**
- The session resolver's rejection is uniform `null` across malformed, unknown,
  expired, idle-expired, revoked and converted
  (`guest-session.service.ts:146-171`), with the reason category only in the
  structured log.

**Relayed doc corrections (M8-16).** All **three** recovery throttle axes are
durable in Postgres, not two as `AGENTS.md` says; each subject is an HMAC with
the axis in the preimage; the network axis is coarsened to /24 or /64 and a full
IP is never persisted on that path. Separately: the guest-prefixed limiters key
per **hashed IP**, not per guest session — only the six `makeActorRateLimiter`
scopes key per session — and three incompatible IP coarsenings coexist across
layers.

**Order numbers.** T6 treats them as public and they are never an access factor:
the recovery endpoint uses `orderNumber` as a narrowing hint only, and the portal
authorizes by grant scope. **MEASURED** through the claim and order-access
signatures, which take no order number at all.

**The issuance bound is M8-03.**

### 4G. The analytics boundary (I12)

**MEASURED by me.** The `analytics_events` column list, extracted from
`db/schema/analytics.ts`, is 42 columns:

```
id envelopeVersion eventType eventClass occurredAt receivedAt actorKind oxyUserId
pseudonymousSessionId pseudonymEpoch checkoutGroupId orderId clientSurface appVersion
market queryEventId listingId productVariantId canonicalProductId canonicalVariantId
offerId merchantId storefrontId categoryId storeId searchPolicyVersion
rankingPolicyVersion experimentKey experimentVersion experimentVariant trafficClass
consentState collectionMode buyerOrigin paymentMethodCategory reasonCode position
resultCount latencyMs quantity itemCount createdAt expiresAt
```

**MEASURED:** no email, hash, phone, card fingerprint, provider customer, wallet,
IP, user agent, device fingerprint or token column exists — a
case-insensitive grep for those shapes over the whole schema file returns only
comment lines describing the prohibition. The two identity columns are
`oxyUserId` and `pseudonymousSessionId` (plus `pseudonymEpoch`); the rest are
commerce and surface dimensions.

**The salt rotates, and there is no scheduler to fail — which is the right
design.** `currentSalt` (`services/analytics/identity.ts:152-181`) opens the
first epoch **on demand** and rotates lazily when `saltRotationDue` says the
epoch has outlived `config.analytics.pseudonymRotationHours` (`:183-187`). The
retirement clock starts when the epoch **opens**, not when it closes — the
comment at `:166-169` states why, and it is correct: measuring from closure would
turn a 45-day guarantee into a 90-day one. **MEASURED** that the 45-day deletion
is registered at `db/expiryTargets.ts:788` (`analyticsSalt`) and therefore swept
by `startExpirySweeper()`, which **is** started (`src/index.ts:618`). Unlike the
guest retention job, this one runs.

**Identity is server-derived.** `deriveAnalyticsIdentity`
(`identity.ts:198-230`) takes the resolved `CommerceActor`. For a guest it hashes
`actor.guestSessionId`; for an anonymous visitor it hashes a client-supplied
`surfaceSessionId`, and the parameter doc states the reason it is ignored for
every other kind — "preferring a client's would let a client merge two sessions
it does not own". **MEASURED** that `surfaceSessionId` arrives as a
shape-validated header (`services/analytics/request-context.ts:122-124`) and that
no ingest schema accepts `oxyUserId` or `pseudonymousSessionId`. A denied-consent
Oxy actor is recorded with **no** identity rather than with a pseudonym
(`identity.ts:212-217`), which is the right call: hashing an Oxy id into the
pseudonym space would be a stable per-account identifier under another name.

**Collection is off by default and fails closed.** `resolveAnalyticsCollectionMode`
(`config/index.ts:999-1006`) returns `'off'` for unset **and for an unrecognised
value**, and `resolveAnalyticsEnabled` (`:1015-1018`) derives from it so
`ANALYTICS_ENABLED=true` with mode `off` cannot collect. **MEASURED.** The
comment at `:995-998` says this is the one fallback in the file that deliberately
defaults to the restrictive side, and the code matches.

**MEASURED** that the guest emissions carry commerce handles and never a
credential: `guest_session_issued` carries no session id
(`middleware/commerce-actor.ts:506`); `guest_recovery_requested` carries no
checkout group at all (`routes/guest-orders.ts:142`);
`guest_recovery_exchanged` and `guest_claim_completed` carry the checkout group
(`routes/guest-orders.ts:208-213`, `:476-480`). **INFERRED:** `checkoutGroupId`
is I12's permitted "opaque checkout row id", and it is a commerce handle rather
than a person handle — a group belongs to one purchase, not to one buyer.

**Not claimed clean, deliberately.** I did not enumerate every one of the 22
metric definitions to confirm each identity-bearing dimension is named by one,
and I did not trace the redaction rules in
`services/analytics/redact-query.ts`. §4G is a measurement of the schema, the
identity derivation, the salt lifecycle and the guest emissions — not a full
audit of the analytics domain.

### 4H. Flags, levers and rollback

**MEASURED** — every read of a guest lever in non-test source:

| Lever | Default | What it gates | Gates a durable record? |
|---|---|---|---|
| `GUEST_COMMERCE_ENABLED` | `false` (+ requires both keys) | The `/guest/session` **mount** (`app.ts:259-261`) and whether a presented guest credential resolves at all (`middleware/commerce-actor.ts:324`) | No — but with it off an existing session cannot resolve, so its cart is unreachable. Documented "decommission" semantics, not data loss. |
| `GUEST_SESSION_ISSUANCE_ENABLED` | `true` | New sessions only (`guest-session.service.ts:198-199`) | No |
| `GUEST_CART_ENABLED` | `true` | Cart owner resolution (`services/cart-owner.ts:38-40,55`) | No |
| `GUEST_INLINE_DESTINATION_ENABLED` | `true` | Guest checkout destination (`services/checkout/destination.ts:223,253`) | No |
| `GUEST_CLAIM_ENABLED` | `true` | The claim write (`services/guest-claims/claim.service.ts:163`) | No |
| `GUEST_PORTAL_MESSAGE_DELIVERY_ENABLED` | `true` | The dispatcher loop (`services/guest-portal/message.service.ts:628`) | No |
| `GUEST_RETENTION_JOB_ENABLED` | `true` | **Nothing — M8-02** | n/a |
| `GUEST_ABUSE_CONTROLS_ENABLED` | `false` | Friction **and, contrary to its docblock, the counters — M8-03** | No |

**MEASURED** that `/guest/orders` is mounted **unconditionally** (`app.ts:271`),
with the contrast to the line above it stated in code as a decision. That is the
property M8 asks for: pulling `GUEST_COMMERCE_ENABLED` must not strand somebody
who has already paid.

**MEASURED** the one real interaction, documented rather than hidden:
`POST /guest/orders/confirmation` needs a live guest **session**, so with guest
commerce off a paid buyer reaches their order through the emailed link instead —
and there is no outbound mail transport, so that path does not work either (§5).

**MEASURED** that an anonymous actor cannot check out: `cartOwnerForActor`
returns `null` for `anonymous` (`services/cart-owner.ts:41-42`) and `/checkout`
runs on the same resolver (`routes/checkout.ts:50`).

---

## 5. What could not be verified from this repository

Stated rather than glossed. Each of these must be settled before the flag moves.

- **Whether `REDIS_URL` is set on the production task.** If it is not, every rate
  limiter falls back to the SDK's in-memory store (`lib/rate-limit.ts:179-190`
  logs it and continues) and every budget in this document is multiplied by the
  running task count. `.github/workflows/deploy-aws.yml:263` says the secret is
  "unset here" in the sync job, which is evidence about the workflow, not about
  SSM. Both audits and I independently flagged this and none of us could measure
  it.
- **The running ECS task count**, for the same reason.
- **Whether the task definition overrides `NODE_ENV`** (M8-15).
- **Anything about a real browser.** The `SameSite=Lax` reasoning in M8-05, the
  `__Host-` prefix behaviour and the fragment-stripping in M8-11 are arguments
  from specification, not observations.
- **Anything about a real inbox or a real Stripe account.** There is no outbound
  mail transport in this repository at all — #108's registry is empty and every
  attempt fails `transport_unconfigured` — which is separately tracked as the
  `transactional_sender_authenticated` gate
  (`packages/shared-types/src/guest-governance.ts:1845-1849`, with an explicit
  `blockedBy`).

---

## 6. Invariants I1–I12

| # | Verdict | Basis |
|---|---|---|
| I1 | **Holds** | No common `id` on `CommerceActor`; three total switches measured (§4C). |
| I2 | **Holds** | Every authorization path takes a `CommerceActor` or a grant row; the claim signature has no field for an email, card or number (§4C). |
| I3 | **Holds** | Two independent call-graph mechanisms plus two schema CHECKs (§4C). |
| I4 | **Holds** | No endpoint accepts the pair; `orderNumber` is a hint on a route that always answers 202 (§4F). |
| I5 | **Holds** | 32-byte CSPRNG, hash-only storage, unique indexes, expiry and revocation everywhere, 60 s dual-hash grace (§4A). Key *rotation* is M8-06/M8-07. |
| I6 | **Holds** | One writer of `claimed_by_oxy_user_id`; no path joins orders to Oxy accounts via `email_hash` (§4C). |
| I7 | **Holds** | Immutability trigger plus the identity CHECK; value→value refused (§4C). |
| I8 | **Holds** | The migration is additive. **READ** from the chain, not independently re-derived. |
| I9 | **Holds** | One `checkout.service`, one `cart.service`, no guest fork; the two isolation suites are green (§3). |
| I10 | **Holds** | Unchanged from ADR 0001/#48; §4D. |
| I11 | **Holds** | The seller projection has no field to correlate by, and is applied (§4C). |
| I12 | **Holds for the event schema and the identity model** (§4G); the metric-definition census and the query-redaction rules were not audited. |

## 7. Threats T1–T16

| # | Verdict | Note |
|---|---|---|
| T1 Session fixation | **Holds** | Server-issued only; `__Host-` forbids `Domain`; sign-in revokes rather than upgrades. |
| T2 Cookie theft/replay | **Holds, with M8-15** | `HttpOnly; Secure; __Host-`; expiry and rotation measured; the profile hangs off `NODE_ENV`. |
| T3 CSRF | **Weakened — M8-05** | Correct in shape; the allow-list admits eleven dev origins in production. |
| T4 Magic-link leakage | **Weakened — M8-11** | Fragment carriage is correct server-side and on the fragment path; the query fallback is not. |
| T5 Email enumeration | **Holds** | 202 before any work; uniform refusals across five surfaces; three durable throttle axes (§4F). |
| T6 Order-number guessing | **Holds** | Never an access factor; the claim and order-access signatures take no order number. |
| T7 Cross-tenant order access | **Holds** | Grants scope to one group; every portal read joins through it (§4C). |
| T8 Duplicate checkout/replay | **Holds** | Unchanged four-layer stack; guests run the same code (I9). |
| T9 Cart-merge amplification | **Holds** | `cart-merge-isolation` green; #104's locks and SQL clamp re-measured only as green tests. |
| T10 Session farming | **Broken by default — M8-03** | The intended control is off and writes no counter. |
| T11 Shared email addresses | **Holds as designed** | The irreducible magic-link residual, bounded by grant expiry and "secure my access". |
| T12 Recycled addresses | **Weakened — M8-02** | Bounded by retention, which is longer than stated and, for contact, unexecuted. |
| T13 Card/customer grouping | **Holds** | §4D, within the stated limit. |
| T14 Deep-link interception | **Not verified** | No signed app build exists; nothing here could be measured. |
| T15 Support-agent overreach | **Holds** | `redactEmail` is the display form; one decrypt caller; operator actions audited (§4E). |
| T16 Seller misuse of contact | **Holds** | §4C. |

---

## 8. Sign-off

This section is deliberately **unsigned**. The analysis above is mine; accepting
the risk is not mine to accept, and a reviewer who signs their own review has
produced nothing.

**What the accepter would be accepting, if they signed as things stand today:**

1. **M8-01 (High).** That Mercaria has no working data-subject erasure path for
   guest contact, and that the code written for one would answer a request with a
   report claiming rows were affected, having changed nothing — so the first time
   it is routed, it lies.
2. **M8-02 (High).** That no scheduled process minimizes guest contact; that
   `GUEST_RETENTION_JOB_ENABLED` and its poll interval are configuration that
   reads nothing; that the operator-triggered pass is a dry run by default; and
   that one declared retention class has no implementing mechanism at all.
   Session, cart and grant expiry **do** run.
3. **M8-03 (High).** That guest-session issuance is bounded only by two
   600-per-15-minute per-IP buckets, that the abuse control ADR 0003 T10 names is
   off, and that with it off **no counter is written** — so enabling it later
   starts from zero, which its own docblock denies.
4. **M8-04 (High).** That nothing in this domain's test suite could have caught
   the three above: the lever-coverage gate runs register→config only and the two
   unread levers are not in the register; the retention gate compares two declared
   numbers neither of which is enforced; and the data-inventory census is checked
   against a hand-maintained list carrying the same phantom entry the inventory
   does.
5. **M8-05 (Medium).** That eleven development origins are CORS- and
   CSRF-allow-listed in production, so D10's stated control is inverted for them
   and `SameSite=Lax` carries the load.
6. **M8-06 (Medium).** That `GUEST_EMAIL_HASH_KEY` has no version column, so a
   rotation would silently and permanently break order recovery for every
   existing guest purchase, with no observable symptom.
7. **M8-07 (Medium).** That `GUEST_PII_ENCRYPTION_KEY` has no rotation path, so a
   key compromise has no remedy short of a code change and a backfill — and that
   the code currently claims otherwise.
8. **M8-08 (Medium).** That a keyed digest of a guest's email address survives
   erasure indefinitely in `guest_contact_suppressions`, for a reason that is
   itself legitimate.
9. **M8-09 (Medium).** That the governance registries disagree with each other
   and with the schema, including an inventory entry for a table that does not
   exist.
10. **M8-10 (Medium).** That `purchase_orders.destination_*` holds a second full
    postal address of a buyer that no erasure path reaches and ADR 0003 D15 does
    not anticipate.
11. **M8-11 (Medium).** That the storefront will accept and will not strip an
    exchange token presented as a query parameter.
12. **M8-12 through M8-16 (Low / Informational)**, as listed in §2.
13. **The unverifiable items in §5**, above all that `REDIS_URL` is set on the
    production task — without which every rate limit in this document is
    multiplied by the running task count.

**Recommendation.** Do not set `GUEST_COMMERCE_ENABLED=true` in a non-test
environment until M8-01, M8-02, M8-03 and M8-04 are closed, M8-05 and M8-11 are
fixed, and the `REDIS_URL` question is answered against the live task definition.
M8-06 through M8-10 may reasonably be accepted as residual risk with a dated
plan; the four Highs may not, because each defeats a control this ADR states as
a launch condition, and M8-01 does so while reporting success.

The cheapest honest interpretation of M8-04 is worth saying separately: this
domain's tests are unusually good at proving that walls exist and were not built
to prove that engines run. Two assertions — "every declared lever has a reader
outside `config/`" and "every class declaring a mechanism appears in that
mechanism's implementing list" — would have failed the build today and are the
right first fix.

```
Security reviewer      ____________________   date ____________
Privacy reviewer       ____________________   date ____________
Accepting owner        ____________________   date ____________

Gates this signature would satisfy in GUEST_LAUNCH_GATES:
  [ ] security_review_complete
        criterion: "no unresolved critical or high finding" — NOT MET at c25d3c3
  [ ] privacy_and_retention_review_complete
        note: this gate also unblocks ANALYTICS_COLLECTION_MODE moving off `off`

Residual risks accepted (tick each, or record its closure):
  [ ] M8-01  erasure path unreachable; would report a false receipt      (High)
  [ ] M8-02  no scheduled minimization loop; config declares one         (High)
  [ ] M8-03  abuse control off by default; no counter written            (High)
  [ ] M8-04  no gate could have caught M8-02 or M8-03                    (High)
  [ ] M8-05  development origins allow-listed in production              (Medium)
  [ ] M8-06  email hash key has no version column                        (Medium)
  [ ] M8-07  PII encryption key has no rotation path                     (Medium)
  [ ] M8-08  suppression hash survives erasure                           (Medium)
  [ ] M8-09  governance registries disagree; phantom table               (Medium)
  [ ] M8-10  second postal-address copy on purchase_orders               (Medium)
  [ ] M8-11  exchange token accepted as a query parameter                (Medium)
  [ ] M8-12  idle window is authorization, not retention                 (Low)
  [ ] M8-13  four of six abuse policies have no caller                   (Low)
  [ ] M8-14  .returning() bypasses the PROTECTED_COLUMNS detector        (Low)
  [ ] M8-15  NODE_ENV load-bearing with no boot assertion                (Low)
  [ ] M8-16  documentation drift, three instances                        (Info)
  [ ] §5     REDIS_URL and task count unverified on the production task
```

Record the signature through `POST /internal/guest-governance/rollout/signoffs`
(`packages/backend/src/routes/internal-guest-governance.ts:63`) so the gate
register and this document cannot disagree.
