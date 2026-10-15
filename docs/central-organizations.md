# Central company cutover

[ADR 0017](adr/0017-company-identity-lives-in-oxy.md) defines ownership. Do not deploy
this consumer before Oxy's organizations API and released contracts/core packages
are available. Temporary SDK builds used for isolated verification are not a
production dependency or committed artifact.

## Ordered deployment

1. Deploy and verify the Oxy organization API. Update Mercaria's pinned registry
   dependencies and lockfile to the reviewed release and run the focused checks.
2. Run the standard migration runner in `pre` mode with migration 0166. It
   atomically archives old company facts, freezes identity edits and legacy
   identity inserts, adds the nullable Oxy reference and permits new reference-only
   rows. Old required name columns become nullable. No placeholder name is used.
3. On a nonempty database, run the dry-run command below and inspect the source
   groups, hash, reviewed mappings and domain re-verification report. Resolve
   nonactive companies and any mapping conflicts in Oxy. No fuzzy or name-only
   mapping is permitted. Company-identity authoring stays frozen during cutover;
   normal commerce relationship references remain unchanged.
4. Apply exactly the reviewed plan hash. The script verifies the selected database,
   uses Oxy's admin session SDK, imports external IDs idempotently, then atomically
   saves local mappings using null-or-same compare-and-set conditions. A failure
   before local commit can safely be retried. Refresh an expired admin token using
   the normal Oxy flow rather than modifying the tool to bypass authorization.
5. Verify every reference is mapped, original redirect chains and relationship,
   supplier, alias/source-link counts remain intact, and canonical company reads
   resolve. Roll out the new application. Old and new code may coexist only while
   company identity writes remain frozen; new reference-only inserts are valid.
6. After old application instances are drained, run the standard runner in `post`
   mode. Migration 0167 checks all mappings and exact source/archive equality
   before removing local identity columns and making the Oxy reference required.
   A missing mapping or altered archive aborts the migration transaction.

Use the existing VPC one-shot ECS procedure with the live service's task definition,
network and security group. Never expose a database port or log credentials.
The regular `src/db/migrate.ts` runner is the only migration executor; consult
[PostgreSQL migrations](postgres-testing-and-migrations.md) for phase arguments.

```sh
# DATABASE_URL is injected by the selected environment; never print it.
bun run packages/backend/src/scripts/backfill-central-organizations.ts --target-database mercaria --plan-output /tmp/mercaria-company-plan.json
# OXY_ADMIN_ACCESS_TOKEN is injected through an approved secret mechanism.
bun run packages/backend/src/scripts/backfill-central-organizations.ts --target-database mercaria --apply --plan-sha256 REVIEWED_HASH
```

`--plan-output` writes the exact groups, source archives, aliases, reviewed mappings and
plan hash to a new private file (mode 0600), refusing to overwrite an existing plan.
Inspect that artifact before apply; it contains no database URL or token.

Optional `--reviewed-mappings /path/to/reviewed.json` is an array of
`{organizationId, accountId, evidenceReference}`. The file participates in the plan
hash and must be identical between dry-run and apply. If the dry-run reports
legacy verified domains, `--acknowledge-domain-reverification` explicitly accepts
that those domains need Oxy verification. It never grants verified status.

Before post, rollback means keeping the archive and freeze, restoring the earlier
application for read-only identity presentation and resolving the failed mapping.
Do not thaw old company writers while new references exist. After post, prefer a
forward repair; historical identity fields can only be reconstructed through a
reviewed migration from immutable evidence, never as an automatic serving fallback.

## Observed production state and checks

A read-only ECS task using `oxy-mercaria:87` on 2026-10-15 returned database
`mercaria`, zero organizations, zero organization relationships, zero supplier
references, zero aliases and zero source links. The migration ledger had 166 rows.
Task ID: `871186d926774d8fb84a92606dab41eb`. This is an observation, not permission
to assume future emptiness: pre/post guards still inspect live data. No production
migration was applied by that inventory task.

Validation uses a private PostgreSQL database with nonempty old companies, a merge
chain, alias and brand ownership relationship: pre permits reference-only inserts,
old writers and evidence mutations fail, post refuses missing mappings, successful
cutover preserves IDs and references, and identity columns disappear. SDK-mocked
reads test global deduplication, 100-account batches, merges, missing/suppressed
companies, canonical renames and outages. Separate migration tests cover equal
names, redirect cycles, retries, changed plan hashes and domain reverification.
