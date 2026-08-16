# Referral partner enrollment, review and terms (#146 increment 2)

How somebody becomes a Mercaria referral partner: which door they came through,
what they told Mercaria, what a reviewer decided, which terms they accepted, and
— the thing increment 1 could not do — how the tax questionnaire reaches a
caller at all.

Increment 1 (`8f63763`) shipped the tax questionnaire table, the three readiness
derivations and the Stripe payout rail, and left `declareTaxProfile` complete and
**unmounted**, for one stated reason:

> which Oxy account may declare for a `store` partner is the `store:manage`
> question #85 answers, and answering it here would be a second answer

Until that route existed, tax readiness was `pending` for every partner and
`deriveRewardPayability` blocked every batch. **Increment 1 alone could not pay
anybody**; this is what closes that.

Binding decisions: ADR 0005 D2 (enrollment), D15 (the three payout gates), D18
(suspension). The scope split and the withholding ruling are recorded on the
issue itself and are binding: **Mercaria withholds nothing**, issues an annual
earnings statement per partner, and no `tax_withheld` ledger account exists or
may be added.

---

## 1. How the permission question is answered: by NOT answering it

This is the decision the rest of the increment hangs off.

`/admin/stores/:storeId/referral-partner/*` is mounted **under the existing
admin store tree**, so by the time any referral module runs:

- `loadStore` has read the store and the caller's membership, 404ing a store
  that does not exist and 403ing a caller who is not a member;
- `requireStorePermission('store:manage')` has refused anybody without the
  permission.

`req.store.id` is that answer, handed to the shared partner router as its owner.
The `user` half is mounted at `/referral-partner`, where the owner IS
`getRequiredOxyUserId(req)` and there is no question to ask.

That is #85's own two-mount shape (`/admin/stores/:storeId/activation` beside
`/seller/activation/policies`), taken for #85's own reason. The consequence
worth stating: **the referral domain answers the store-permission question in
neither half**. `referral-enrollment-isolation.test.ts` WALL 1 fails the build if
any module in the domain reads a role, a permission array, a membership or
`ROLE_PERMISSIONS`, and it carries a positive control — the store mount must NAME
`requireStorePermission('store:manage')`, or a gate asserting only an absence
would pass just as happily against a surface with no gate at all.

