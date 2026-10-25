# Cookie-free commerce cutover

The owner approved option A on 2026-10-25: remove cookie transport while
preserving carts and existing access. This amends ADR 0003 D9/D10. It does not
turn Mercaria guest credentials or order grants into Oxy identities, remove
financial authorization, or enable guest commerce or referrals.

## Population evidence and preservation

The production diagnostic at **2026-10-25T15:00:46.286Z** selected aggregate
counts only. It found zero guest sessions, zero guest-order access grants
(including exchange grants), and three carts, all owned by Oxy accounts.
Guest commerce and referral issuance were disabled in the observed deployment.
The operator recorded an exit-zero task and removed its diagnostic definition;
no customer identifiers, credential values, cart contents or database writes
were involved. The [committed sanitized evidence](evidence/2026-10-25-cookie-free-commerce-population.json)
records exact source/image, timestamps, aggregate results and operator/receipt
SHA-256 values. No credential or customer identifiers are included.

A second aggregate diagnostic at **2026-10-25T15:29:53.639Z** also found zero
`guest_checkouts` and zero guest-origin orders, alongside the same zero session/
grant counts and three Oxy-owned carts. Its result and cleanup metadata are included in the same committed evidence. This closes the additional question
of an existing guest purchase recovering a new portal grant during the cutover;
it does not change the earlier fixed referral cutoff.

This observed population requires no guest/portal credential exchange or
backfill. The implementation leaves the three Oxy carts untouched. An empty
grant table does not establish that no historical purchase can be recovered:
normal magic-link recovery and one-time `mgx_` exchange remain available to
updated clients, with their existing ownership and expiry checks.

Before rollout, repeat the aggregate/config readback. If it finds live legacy
guest or portal credentials, stop and revise the preservation plan rather than
silently discarding them or issuing replacement carts. No migration is allowed
to reinterpret an arbitrary old cookie as account authority.

## Permanent transport

- Both native and web clients explicitly send `mgs_` and `mgp_` credentials in
  their existing guest and portal headers. Issuance requires the corresponding
  `X-Mercaria-*-Transport: header` declaration before any mint or one-time link
  consumption. Credential responses are `no-store` and include the server's
  absolute expiry and generation. Buyer-context and portal responses are also
  `no-store`, including anonymous/error responses, so a cached empty cart cannot
  be reused for a later header-authenticated owner. Public catalog caching is
  unchanged.
- Native credentials stay in SecureStore; web credentials use localStorage.
  This deliberately replaces HttpOnly protection: trusted script, CSP and
  origin controls remain relevant to XSS. The server retains hashed storage,
  revocation, bounded lifetime, order-group checks and the existing scopes of
  each portal grant. These domain constraints are not Oxy application scopes.
- The storefront uses Oxy's linked HTTP client for its Oxy session. It omits
  cookies and rejects redirects, foreign API origins and stale account-epoch
  responses. Domain credentials hydrate before a request; revision checks and
  serialized persistence prevent late responses from overwriting newer tokens
  or restoring a deliberately cleared credential.
- Browser guest/portal issuance requires durable localStorage and Web Locks.
  Missing or failing storage refuses issuance before an unreadable credential
  can be created; public browsing and authenticated Oxy-owned carts remain
  available. First anonymous guest writes serialize across tabs until the
  initial credential is durably stored. A lost initial issuance response cannot
  reconstruct an unknown bearer; this does not alter existing server retention.
  Legacy native raw SecureStore values keep their exact token and original key;
  unknown local expiry/generation remain unknown until a real server issuance
  or rotation supplies metadata.
- Existing guests with known unavailable persistence send
  `X-Mercaria-Guest-Persistence: unavailable`. The central CommerceActor
  resolver returns `503 COMMERCE_STORAGE_UNAVAILABLE` before lookup, touch or
  rotation, including on reads. It does not substitute an anonymous actor.
  Public routes remain public and a verified Oxy actor keeps precedence. This
  is storage-availability negotiation, not a permission or scope; the frontend
  does not mirror a list of backend route mounts.
