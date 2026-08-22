# Catalogue event and outbox contracts (#367 Workstream 0)

> Which durable row carries each catalogue event, who may write it, who reads
> it, and what a retry does. Binding:
> [ADR 0007](adr/0007-universal-catalog-taxonomy-and-authoring.md) D10.
> The register is `packages/backend/src/services/catalog-event-contracts.ts`;
> the gate is `packages/backend/src/services/__tests__/catalog-event-contracts.test.ts`.

The epic asks for contracts covering **schema publication, translation changes,
reindexing and cache invalidation**. All four already happen. What none of them
had was a contract — and, more to the point, none of them had one that could go
red.

## Why the register is code and not this page

This page cannot be the contract. Three prose statements describing exactly
these mechanisms were in the repository, each correct on the day it was written,
and each wrong by the time the register was:

| The claim | Where | What was true |
|---|---|---|
| `attribute_reindex_requests` has **three** enqueuers, named | `services/catalog-observability/trace.service.ts`, `queries.ts`, `catalog-observability.md`, `runbooks/catalog-indexing-lag.md` | Five production writers, and one of them does not call the repository function at all |
| `catalog_localization_revisions` is written by **four** triggers | `db/schema/catalogLocalization.ts`, `db/catalogLocalization/revisionRepository.ts`, `translation-revisions.md` | Eight triggers |
| The translation trail's read and rollback surface | `db/catalogLocalization/revisionRepository.ts` | Three exported functions, **zero** production importers |

None of the three went red, and two of them were cited by other documents as
though they described working machinery. So every population the register
declares is DERIVED by the gate — from the drizzle schema barrel, from a walk of
the production source tree, and from the migration SQL — and compared against
what is declared. The declaration is the decision; the derivation is what stops
the decision ageing.

## The four contracts

| Kind | Carrier | Shape | Written by | Consumer |
|---|---|---|---|---|
| `schema_publication` | `catalog_governance_audit_events` | append-only trail | `recordAuditEvent` | `listAuditEvents`, the operator surface |
| `translation_change` | `catalog_localization_revisions` | append-only trail | database triggers, one per text table | **absent** — see below |
| `reindex_request` | `attribute_reindex_requests` | durable queue | `enqueueAttributeReindex`, plus one direct table write | **absent** — nothing drains it |
| `cache_invalidation` | `catalog_authoring_schema_invalidations` | revision register | `bumpAuthoringSchemaInvalidation` | `readAuthoringSchemaRevisions`, folded into the memo key and the ETag |

`shape` is not decoration. A `durable_queue` is the only one of the three for
which "nothing consumes it" is a **defect**; for a register or a trail there is
nothing to drain and reporting a missing consumer would be a category error. The
gate enforces that asymmetry: only a queue may be marked `drains`, and an
undrained queue may not claim a dead-letter state.

## Two of the carriers are deliberately not outboxes

ADR 0007 D10 says caches are "invalidated through **transactional outbox
events**". The implementation diverged, on purpose, and
`db/schema/catalogAuthoring.ts` argues it: an outbox has a **delivery window**
in which every ECS task still serves the old entry and nothing anywhere says so.
A revision folded into the cache key has no window — an entry composed under
revision 4 is unreachable the instant the revision is 5, in every task at once,
because no lookup can name it.

`catalog_localization_revisions` is trigger-written for the mirror reason: a
trail written by a repository misses a backfill script, an operator at a `psql`
prompt and every path that forgot to call it, and a missing revision looks
exactly like a field nobody edited.

Neither divergence is a licence to invent a third shape. The house outbox
pattern is `db/schema/moderation.ts` — the row IS the job, claims are leases
taken with `FOR UPDATE SKIP LOCKED` plus an owner check, ids are deterministic
so a repeat converges, backoff is capped, `dead_letter` is visible, and a flag
gates the **loop** and never the durable record.

## What the gate actually asserts

- **Totality, both ways.** The register is a `Record` over `CATALOG_EVENT_KINDS`,
  so a kind with no contract is a `tsc` error (TS2741, naming the kind); the
  runtime half catches a contract filed under the wrong key.
- **The carrier is real.** The declared SQL name resolves to a `PgTable` in the
  drizzle barrel, and the declared drizzle symbol resolves to the same table —
  both halves, because the producer census greps for the symbol and a rename
  that left the SQL name correct would silently empty it.
- **The producer set is derived and equal.** The union of *modules calling the
  write handle* and *modules issuing `insert`/`update`/`delete` against the table
  symbol*, minus the defining module. The union is the point: a census over the
  repository function alone reports four producers for the reindex queue and
  reads tidy.
- **The trigger set is derived from the migration SQL** — every `CREATE TRIGGER`
  whose plpgsql function body inserts into the carrier — and no declared trigger
  may have been dropped.
- **A present consumer is exported and CALLED** by some production module other
  than its own. A dead export cited as a mechanism is a false statement with a
  gate around it, and this repository has had two.
- **An absent consumer is still absent**, by a probe it declares:
  `no_update_of_carrier` (a queue is drained by writing its completion column, so
  a drain cannot exist without an `update`) or `no_importer_of` (the reader
  module has no production importer). Both directions matter — a list of gaps
  that only ever grows can never report one closing.
- **Every invalidation subject has a producer.** The set of
  `AuthoringInvalidationSubject`s a production module actually bumps must equal
  the whole vocabulary. `localization` was declared, folded into the memo key and
  the ETag, and bumped by nothing until #655: an operator approved a translation
  and every task served the previous text until it restarted.
- **Every governance action has an invalidation decision.**
  `CATALOG_PUBLICATION_INVALIDATION` is total over `CATALOG_GOVERNANCE_ACTIONS`,
  every declared bump names a real subject, and `applyChange` must contain both
  that action's `case` and that subject literal.

Every population carries a vacuity floor, every detector carries a positive
control, and every set-equality check carries a mutation self-test in both
directions.

## Known gaps, both recorded as `absent` with a probe

**`reindex_request` has no consumer** (owed by #61). Five producers, a
deterministic id, a lease-shaped schema, a pending index and an `attempts`
counter — and no claim function, nothing writing `processed_at`, and nothing
incrementing `attempts`. Every row ever enqueued is still pending. This is
already surfaced honestly rather than as a zero: the trace reports the reindex
hop `unreachable`, `reindex_throughput` is `unmeasured`, and
[runbooks/catalog-indexing-lag.md](runbooks/catalog-indexing-lag.md) is mostly
about not sending somebody to restart a worker that does not exist.

**`translation_change` has no consumer** (owed by #367). Eight triggers fill the
trail and `db/catalogLocalization/revisionRepository.ts` — `readLocalizationFieldHistory`,
`findLocalizationRevision`, `rollbackLocalizationField` — has zero production
importers. [translation-revisions.md](translation-revisions.md) defers the HTTP
surface to `routes/internal-catalog-localization.ts` and says it lands after
#660 merges; #660 has merged, that router exists, and it carries three `GET`s,
none of them the history and none of them the rollback.

## Not covered here, deliberately

The register covers the four kinds the epic names and no others. Every domain
outside the catalogue keeps its own outbox and its own rules — moderation,
offers, payments, matching, curation, the guest portal, guest claims, price
alerts, price history, offer freshness, supplier orders, supplier preflight,
reconciliation, shopping agents and store linkage all have their own tables and
their own docs. `db/__tests__/outbox-enqueue-handle-census.test.ts` is the
repository-wide rule that applies to all of them: every `enqueue*` taking a
database handle takes it as a REQUIRED parameter.
