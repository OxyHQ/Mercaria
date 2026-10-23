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
