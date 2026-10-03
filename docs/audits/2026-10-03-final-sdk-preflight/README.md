# Mercaria: final SDK manifest preparation

Base `9aff49fc43a9e1e4197909d8a129f84e40c75400`; own worktree `/home/nate/Oxy/Mercaria/.worktrees/1519-final-sdk-pins-20261003`.

This is a reviewed-input preparation artifact, **not an installed or published
SDK adoption**. The real package manifests and `bun.lock` remain unchanged.
`manifest-update.patch` is a concrete pending diff with 17 version
changes; `git apply --check` passes against this base. Keeping it as a patch avoids
committing manifests that cannot yet be resolved with their matching registry lock.

Targets: contracts 4.9.0, core 4.2.0, Services 11.1.0, MCP 1.1.0 and protocol 1.2.2
where already directly declared. No unused direct dependency is added. Bloom
consumers pin exactly 6.2.1; an existing Bloom peer is constrained to
`>=6.2.1 <6.3.0`. Final package/lock resolution must also verify transitive minima.

This base is the accepted composition of MCP effective-account source (PR 1043), Peable adoption (PR 1044), and raw-byte webhook verification. Preserve the domain and SDK transport source exactly. Peable SDK 0.2.2 is already adopted separately; this plan changes only Oxy/Bloom declarations. The core 3→4 and Services 10→11 upgrade requires actual frontend/POS/dashboard typechecks and auth regression tests, not only backend compilation.

The read-only Bloom import census finds 46 imported subpaths, all
with export entries and existing target files in published 6.2.1. This checks
paths only: named exports, props, rendering and full application compatibility
remain unverified until the actual installation/build. No source API replacement
or automatic downgrade workaround is included.

## Remaining sequence

1. Receive root's final package publication/integrity receipts and any outstanding
   accepted application source commits. Recheck input hashes and conflicts.
2. Apply `manifest-update.patch`, then run
   `bun install --minimum-release-age=0`. Preserve resulting `bun.lock` in the same
   source commit as the manifests. Never hand-edit lock entries or silently resolve
   an old version under the final nominal version.
3. Read installed package versions and compare registry tarball integrity/files;
   assert one intended Oxy/Bloom graph. Candidate packs are a separate test input.
4. Execute the package checks below with an owned PostgreSQL fixture where needed;
   existing database tests must remain real. Scope fixtures to their own IDs and
   preserve cleanup. Read package test selectors before invoking the final focal.
5. Check frontend auth preserves origin actor and active account, ordinary login,
   explicit logout/cold boot and callback contract. Backend MCP must preserve
   resource/account checks, revocation and idempotency.
6. Review source/lock/proof and coordinate CI and deployment with root. This document
   authorizes no independent live operation and closes no global acceptance item.

Planned commands (not executed by this preparation):

```sh
bun run build:shared-types
bun run --cwd packages/backend typecheck
bun run --cwd packages/backend test -- src/capabilities src/services/billing src/services/payments src/routes/__tests__/peable-webhook.integration.test.ts
bun run --filter @mercaria/ui typecheck
bun run --filter @mercaria/frontend typecheck
bun run --filter @mercaria/dashboard typecheck
bun run --filter @mercaria/pos typecheck
bun run build:backend
bun run build:frontend
bun run build:dashboard
bun run build:pos
```

The JSON plan records original manifest and lock hashes. The source diff outside
this audit directory is empty. No existing frozen native fixture or peer agent
worktree was edited.
