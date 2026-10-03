# SDK 0.2.2 adoption and two review regressions

Source134a2468 installs registry SDK^0.2.2 (no local overrides).53 SDK plus46
shared-types files equal registry archives. The standalone WebhooksResource owns
HMAC/envelope/type verification; Mercaria retains only current/previous rotation,
sanitized domain errors and normalization. No fake credentials or mint in ingress.
The old numeric-created fixture was corrected to the actual ISO-string contract;
resource fixtures now distinguish payment, dispute and connected-account payloads.

Review P2 truncated refusals: real HTTP RED3fail400/403/409,3pass408/429/503.
Status received before a body failure now determines permanence. Missing status
or interrupted2xx remains indeterminate/retryable, preserving original keys and
single request. No provider error text propagates.

Review P2 cancellation replay: real SDK/HTTP + SQL RED2fail. The synthetic gateway
now durably replays cancellation receipts instead of rebuilding them from mutable
state. After response loss and a later active reconciliation, repeating K formerly
wrote stale cancelled into SQL; a failed current read was never attempted. The
adapter validates the operation receipt and fetches/validates current state before
returning a snapshot. A failed read leaves newer SQL state and the original intent
for retry. Both cases converge on exactly one mutation. No general event-ordering,
provider snapshot atomicity or concurrent remote-write guarantee is claimed.

Final `bun run test` on provider, actual webhook route, recurring adapter and
registration:4files80PASS/2existing unsupported authorize/capture contract skips.
Strict backend TypeScript and scoped ESLint --max-warnings0 pass. Webhook positives
cover five formerly rejected types under both secrets, duplicate storage exactly
once; bad/expired previous/unknown signatures leave zero event rows. Existing raw
mount vacuity and tampering tests remain. Auth/provider boundaries are synthetic;
HTTP/SDK/domain/Postgres are real. No external financial effects.

Owned PG127.0.0.1:5575/oxy_i08_mercaria remains running. Harness-owned throwaway
DBs are dropped; final readback found none. No shared server stopped. CI1044 for
this head, composition1043/final Oxy SDK, rollout, scope/namespace/cohort and the
reviewed operator credential remain pending. No global issue is closed here.