- Switching an Oxy account does not erase an independent guest cart or portal
  grant. Oxy authenticated ownership wins; merge/claim verify both proofs.
  Query state and pending responses are isolated across account changes.
- A presented but invalid Authorization header never falls through to a guest
  in CommerceActor. Portal-only reads deliberately authenticate the portal
  grant independently; claim and confirmation routes require their own actor
  proofs. This preserves the existing domain distinction.
- Rollout cohorts use the persisted issuance-time client class: `web` stays
  web, while `ios`, `android` and the historical header default `other` remain
  native. A later request header cannot rewrite the stored cohort. It is
  operational segmentation, not an authentication boundary.

Old bundles that do not declare header support are refused before issuing a
credential or consuming a link. Cookie-only private commerce requests are
refused instead of returning a replacement cart. Since ordinary CORS no longer
allows credentials, an old browser using `withCredentials` can see a CORS/network
error rather than the server's 426 body. Reloading the updated storefront is
required; global credentialed CORS is not restored to improve that old UI.

## Finite referral preservation

Signed referral carriers are stateless, so the database census cannot prove
there are no historical referral cookies. The only temporary bridge copies a
valid original `mrf_` carrier, without minting, binding, extending its click
window or touching commerce records.

The exact endpoints are POST `/referrals/legacy-cookie-exchange` and
`/referrals/legacy-cookie-ack`. Both require an exact configured Origin,
`X-Mercaria-Referral-Migration: header-v1`, and an empty JSON object. They run
behind the existing general limiter and are the only paths with credentialed
CORS. They are independent of the referral feature mount and cannot enable it.

Eligibility requires the signed original click time to be no later than
**2026-10-25T15:00:46Z**, its original expiry to remain live, and the request to
precede **2027-01-23T15:00:46Z** (the fixed 90-day ceiling). There is no sliding
configuration. Newly issued fragment carriers after the cutoff cannot be
planted as cookies to reopen the bridge. Invalid state, missing signing keys
and absent cookies produce the same empty exchange result.

An explicit referral header always takes precedence over a cookie, even when
invalid. Exchange retries return the original bytes and original expiry. The
client acknowledges only after durable storage succeeds; ACK compares the
persisted carrier with the cookie still present before expiring it. A changed
cookie from another tab is not cleared. Normal requests never send cookies.
New referral redirects carry state in a fragment consumed and removed before
routing; existing magic-link fragments are separate.

Remove the two bridge routes and their credentialed CORS exception after the
fixed deadline. Expired old cookies then have no accepting reader. This is the
only retirement work; do not keep a general cookie-authentication fallback.

## Validation and rollout

The independent Chromium review exercised the complete `createApp` stack with
a synthetic HttpOnly cookie and a throwaway migrated database. It verified the
real preflight, original-byte retries, header precedence, durable write before
ACK, limiter headers, foreign-origin rejection before POST, ordinary credentialed
CORS refusal, and the disabled referral feature. No production credentials or
writes were used. The portable browser regression reproduces these checks.

Backend HTTP and real-database tests preserve rotation/absolute expiry,
60-second prior-token grace, uniform revocation, cart ownership, order-group
isolation and one-time exchange consumption. Frontend tests cover actual HTTP
refresh/replay, multipart boundaries, account changes, multi-tab credential
storage, and failed persistence/ACK recovery. CI must pass the full existing
backend and frontend gates as well as the browser regression before rollout.

Deploy only reviewed artifacts. Keep the feature flags unchanged, verify the
API header contract and origin boundaries, then verify the updated storefront
and normal portal recovery. Preserve existing Oxy-owned cart identifiers and
ownership. A successful source test or image build is not a production
acceptance receipt; the operator records the deployed source/digests and
bounded readbacks separately.
