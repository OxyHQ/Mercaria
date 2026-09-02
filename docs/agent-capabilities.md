# Agent capabilities and MCP

Mercaria declares its agent surface once in
`packages/backend/src/capabilities/mercaria.catalog.ts`. The same catalog drives
the internal capability-ticket routes, the external MCP tool definitions, Oxy's
permission UI and catalog registration during deployment. Tool names or schemas
must not be copied into Alia or into a second MCP-only registry.

## Access planes

- Oxy-native execution calls `/_oxy/capabilities/<tool>` with a short-lived
  `Capability` ticket. Mercaria verifies the signature and exact audience,
  resource, tool, capabilities and limits, then asks Oxy for a live authority
  decision before invoking domain code.
- External clients call `/mcp` with an OAuth access token issued by Oxy for the
  exact `https://mcp.mercaria.oxy.so` resource and selected Oxy account. The
  shared `@oxyhq/mcp` transport performs live token introspection and protocol
  validation before Mercaria checks current store membership and permissions.

Both paths use the effective account to read or operate Mercaria resources. An
agent account remains the audit actor; it never receives the effective account's
session or a connection secret. Removing a store member or permission therefore
blocks the next call even if a short-lived token still exists.

## Financial boundary

`refundStoreOrder` is internal-only. Its ticket must carry
`store.refunds.execute`, an exact store resource, an idempotency key and a signed
maximum amount in the order's presentment currency. The refund service checks the
ceiling before any effect, refunds only to the original payment rail and scopes
idempotent replay to the same store and order.

The external MCP intentionally exposes only read tools. Oxy's OAuth consent can
grant semantic scopes, but it does not yet persist a consent-bound numeric amount
limit; accepting a maximum supplied by the caller would not be authorization.
Financial MCP exposure can be added only after that bound exists centrally.

## Deployment

The production image contains `dist/register-capability-catalog.js`. The AWS
workflow resolves the pushed ECR digest, registers one immutable ECS task
definition, and uses that same revision for migrations, rollout and catalog
registration. Oxy application credentials remain in SSM and enter the task only
through the infrastructure-managed task definition.

The rollout waits for that exact ECS deployment to become the completed primary,
verifies the live task definition and image digest, then probes the public MCP resource,
central OAuth metadata, read-only scope set, bearer challenges and API/MCP host isolation.
This happens before post-phase migrations or catalog publication. In the normal phased
path, a candidate that fails before that boundary is returned to the recorded previous
task definition; the explicit all-migrations cutover and failures of the external Oxy
authorization server are never treated as safe Mercaria rollbacks.