`store:manage` rather than `settings:write`, for the reason payment onboarding
(#46), the fee schedule (#88) and activation (#85) all use it: it is the one
permission an `admin` does not hold, and binding a business into an arrangement
that will pay it money is that kind of act. The partner's display name is also
public-facing, so it is not a settings toggle.

**The owner is a PARAMETER, not sniffed off the request.**
`makeReferralPartnerRouter(resolveOwner)` takes the resolver its mount supplies.
A handler that inferred its owner from whichever field happened to be populated
would be one mount away from reading a store id on a route that never authorized
one.

---

## 2. Standing and submission are two questions with two homes

`referral_partners.state` is the STANDING — what this owner may do right now.
`referral_partner_applications.state` is what happened to one SUBMISSION.

They are not two representations of one fact. A partner whose first application
was rejected and whose second was approved has two application rows and one
standing, and "why was I rejected in March" is a question only the application
can answer. The standing MOVES with the decision, in the same transaction
(`alignPartnerStanding`), through ONE table mapping application state → partner
state, so the two cannot drift.

### The four states added, and the one deliberately not

#146 review rule 1 names eight states. The mapping is worth stating because it is
the one place a ninth would be added by accident:

| #146 says | Mercaria stores | why |
|---|---|---|
| draft | `draft` | NEW |
| submitted | **`applied`** | #142's spelling, on live rows, named by `partner_applied` in the trail. A synonym beside it would be two representations of one fact, with the payout gate's `partnerState !== 'approved'` reading whichever the writer picked. |
| under review | `under_review` | NEW |
| approved | `approved` | — |
| rejected | `rejected` | NEW |
| changes requested | `changes_requested` | NEW |
| suspended | `suspended` | — |
| terminated | `terminated` | — |
| — | `invited` | in neither list and stays: an operator invitation nobody has accepted is a real standing #142 already stores |

Every new state fails `partnerState !== 'approved'`, so all four block attribution
and payout the moment they exist, with no gate to remember to widen.

`draft` puts a partner ROW behind an unsubmitted application. The alternative was
a second owner-keyed table so a draft could exist without a partner, which would
give `referral_partners_owner_key`'s "one record per owner, ever" a rival index
answering the same question. A row is not a grant — a `draft` partner earns
exactly as much as no partner at all.

---

## 3. The application

`referral_partner_applications` is a **working document**, not append-only, and
that is the one place this domain diverges from its two siblings.
`changes_requested` exists precisely so the applicant can EDIT, so an
append-only shape would make the one state requiring a rewrite the one state
forbidding it.

What IS append-only is the DECISION trail
(`referral_partner_application_reviews`), which is where "who decided what, on
which revision" has to stay answerable.

The answers are frozen once they leave the applicant's hands:
`mercaria_referral_application_content_freeze` refuses an UPDATE of any answer
column outside `REFERRAL_APPLICATION_EDITABLE_STATES`. That is #59's rule — the
set an operator approved is the set that executes — and it is what makes
`revision` mean anything: a review row names the revision it READ, so the answers
under that number cannot move afterwards.

**One LIVE application per partner**, by a partial unique over `draft`,
`submitted`, `under_review`, `changes_requested` and `approved`. `rejected` and
`withdrawn` are OUT, which is what makes #146 review rule 5's reconsideration
path a NEW row rather than a rewrite of the refusal — no special case anywhere.

### Where each of #146's ten application items lives

`REFERRAL_APPLICATION_ITEMS` maps all ten, and the census in
`referral-enrollment-isolation.test.ts` asserts each is present exactly once,
that every named column EXISTS on the table it names, and that the three living
outside the enrollment tables each state a reason. A hand-maintained map is only
a gate if being in NEITHER half fails.

| # | item | where | note |
|---|---|---|---|
| 1 | Oxy identity or verified organization | the record's OWNER | copying it here would be the profile mirror ADR 0003 D15 says does not exist |
| 2 | Display name and promotion channels | `referral_partners.display_name` + `promotion_methods` | |
| 3 | Website or profile links | `promotion_urls` | https-only, bounded, **never fetched** |
| 4 | Expected audience and markets | `audience_band` + `markets` | BANDS, not a number — an exact follower count plus a URL identifies an account |
| 5 | Declared promotion methods | `promotion_methods` | |
| 6 | Country and participant type | **`referral_tax_profiles`** | D15 gate 2 already asks exactly this, and #146's own rule says not to collect tax-shaped data in a general profile form |
| 7 | Prohibited-method agreement | `prohibited_methods_acknowledged` | required to submit, by CHECK |
| 8 | Conflicts / related-party | `related_party_disclosure` | biconditional CHECK with its declaration |
| 9 | Program-specific questions | **not collected** | no program publishes any; a question table with no published questions is a surface for content nobody shipped, and a `jsonb` answer bag is how an address reaches production (#77) |
| 10 | Consent to review and communication | `review_consent_at` + `communication_consent_at` | two INSTANTS, separate from each other and from marketing consent |

---

## 4. Review, and the two audiences

`UNIQUE(application_id, revision)` on the trail is #55's `review_round` device: a
revision is decided exactly once, a double-clicked approval converges on the
first row, and a reviewer who asked for changes may decide again only once the
applicant has RE-SUBMITTED — which is the one thing that bumps the revision.

**The convergence has to be reachable, and the first version of it was not.**
`decideApplication` originally checked the application's state before reading the
existing decision, so every retry got a 409 and the `ON CONFLICT` path below it
was dead code — a mechanism green and inert. The real-server suite caught it. The
already-decided read now runs FIRST, and it reads the LATEST application rather
than the LIVE one, because a rejection takes its row out of the live set and a
reviewer retrying one would otherwise be told "no application to decide" while an
identical retry of an approval converged.

#146 review rule 9 — no sensitive risk signal in ordinary rejection copy — is held
three ways:

1. `ReferralApplicationRejectionCode` has no member that could name a risk
   signal, a velocity threshold or another partner;
2. the partner-facing sentence and the reviewer's note are different COLUMNS, and
   `ReferralApplicationPartnerView` has no field the note could arrive in — the
   `MerchantOrder` device, a different TYPE rather than a filtered one;
3. the isolation gate scans the partner projection for the seven values in
   `REFERRAL_APPLICATION_FORBIDDEN_DISCLOSURES`, with the OPERATOR controller as
   its positive control (it DOES read the note, and must — otherwise the
   assertion would pass against a codebase where nobody records one).

The realdb suite walks a REAL emitted projection for the reviewer's note, which
is the half a static scan cannot perform (#92's two-gate rule).

### The decision CHECKs, and their ASYMMETRY

- `decision_code` is a **biconditional** on the state: a refusal names its code,
  an approval carries none.
- `decision_message` is **one-directional**: a message requires a code, and a
  code needs no message.

The first version made the second a biconditional too, and the suite refused
every rejection on its first run. Getting it wrong that way forces a hand-written
sentence onto every refusal — and free text is exactly where a risk signal
actually leaks. **The code IS the message.**

---

## 5. Enrollment modes are a TABLE

`REFERRAL_ENROLLMENT_MODE_RULES` holds every per-mode property; no service asks
"is the mode `staff_test`". #83's `claim-methods.ts` decision, for the same
reason: a service that branches on the mode is one that will branch on it in
three of the four places it matters.

| mode | owners | self-serve | needs review | needs evidence | earns real money |
|---|---|---|---|---|---|
| `open_application` | user, store | ✓ | ✓ | | ✓ |
| `invite_only` | user, store | | | | ✓ |
| `oxy_self_enrollment` | user | ✓ | ✓ | | ✓ |
| `verified_organization` | store | | ✓ | ✓ | ✓ |
| `creator_community_review` | user | ✓ | ✓ | | ✓ |
| `merchant_referral` | store | ✓ | ✓ | | ✓ |
| `staff_test` | user, store | | | | **✗** |
| `operator_legacy` | user, store | | | ✓ | ✓ |

Every column discriminates at least two modes, asserted by a test — a column
answering the same for every mode is a comment.

The mode is supplied ONCE, when the record is created, and every later step reads
it off the row. An applicant cannot re-declare it on submission, which is what
makes `selfServe: false` a real bound rather than a check on the first request.

**Staff/test isolation is at the PAYOUT gate.** `partner_enrollment_is_test` is a
new `ReferralPayoutBlockReason`, read off `earnsProductionRewards` rather than
compared against a mode name. It is deliberately not an attribution refusal:
refusing attribution would make a test enrollment unable to exercise the thing it
exists to test, while the payout gate is the exact point at which real money
would otherwise leave. Both `deriveRewardPayability` composers were forced to
answer it by `tsc`.

---

## 6. Terms

`referral_terms_acceptances`, append-only against UPDATE **and** DELETE. Two
scopes in one table — Mercaria's partner agreement (`program_id` NULL) and a
program version's own terms — tied by a shape CHECK, because "has this partner
accepted everything they owe" must not be a question two tables answer half of.

`acceptance_key` is GENERATED because **Postgres treats NULLs as DISTINCT**: a
plain `UNIQUE(partner_id, scope, program_id, terms_version)` would let two
identical partner-agreement acceptances through (#55's `endpoint_key` finding).
Folding the NULL into a literal makes a re-acceptance an `ON CONFLICT DO NOTHING`
convergence.

- **Acceptance is EXPLICIT and unpreselectable** (rule 9): the request takes a
  VERSION, not a boolean. Sending nothing accepts nothing, so a client rendering
  a pre-ticked box cannot make this server record consent nobody gave.
- **The version is compared** (rule 1): accepting a version that is not the one
  being presented is a refusal, not a silently-recorded yes.
- **Re-acceptance is scheduled by a MATERIAL version** (rule 4).
  `requiresReacceptance` is a property of the VERSION, so a typo fix leaves
  earlier acceptances satisfying the gate.
- **`locale` is required** (rule 3) and CHECK-shaped as a real language tag, so
  an `Accept-Language` header — the commonest wrong value — is refused rather
  than stored unusable.
- **Marketing consent is a different function writing a different column**
  (rule 8), nullable so withdrawal is representable. Accepting terms grants
  nothing about marketing, pinned by a test.
- `referral_partners.terms_version`/`terms_accepted_at` are a PROJECTION of the
  newest partner-agreement acceptance, written by the one function that writes
  that row, in the same transaction (#76's `review_aggregates` relationship). The
  projection refuses to move a newer stamp backwards, so the lock and the
  predicate are independently sufficient.

**Rule 6 — "future attribution may pause until new terms are accepted" — is
available and deliberately NOT wired.** `referral_program_controls.attribution_enabled`
is the lever that already expresses it and #143 owns it; what #146 supplies is
the fact such a decision would read.

---

## 7. Duplicate identities are DERIVED, and detect nothing else

`readDuplicateSignals` computes three kinds at review time, over live rows, never
stored — the `deriveNativeCheckoutEligibility` divergence, because a stored
signal is right on the day it is written and wrong the moment the other partner
is terminated or renamed.

- `display_name_match` — normalized case-fold. The SQL half is a strict SUBSET of
  the JS half (no NFKC, no quote stripping), which is the safe direction: it can
  miss a match a person would spot and cannot invent one.
- `promotion_host_match` — a shared hostname. A FACT, not a verdict: two people
  who both publish on a large platform share one.
- `owner_id_across_types` — the same identifier used as both a store id and an
  Oxy account id. This is the whole of what `referral_partners_owner_key` cannot
  see, since that index is over the PAIR.

It detects and refuses nothing (the `payment_discrepancies` posture), and the
signals reach the OPERATOR surface only — naming a matched partner to the
applicant would disclose somebody else, which is why
`matched_partner_display_name` and `matched_partner_owner_id` are in
`REFERRAL_APPLICATION_FORBIDDEN_DISCLOSURES`.

---

## 8. Earning versus withdrawal

Shown as two different answers, because they are two questions with different
inputs (#146's own "Earning versus withdrawal readiness" group):

- `earningStarted` is the partner's STANDING. Earning begins at approval and is
  NOT gated on payout onboarding — ADR 0005 D15's rule that a participant may
  accrue before it is complete.
- `outstanding` collects EVERY reason a payout is blocked, never the first.

**The three readiness verdicts are DERIVED here, not read off the row.** The
first version read the stored columns on the `onboarding_state` reasoning, and
the real-server suite refused it immediately: a partner who had just completed
the tax questionnaire read `tax.readiness: 'ready'` and
`outstanding: ['tax_questionnaire_not_completed']` **in the same response**. This
now takes `payout-batch.service.ts`'s posture, which increment 1 already states —
the stored triple is an OBSERVATION and every reader that must be right derives
live.

---

## 9. Surfaces

**Partner** (nine routes, both mounts, no tenth):

```
GET    /referral-partner                      GET    /admin/stores/:id/referral-partner
POST   .../application                        POST   .../application
POST   .../application/submit                 POST   .../application/submit
POST   .../application/withdraw               POST   .../application/withdraw
POST   .../terms                              POST   .../terms
POST   .../marketing-consent                  POST   .../marketing-consent
GET    .../tax-profile                        GET    .../tax-profile
POST   .../tax-profile        ← ADR 0005 D15 gate 2, reaching a caller at last
POST   .../appeal                             POST   .../appeal
```

There is no route that takes a partner id, no route that reads another partner,
and no route that could grant a permission. `requirePartner` takes an OWNER and
never an id, so the refusal is the SIGNATURE.

**Operator**, on the SAME `REFERRAL_OPERATOR_OXY_USER_IDS` allow-list #143 and
#145 use — NOT an eighth. Deciding whether somebody may be a partner and
approving what they are paid are the same economy.

```
GET  /internal/referrals/partners                       the review inbox (state filter only)
GET  /internal/referrals/partners/:id/review            + live duplicate signals
POST /internal/referrals/partners/:id/review            claim it
POST /internal/referrals/partners/:id/review/decision    approve | reject | changes_requested
POST /internal/referrals/partners                       create in an operator-only mode
POST /internal/referrals/partners/:id/{suspend,reinstate,terminate}
POST /internal/referrals/partners/:id/appeal            resolve
```

The route set is CLOSED: no "set this partner's state", no "edit this
application", no "delete this review", no "amend this decision", no "grant this
partner X". The trace opens from a PARTNER and nothing else — no email, no
promotion URL, no name search.

**Rate limit:** `rl:referral-partner:`, shared by both mounts, 300/window.
Separate from `rl:referral-bind:` so a scripted enrollment loop cannot exhaust
the allowance shoppers need to redeem codes.

---

## 10. Environment

`REFERRAL_PARTNER_ENROLLMENT_ENABLED` (default **true**) gates the MOUNT of both
partner surfaces and nothing durable — `GUEST_SESSION_ISSUANCE_ENABLED`'s exact
shape: it stops NEW enrollment and every partner-facing enrollment write, and
touches nothing that exists. The operator review surface is deliberately not
gated by it, so a queue can be worked through during whatever incident turned it
off.

Default TRUE where #145's three loop levers default FALSE, and the asymmetry is
the point: those are timers, and a timer nobody armed does nothing, while this
gates the only path by which a partner can complete D15's tax gate. Shipping it
OFF would reproduce exactly the state increment 1 left behind, with the symptom
being silence.

It is deliberately **not** `REFERRALS_ENABLED`: that lever demands both link
secrets because the redirect cannot work without them, enrollment reads neither,
and gating there would forbid the ordinary staged rollout of enrolling partners
before attribution is switched on.

---

## 11. Migration

`0084` (`pre`), additive throughout: three tables nothing yet writes, two columns
on `referral_partners` (one DEFAULTED so the serving image's INSERT keeps
working), and two CHECK WIDENINGS verified element by element against the
definitions actually in the chain — `referral_events_action_check` 53 → 60
(previous definition in `0083`) and `referral_partners_state_check` 5 → 9
(previous definition in `0015`), nothing removed from either. No statement breaks
a write the previous image performs.

Three hand-written trigger blocks, delimited by anchored begin/end markers:
`referral_partner_application_reviews_append_only`,
`referral_terms_acceptances_append_only` and
`referral_partner_applications_content_freeze`. A regeneration drops all three —
re-append them verbatim and re-read the whole file.

Table count 386 → **389**, recounted empirically from the barrel's `PgTable`
exports.

---

## 12. What is still owed (increment 3)

Named rather than stubbed, and none of them blocks a payout:

- **Partner payout settings** — start/resume hosted onboarding, supported
  country/currency and masked destination, payout threshold and cadence,
  currency selection, beneficiary change through the approved flow, program
  deactivation.
- **Notifications** — all ten #146 kinds. Mercaria has no outbound mail
  transport, so they land as a named EMPTY registry failing visibly with
  `transport_unconfigured` and the row intact (#79 and #108 are the precedents);
  a `console.log` transport looks like a working feature in every test and sends
  nothing in production.
- **Statements** — the annual earnings statement D15 promises, and remittance
  downloads.
- **#147** — partner dashboards; **#148** — fraud, which owns the risk signals
  this domain deliberately keeps out of rejection copy.

`#146`'s twelve requirement groups after this increment: enrollment modes,
application, review and approval, terms acceptance, identity and tax readiness,
earning versus withdrawal readiness and security/privacy are MET; payout
beneficiary and payout-provider integration were met by increment 1; partner
payout settings, notifications and the statement half of testing remain.
