# Published Peable HTTP client adoption

Source f3a011de replaces the local client/mint/cache with published SDK0.2.1.
All53 SDK +46 shared-types files equal registry bytes. The provider preserves
20s per-attempt deadlines, caller idempotency keys, refund/order externalRefs,
minor-unit conversion, one401 re-mint and sanitized domain errors. Unknown
exceptions retain the existing retryable policy; no automatic lost-response retry.
The actual backend GET supplies optional client_action; resume remains one GET.

Validation: package `bun run test` over provider, webhook route, recurrent adapter
and registration:4files/60PASS/2existing unsupported-contract skips. Strict backend
TypeScript and scoped ESLint --max-warnings0 pass. The original provider contract
runs unchanged against real local HTTP and the installed SDK; only gateway/auth
responses are synthetic. Additional cases cover body/key, one401 refresh and second
refusal, post-effect response loss with explicit same-key recovery,400/403/409 vs
408/429/503, cancel key, duplicate/pending/failed refunds and cumulative reversals.
The webhook route and recurrent domain use the existing real SQL fixtures.

PG is the owned persistent server127.0.0.1:5575 roleoxy_i08_mercaria; package harness
creates/drops its own throwaway database. It does not stop the server. No real
provider calls, offers, scopes, credentials, merchant registration or cohort changes.

SDK0.2.1 webhook constructEvent is not yet equivalent: its allowlist omits the
published refund/dispute/connected-account events. The consumer verifier remains
until the separately authorized upstream canonical allowlist fix passes parity;
this is an explicit remaining gate, not a claim of complete I11. Final CI, rollout
and commercial cohort remain pending. Earlier1044 CI belongs to source93b1 only.
