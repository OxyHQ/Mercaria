# Oxy first-party authority

Mercaria authenticates its backend as the registered workload `oxy-mercaria-task`,
with an administratively bound environment. Oxy ADR 0049 is the canonical
contract: own services do not request OAuth scopes, consent, application grants
or customer key pairs. Customer OAuth, public MCP and customer integration keys
remain external authority with their existing bounded grants.

The shared Oxy service transport owns token refresh and request boundaries.
CrowdSource, Peable and Clarity clients use their product SDK factories with the
same `OxyServer`; callers do not construct service Authorization headers. Resource
and domain rules remain: CrowdSource resolves the active tenant from the verified
application, Peable resolves the merchant/environment, and Mercaria retains
store ownership, financial idempotency, Stripe cohort and durable outbox rules.
Webhook signature secrets authenticate provider events and remain required.

Local development needs an attestable registered workload for enabled platform
integrations. Customer keys never act as a fallback for own workload authority.
The backend can boot with inactive integrations without minting a token.

## Release gate

This source was validated with the Oxy core 7/contracts 6/MCP 1.4 candidate,
CrowdSource SDK containing commit `99db506ab`, Peable SDK containing `5ca41fe`, and
Clarity SDK containing `a6deb86`. Local tarball paths are deliberately absent from
committed manifests. Before deploying, publish these SDK changes through their
repositories' release workflows, update registry pins and lockfile, and rerun
backend typecheck, tests and build with those published artifacts. The historical
registry pins alone do not contain all factory changes.

Validation: 846 backend suites, 13,112 passing tests and five skipped, by union of
the full run and the 11-test commerce rerun against the local UTC PostgreSQL test
server. The initial month-bucket failure was the test server's inherited
Europe/Bucharest timezone; no reporting/financial logic was changed. Backend
TypeScript and production build passed. Payment provider tests exercise actual
SDK HTTP transport, refresh and idempotency; public MCP tests retain the selected
account and external token boundary.

## Public catalogue receiver and SDK release order

SDK 0.7.0 adds `mercariaForOxyService` on `@mercaria.co/sdk/server`. It owns only
public catalogue reads; it does not expose the materials account commands.
Clarity and other own callers use its canonical receiver audience
`oxy-service:6a37d0cc5d4b5f15482a9340`. The shared Oxy middleware verifies the live
workload and preserves external service-token scope intersection and revocation.
Anonymous reads remain available, while a supplied invalid token fails closed.
A service reading on its own behalf has no fabricated user or viewer; payload,
visibility and public cache rules are unchanged. Both the general and public API
rate limiters use the same receiver audience and verified application identity.

The receiver and outbound clients share the same OxyServer with the temporary
AWS role/SSO provider. Missing ECS environment variables do not disable a valid
local provider; actual attestation determines readiness. There is no key fallback.

Publish the additive SDK separately before backend changes to avoid the
Clarity/Mercaria package dependency cycle. Then pin published Oxy core 7 and
Clarity SDK 0.10, deploy the receiver, and only then enable canonical caller
transport. The finite legacy workload transition belongs to central Oxy; Mercaria
never promotes a customer key or a persisted tier label. Source implementation
and local candidate validation do not assert production cutover.

Receiver checkpoint: 42 tests across four suites pass, including the real SDK
HTTP mint/verification composition and the existing public API SDK/PostgreSQL
contract suite. Wrong audience, missing account proof, revocation, external live
scope intersection and redirect isolation are exercised. Backend source/test
typecheck and production build pass with local Oxy/CrowdSource/Peable candidates;
Clarity 0.10.0 is pinned from its published registry artifact. Candidate overrides
were restored before commit. The final registry pins remain a release gate.
