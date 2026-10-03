# Published SDK equivalence and remaining Mercaria cutover

Source inspected: Mercaria a267c2ef and registry @peable.to/sdk0.2.0 with
shared-types0.3.0 (98 installed files verified against registry distributions).
The five recurrent BillingProvider methods already use the published SDK in
candidate PR1044. This is separate from the one-off/marketplace payment provider.

The historical explanation in `payments/peable/client.ts` that the SDK lacks
settlement endpoints is now obsolete. It remains an implementation inventory,
not justification for permanent local token plumbing. Removing it requires the
following explicit parity work; this document does not enable the payment rail.

| Current consumer operation | Published equivalent | Parity gate before replacement |
| --- | --- | --- |
| createPayment POST payment_intents | paymentIntents.create(params,{idempotencyKey}) | Same metadata/minor-unit conversion, status and caller key; request count and lost-response recovery |
| getStatus GET payment_intents/:id | paymentIntents.retrieve(id) | Same status mapping, no success inferred from pending/unknown |
| resumePayment currently repeats GET | retrieve + clientAction(id) | Current adapter expects optional `client_action` embedded in intent; published contract has a separate bounded action read. Prove actual gateway shape and ownership before changing the flow; never log/store action values |
| cancel POST :id/reject | paymentIntents.reject(id) | SDK has no key option on reject; inspect gateway idempotency contract and retain domain semantics, not blind header deletion |
| refund POST refunds | refunds.create(params) | externalRef=durable refund ID, lifecycle vs paymentStatus, duplicate/partial/pending/failed; SDK does not expose the current extra header |
| createTransfer POST transfers | transfers.create(params) | externalRef=order ID and exact connected-account ownership; no new split/fee policy; SDK does not expose extra header |
| reverseTransfer POST :id/reversals | transfers.reverse(id,params,{idempotencyKey}) | Use cumulative amountReversed on TransferWithReversal, not reversal-leg amount; same key across retry |
| connected-account onboarding | connectedAccounts namespace exists | No consumer of custom peableRequest outside this provider currently uses connected-account endpoints; do not invent adoption work or create accounts |
| HMAC verification in verify.ts | webhooks.constructEvent | Separate boundary: current/previous secret rotation, raw bytes, timestamp tolerance and event shape must match before deleting local verifier |

The HTTP client's20s deadlines are not configurable in SDK0.2.0. Preserve a
bounded request contract by fixing the shared SDK upstream, with HTTP tests,
before claiming a transparent replacement. Both clients retry once on401; SDK
invalid/empty/aborted successful bodies now correctly produce an indeterminate
error. Map SDK errors to PaymentProviderError without logging hosted URLs,
client actions, secrets or raw provider messages; keep the outbox as the owner
of retries and keep stable idempotency/external references.

Proposed test tranche: real SDK against local HTTP and existing Mercaria SQL
fixtures; compare path/body/key/one401 refresh, lost response, duplicate refund,
partial transfer reversal, cumulative totals and invalid response. Existing
marketplace receipts and outbox remain authoritative. Provider stub only; no
real account, payout, refund or commercial catalogue creation is implied. Any
actual wire mismatch is first a reproduced upstream/adapter defect. I11's full
custom-client replacement remains open until these tests and source migration
are accepted, independent of recurrent BillingProvider's local acceptance.

## Cohort configuration availability (2026-10-03 inventory)

| Boundary | Known deployed evidence | Still needed |
| --- | --- | --- |
| Oxy Mercaria application/service credential | production credential01a061cd-39a9-7bd6-ba31-70ef7590c953, application6a37d0cc5d4b5f15482a9340; existing4 scopes omit payments | Reviewed atomic CAS additions + readback/new token, no user grants |
| Peable backend | TD7, compatible API, no Stripe or cohort configuration | Terraform reference to approved existing secret, account/mode readback, explicit cohort, effective Portal restrictions |
| Mercaria backend | existing Stripe configuration; six commercial tables empty in root inventory | Verify deployed account/mode, exact existing merchant/app/env and owned store IDs; empty plans do not prove no stores |
| Test canary | Stripe sandbox account established by earlier owned fixtures | Existing matching Oxy test credential + Peable merchant + Mercaria test store are not yet evidenced |
| Store allowlist | Issue87 authorizes an exact Mercaria cohort, but body/comments name no store UUID | Read-only inventory and approved concrete allowlist before activation; no guessed store/merchant/plan/price |

Production credentials cannot impersonate a test merchant. SDK publication and
readiness do not establish a usable commercial or test cohort. Keep config absent
until namespace/binding gates are satisfied; no automatic legacy fallback for a
configured cohort. A flag-off rollback preserves its durable ownership/routing
configuration as described in `i08-billing-cohort.md`.
