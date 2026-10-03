# Published SDK equivalence and remaining Mercaria cutover

Source: Mercaria candidate PR1044 and registry @peable.to/sdk0.2.1 with
shared-types0.3.0 (53 SDK +46 shared-types files verified against registry bytes).
The five recurrent BillingProvider methods already use the published SDK in
candidate PR1044. This is separate from the one-off/marketplace payment provider.

The historical explanation in `payments/peable/client.ts` that the SDK lacks
settlement endpoints is now obsolete. The local HTTP client is now removed. The provider delegates token minting,
caching, single401 refresh and HTTP to the published SDK. This migration does
not enable the payment rail or change marketplace accounting.

| Current consumer operation | Published equivalent | Parity gate before replacement |
| --- | --- | --- |
| createPayment POST payment_intents | paymentIntents.create(params,{idempotencyKey}) | Same metadata/minor-unit conversion, status and caller key; request count and lost-response recovery |
| getStatus GET payment_intents/:id | paymentIntents.retrieve(id) | Same status mapping, no success inferred from pending/unknown |
| resumePayment currently repeats GET | paymentIntents.retrieve(id), one call | Verified actual backend create/GET compatibility shape includes optional `client_action`; mapper narrows that unknown field without a local DTO/shim. The earlier two-call proposal was incorrect. No action values logged/stored |
| cancel POST :id/reject | paymentIntents.reject(id,{idempotencyKey}) | SDK0.2.1 preserves the caller key; HTTP test verifies it |
| refund POST refunds | refunds.create(params,{idempotencyKey}) | externalRef=durable refund ID, lifecycle vs paymentStatus, duplicate/partial/pending/failed and key preserved |
| createTransfer POST transfers | transfers.create(params,{idempotencyKey}) | externalRef=order ID and exact destination retained; no new split/fee policy |
| reverseTransfer POST :id/reversals | transfers.reverse(id,params,{idempotencyKey}) | Use cumulative amountReversed on TransferWithReversal, not reversal-leg amount; same key across retry |
| connected-account onboarding | connectedAccounts namespace exists | No consumer of custom peableRequest outside this provider currently uses connected-account endpoints; do not invent adoption work or create accounts |
| HMAC verification in verify.ts | webhooks.constructEvent | Not yet equivalent: SDK0.2.1 allows only five payment event types and rejects legitimate refund/transfer/dispute families. Upstream canonical allowlist fix and signed parity tests required before deleting local verifier; current/previous rotation remains consumer configuration |

SDK0.2.1 supplies the optional deadline missing in0.2.0. The adapter explicitly
sets20,000ms per mint/gateway attempt, retaining bounded reads including bodies.
Only the existing single401 refresh retries automatically. Timeouts/lost responses
return a sanitized PaymentProviderError; the outbox owns subsequent attempts,
using original idempotency/external references. Known400/403/409 are permanent,
408/429/5xx and indeterminate transport errors retryable. Unknown exceptions keep
the existing retryable policy. No raw provider error, hosted URL or action is logged.

The unchanged provider contract now crosses real local HTTP and the published SDK,
with a synthetic gateway/domain boundary.32 tests pass; two existing unsupported
authorize/capture contract cases remain skipped (explicit refusal controls pass).
Coverage includes exact create body/key, one-call resume with action, one401 refresh,
second401 refusal, post-effect lost response with explicit same-key recovery,
status/error redaction, cancel key, duplicate/pending/failed refund lifecycle and
cumulative reversal totals. No real provider network or commercial effect occurred.
SQL/domain and webhook route regressions are validated separately. Full I11 remains
open for canonical webhook replacement, final CI and deployment/adoption acceptance.

## Cohort configuration availability (2026-10-03 inventory)

| Boundary | Known deployed evidence | Still needed |
| --- | --- | --- |
| Oxy Mercaria application/service credential | production credential01a061cd-39a9-7bd6-ba31-70ef7590c953, application6a37d0cc5d4b5f15482a9340; existing4 scopes omit payments | Reviewed atomic CAS additions + readback/new token, no user grants |
| Peable backend | TD7, compatible API, no Stripe or cohort configuration | Terraform reference to approved existing secret, account/mode readback, explicit cohort, effective Portal restrictions |
| Mercaria backend | existing Stripe configuration; six commercial tables empty in root inventory | Verify deployed account/mode, exact existing merchant/app/env and owned store IDs; empty plans do not prove no stores |
| Test canary | Stripe sandbox account established by earlier owned fixtures | Read-only inventory found no Peable merchant for Mercaria app and no development credential. Normal register({}) creates a technical app/environment namespace; scoped operator credential plan pending review |
| Store allowlist | Issue87 authorizes an exact Mercaria cohort, but body/comments name no store UUID | Read-only inventory found two stores/owners; one owner equals the application owner. Neither is automatically a test cohort. Exact reviewed namespace/store/mode binding required; no guessed offer/price |

Production credentials cannot impersonate a test merchant. SDK publication and
readiness do not establish a usable commercial or test cohort. Keep config absent
until namespace/binding gates are satisfied; no automatic legacy fallback for a
configured cohort. A flag-off rollback preserves its durable ownership/routing
configuration as described in `i08-billing-cohort.md`.
