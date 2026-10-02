# MCP active-account consumer correction

Source candidate for Oxy I11 [#1527](https://github.com/OxyHQ/oxy/issues/1527). Base `9e546e66b36b8050bfe07a37f53ee436444688cf` was the remote main head checked on 2026-10-02. This is a product implementation test, separate from the reduced I04 fixtures.

When an OAuth connection originates at A and selects B, the published `@oxy.so/mcp@1.0.0` validates the token and exposes `accountId` (origin) and `activeAccountId` (selected account). The product authorization callback and the canonical handler wrapper now both use B for domain authority/data. The unchanged baseline rejects the B invocation because its callback returns A. Fixing just that callback would leave the handler reading A.

Mercaria uses the active account for buyer order reads and live store membership/permissions, and preserves the origin account for actor attribution. Its canonical refund engine and signed ceiling remain unchanged. `refundStoreOrder` remains internal-only: external HTTP refuses it, even when the synthetic token carries its semantic scope. The PostgreSQL fixture uses the real authorizer to remove `refunds:write`, while a refusing financial-service mock proves no refund execution. All valid existing roles retain `orders:read`; removing an explicit grant cannot remove that role default. Membership removal denies the next HTTP invocation. The separate existing handler unit suite observes active B buyer arguments and origin A actor arguments using mocked services; its synthetic audit result is not a persisted audit or refund.

## Reproduce locally

Use a disposable PostgreSQL17 server authorized to create/drop test databases; Mercaria also requires installed PostGIS and `max_locks_per_transaction=256`. The recorded owned loopback server is described in [evidence.json](evidence.json); no shared-server configuration was changed. No `.env` containing real credentials is needed.

```sh
bun install --frozen-lockfile --minimum-release-age=0 --ignore-scripts
bun run build:shared-types
cd packages/backend
env -u PGHOST -u PGPORT -u PGDATABASE -u PGUSER -u PGPASSWORD -u DATABASE_URL \
  TEST_DATABASE_URL=postgres://oxy@127.0.0.1:5557/postgres STRIPE_ENABLED=false \
  bun run test src/capabilities/__tests__/mercaria-active-account.realdb.test.ts
bun run typecheck
```

The suite uses real product MCP HTTP service, published protocol validation and canonical domain SQL. Only central introspection and public profile enrichment are synthetic. Every unexpected global `fetch` rejects and is asserted absent, including at teardown, so swallowed enrichment errors cannot create a false pass. HTTP calls use `node:http` to loopback with the canonical resource Host header; no live Oxy API or financial adapter is needed in the final fixture. Test databases use the guarded shared `@oxy.so/db/testing` helper and real product migrator, and are dropped after each run.

Final focused validation: **4 suites/14 tests**, backend build, TypeScript, and scoped ESLint with `--max-warnings=0` pass. Logs and source/installed-module hashes are durable in [evidence.json](evidence.json). The authority fixtures before the teardown-only followup, at aa295efe, against unchanged baseline source are RED (5 failures, 3 passing regressions); earlier fixture errors and the Mercaria public-profile lookup are recorded separately.

## Remaining acceptance

This fix uses published APIs and changes no dependency manifest, lockfile, scope, credential, catalogue, migration or deployment. I04's new discriminated InvocationHandlers/internal MCP lane has not been adopted here. Coordinated actual releases, registration, full HTTP/internal-MCP/external-MCP parity, audit persistence, real consent and deployed account-switch verification remain separate gates. No issue is closed by this local candidate.

Initial draft CI [37059406425](https://github.com/OxyHQ/Mercaria/actions/runs/37059406425) passed 776 suites/12191 tests, including all five new real-DB cases. Its sole failure was the store teardown census: this new fixture deleted stores directly instead of using the shared helper that accounts for canonical links minted by concurrent backfill. The followup uses `deleteTestStores(getDb(), storeIds)` without changing the census or runtime. Expanded focal validation (consumer/domain/handlers/catalogue plus shared teardown/census) passes 6 suites/19 tests and TypeScript. Followup CI remains pending. The initial five skipped tests belong to the existing full suite; these new cases do not skip.
