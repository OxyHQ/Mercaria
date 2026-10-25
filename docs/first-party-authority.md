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

## Earlier candidate validation

This source was validated with the Oxy core 7/contracts 6/MCP 1.4 candidate,
CrowdSource SDK containing commit `99db506ab`, Peable SDK containing `5ca41fe`, and
the published Clarity SDK 0.10.0. Local tarball paths are deliberately absent from
committed manifests. Before deploying, publish the remaining SDK changes through their
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

SDK 0.7 adds `mercariaForOxyService` on `@mercaria.co/sdk/server`. It owns only
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

## Patched contract composition

The SDK-only release 0.7.1 is published from `9ba9d541`, with the patched Zod
`^4.6.7` runtime dependency. The private backend and contracts use that same
minimum. This runtime branch is rebased on that release; the SDK publication did
not enable the backend receiver or outbound workload clients.

Deployment order remains Oxy API preparation, Clarity reader, old Clarity writer
and worker drain plus reviewed legacy-job reconciliation, Mercaria receiver,
and finally Clarity's canonical Mercaria caller. Clarity's producer changes must
not enter the reader deployment. The registry composition below now satisfies
the dependency gate; CI and ordered deployment remain required.

The final patched Oxy contract candidate passes 42 receiver/SDK/HTTP/PostgreSQL
tests plus four company-directory PostgreSQL tests, backend source/test
TypeScript and production build. The directory fixture now uses the SDK's
returned organization type, so its nullable fields are present as the wire
response requires; no production identity logic changed. Oxy core 7/contracts 6
are published, but this checkpoint still awaits the CrowdSource and Peable
factory releases before the final complete registry composition. No candidate
paths or overrides are committed.

## Published registry composition, 2026-10-25

The runtime now pins public Oxy core 7.3.0, contracts 6.0.0, services 13.0.0,
MCP 1.4.0, CrowdSource core 3.1.0/contracts 1.1.1 and Peable SDK 0.5.0. Clarity
SDK 0.10.0 and Mercaria SDK 0.7.1 were already published. No candidate override
or local dependency path remains. Installed Oxy/product candidates were removed
from this worktree before a fresh registry-cache install and frozen verification;
the installed contracts declaration matches the actual published Zod 4 artifact.

Validation against these registry packages: 54 tests across the public receiver,
shared workload client, retired middleware guard, real HTTP/PostgreSQL SDK
contract and Moovo client isolation; backend types/build and all storefront,
dashboard, POS and shared UI typechecks pass. AGENTS and Biome pass. The earlier
full domain suite remains applicable to unchanged commerce logic; CI validates
the complete final source. No financial, tenant, merchant or account rule was
removed with the old inter-application scope checks.

Clarity's reader and reviewed lineage reconciliation are now complete, as
verified by the delivery coordinator. This receiver is ready for its own CI and
release; deploy and verify it before Clarity's canonical Mercaria producer.
This source checkpoint does not claim Mercaria deployment or retirement of the
central finite legacy workload transition.

The backend keeps its immutable application/audience constants in
`src/config/oxy-identity.ts`; production modules do not import the public SDK
through test-only TypeScript aliases. The ecosystem activity collector receives
the shared AWS workload credential provider directly, including temporary local
role credentials. Billing configuration does not infer authority from ECS
environment variables: the shared transport verifies credentials when used,
and customer keys never provide a fallback. The five affected CI suites (24
tests), backend TypeScript and production build pass with these boundaries.


## Alia client transport

The frontend source uses the published `@alia.onl/sdk` 22.0.0 with the existing
Core 7.3 / services 13 stack. Alia owns conversation, history, streaming and audio
transport through the shared Oxy session; the app keeps its existing provider,
agent selection and UI. No app-local bearer refresh or internal permission prompt
is introduced. Package installation was checked against the published artifact;
source adoption and deployment are separate rollout steps.
