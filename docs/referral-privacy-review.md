# Referral program: privacy review (ADR 0005 A1–A5)

The record the production-readiness checklist in `docs/referral-attribution.md`
asks for before referrals run in production. It checks each identity boundary
of ADR 0005 against the code that enforces it, as of 2026-10-16, and names what
is still open. It is an ENGINEERING review: it says what the code does and can
prove. It is not legal advice, and the open items below are legal questions.

**Status:** the owner asked on 2026-10-16 for referrals to run in production,
and on the same day decided the consent question (item 1): **ask for consent,
and only then store or attribute.** That flow is implemented (below), so item 1
is RESOLVED. Items 2 and 3 remain open and are owned outside engineering.

## The boundaries

| | Boundary | Enforced by | Evidence |
|---|---|---|---|
| A1 | Codes and click ids are evidence, never credentials | The link token and the carrier (`mrf_…`) carry ids, a deadline and a consent letter only; no auth path reads them; the attribution input admits `{touch evidence, oxyUserId \| guestSessionId}` | `referral-attribution-isolation.test.ts`; `docs/referral-attribution.md` "The carrier" |
| A2 | Email, card fingerprint, Stripe customer, IP, device fingerprint are not referral identity | `REFERRAL_FORBIDDEN_IDENTITY_SIGNALS` (14 members) scanned against the domain; no payment-rail or analytics import | `referral-attribution-isolation.test.ts`, `referral-integrity-isolation.test.ts` |
| A3 | Oxy identity associates only after authentication; no retroactive joins | `touchActorFor` maps a resolved `CommerceActor` only; a merge does not rehome a standing attribution | `referral-edge.realdb.test.ts` (merge cases) |
| A4 | Guest conversion uses checkout-scoped ids, no durable hidden profile | Guest subject = guest session row id; carrier capped at 90 days and stored only after consent; `raw_touch` swept after 30 days (`REFERRAL_RETENTION_POLICY`, `db/expiryTargets.ts`) | `docs/referral-integrity.md` "Retention" |
| A5 | Partner-visible data aggregated and minimized | Partner views are separate types with explicit allow-lists; disclosure floor of 10 (`REFERRAL_PARTNER_DISCLOSURE_FLOOR`); one breakdown dimension per request | `referral-disclosure-floor.test.ts`, `referral-dashboard.realdb.test.ts` |

## The consent-first flow (resolves item 1)

Nothing is stored on, or read from, the buyer's device for referral tracking
until they press **Allow**, and nothing is attributed before then either.

1. **The click.** `GET /r/:token` answers `302` with `no-store` and
   `Referrer-Policy: no-referrer`, and **no `Set-Cookie`**. It does not resolve
   who is clicking and writes no touch — not even for a signed-in shopper. The
   click's signed carrier rides in the destination's URL **fragment**
   (`#mercaria_ref=mrf_…`), which browsers never send to a server and never put
   in a `Referer`. The only thing recorded is the link's click counter (a
   ceiling a partner's link may have), which names no person and is not on the
   device.
2. **The page.** The storefront reads the fragment once, removes it from the
   address bar (and from the router's copy), and holds the carrier in page
   memory only — never localStorage, sessionStorage or a cookie. Closing the
   tab forgets it.
3. **The question.** A notice says someone may be rewarded if they buy, the
   price does not change, and Mercaria will remember the visit for up to 90
   days only if they allow it — with **Allow** and **No thanks** as equally
   weighted buttons. While unanswered, the storefront sends nothing referral-
   related to the server at all, whether or not the buyer is signed in.
4. **Allow.** `POST /referrals/consent` presents the carrier on a request
   header (the only channel the server accepts it on). Signed in or with a
   guest cart, the click is attributed now and no cookie is set. Otherwise the
   server re-issues the carrier with the consent signed into it and stores it as
   the `HttpOnly` `__Host-mercaria_referral` cookie for the rest of its life (at
   most 90 days from the click); it is bound when the buyer signs in or starts a
   cart. The touch records `consent_mode = granted`, taken from the signed
   carrier rather than the client's word.
5. **No thanks.** The carrier is dropped from memory at once, and
   `POST /referrals/consent` with `denied` clears any older referral cookie.
   Nothing is written.
6. **Cookies from before this change** (set by the redirect without asking) are
   never used for attribution; the server clears them the next time the browser
   reaches `/referrals/*`.

Pinned by `referral-edge.realdb.test.ts` (no `Set-Cookie` and no touch at the
redirect, the fragment carrier verifies, each consent outcome, the header-only
channel) and `scripts/e2e/storefront/referral-binding.spec.ts` (fragment read
and stripped, nothing stored or bound while undecided, Allow and No thanks).

## Open items

1. **RESOLVED 2026-10-16 — consent for the attribution cookie (EU/ePrivacy).**
   Previously `GET /r/:token` set `__Host-mercaria_referral` on the click,
   before the buyer was asked anything. The owner chose to collect consent
   before the carrier is written; the flow above implements it, and nothing is
   stored on the device before Allow. What remains is the legal team's sign-off
   on the prompt's wording in each market, which is item 2.
2. **Which markets require a buyer-facing disclosure, and its wording**, is ADR
   0005 open item 1, assigned to the legal entity. The storefront's sentences
   (the disclosure and the consent prompt) are Mercaria's own;
   `referral_disclosure_requirements` holds what Mercaria decides per market.
3. **Operator access.** `REFERRAL_OPERATOR_OXY_USER_IDS` is empty in production,
   so nobody can review partner applications, pause a program or trace an
   attribution until it is set.
