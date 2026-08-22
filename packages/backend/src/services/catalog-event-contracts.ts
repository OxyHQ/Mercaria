/**
 * The catalogue's event/outbox contracts, as data (#367 Workstream 0).
 *
 * The epic asks for contracts covering "schema publication, translation
 * changes, reindexing and cache invalidation". All four already HAPPEN in this
 * repository; what none of them had was a contract — a statement of which
 * durable row carries the fact, who may write it, who reads it, and what a
 * retry does — bound to the code well enough that a change goes red.
 *
 * ## Why a register rather than a paragraph
 *
 * A prose description of an event is a fact with no owner. Four figures in
 * `docs/catalog-table-ownership.md` rotted that way, and this register was
 * written on top of three more that had:
 *
 *  - `attribute_reindex_requests` is described as having **three** enqueuers in
 *    `services/catalog-observability/trace.service.ts`, `queries.ts` and
 *    `docs/catalog-observability.md`. It has FIVE production writers, and the
 *    fifth is not even a caller of the repository function — it inserts the
 *    table directly.
 *  - `catalog_localization_revisions` is described as written by **four**
 *    triggers in `db/schema/catalogLocalization.ts` and
 *    `db/catalogLocalization/revisionRepository.ts`. Eight triggers write it.
 *  - `db/catalogLocalization/revisionRepository.ts` exports three functions —
 *    the whole read and rollback surface for the translation trail — and has
 *    ZERO production importers.
 *
 * Every one of those numbers was right when it was written. None of them goes
 * red. `__tests__/catalog-event-contracts.test.ts` DERIVES each population from
 * the source tree and the migration set and compares it against what is
 * declared here, so the next writer, trigger or consumer that appears fails the
 * build until somebody decides what it means.
 *
 * ## What a "contract" is here, and what it deliberately is not
 *
 * It is NOT a new queue. The repository has a house outbox pattern already —
 * the row IS the job, a claim is a lease taken with `FOR UPDATE SKIP LOCKED`
 * plus an owner check, ids are deterministic so a repeat converges, backoff is
 * capped, `dead_letter` is visible, and a flag gates the LOOP and never the
 * durable record (`db/schema/moderation.ts` is the reference). Three of the
 * four kinds below are carried by mechanisms that already exist; the fourth is
 * carried by a queue that exists and is inert. Adding a fifth shape would make
 * two answers to one question.
 *
 * It is also NOT a claim that every carrier here IS an outbox. Two of them
 * deliberately are not, and the divergence is the interesting part:
 * `catalog_authoring_schema_invalidations` is a revision register read INTO the
 * cache key rather than an event pushed at a listener, because an outbox has a
 * DELIVERY WINDOW in which every task still serves the old entry
 * (`db/schema/catalogAuthoring.ts` argues it in full), and
 * `catalog_localization_revisions` is written by triggers so that a backfill
 * script and an operator at a `psql` prompt cannot bypass it. `shape` names
 * which of the three each carrier is, so nothing has to be inferred from a
 * table's name.
 */

import type { AuthoringInvalidationSubject, CatalogGovernanceAction } from '@mercaria/shared-types';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The four catalogue event kinds #367 Workstream 0 names, verbatim.
 *
 * Closed, and the gate is total over it in BOTH directions: a kind with no
 * contract fails the build, and a contract naming no kind cannot be written
 * because the register is a `Record` keyed on this tuple. That is the whole
 * point of the tuple existing — the epic's sentence becomes a thing a compiler
 * and a test can hold.
 */
export const CATALOG_EVENT_KINDS = [
  'schema_publication',
  'translation_change',
  'reindex_request',
  'cache_invalidation',
] as const;

export type CatalogEventKind = (typeof CATALOG_EVENT_KINDS)[number];

/**
 * How a carrier makes a fact durable. Three shapes, and they are not
 * interchangeable.
 *
 * - `durable_queue` — the row IS a job. Something is expected to claim it,
 *   complete it and leave. The moderation outbox's shape.
 * - `revision_register` — one row per subject holding a monotonic counter, read
 *   INTO a cache key. Nothing claims it and nothing completes it; it has no
 *   delivery window, which is exactly why it was chosen over a queue.
 * - `append_only_trail` — the row records that something happened. It is read
 *   by people and by reports, never drained.
 *
 * A `durable_queue` is the only shape for which "nothing consumes it" is a
 * DEFECT. For the other two it is a category error: there is nothing to drain.
 */
export const CATALOG_EVENT_CARRIER_SHAPES = [
  'durable_queue',
  'revision_register',
  'append_only_trail',
] as const;

export type CatalogEventCarrierShape = (typeof CATALOG_EVENT_CARRIER_SHAPES)[number];

/* -------------------------------------------------------------------------- */
/* The contract shape                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How a row gets written.
 *
 * `repository` names ONE exported function every application write goes
 * through. `database_trigger` names the triggers, and is the stronger form: a
 * trail written by a repository records what the service did and misses a
 * backfill script, an operator at a `psql` prompt and every path that forgot to
 * call it — and a missing row looks exactly like a field nobody edited.
 */
export type CatalogEventWrite =
  | {
      readonly by: 'repository';
      /** The exported symbol. Verified to exist and to be exported by `definedIn`. */
      readonly symbol: string;
      /** `src`-relative path of the module that exports it. */
      readonly definedIn: string;
    }
  | {
      readonly by: 'database_trigger';
      /**
       * Every trigger that writes the carrier. DERIVED from `drizzle/*.sql` and
       * compared against this list, so the eighth trigger cannot arrive while
       * the docblock still says four.
       */
      readonly triggers: readonly string[];
    };

/**
 * Who reads the carrier, or the honest statement that nobody does.
 *
 * `drains` and `reads` are different facts and neither substitutes for the
 * other: a read-only operator listing over a queue is not a consumer, and
 * reporting it as one is how "queued, waiting" becomes indistinguishable from
 * "queued, and nothing will ever read it".
 */
export type CatalogEventConsumer =
  | {
      /** Claims rows and writes the completion column. Only meaningful for a queue. */
      readonly state: 'drains';
      readonly symbol: string;
      readonly note: string;
    }
  | {
      /** Reads the carrier. The right and only state for a register or a trail. */
      readonly state: 'reads';
      readonly symbol: string;
      readonly note: string;
    }
  | {
      readonly state: 'absent';
      readonly reason: string;
      /** The issue that owes it. The `deferred: #NN` device. */
      readonly owedBy: string;
      readonly note: string;
      /**
       * How the gate re-establishes that the absence is STILL true.
       *
       * A census proves a member was classified; it can never prove the
       * classification is TRUE, and "nothing consumes this" is exactly the kind
       * of claim that ages into a lie the moment somebody builds the consumer —
       * silently, because a list of gaps that only ever grows can never report
       * one closing. So every `absent` carries a derivation:
       *
       * - `no_update_of_carrier` — no production module issues an `update`
       *   against the carrier table. A queue is drained by writing its
       *   completion column, so a drain cannot exist without one.
       * - `no_importer_of` — no production module outside the named module
       *   imports it. Used where the reader surface EXISTS and is unreachable.
       */
      readonly probe:
        | { readonly kind: 'no_update_of_carrier' }
        | { readonly kind: 'no_importer_of'; readonly module: string };
    };

/**
 * What a failed attempt does.
 *
 * Declared rather than inferred, because the two directions are asymmetric:
 * treating a permanent failure as retryable burns effort invisibly, and
 * treating a transient one as permanent loses work loudly.
 * `docs/catalog-observability.md` records that **none** of #367's own queues has
 * a dead-letter state, which is why `deadLetter` is a field somebody has to fill
 * in with `false` rather than a property a reader has to go and check.
 */
export interface CatalogEventRetry {
  readonly attempts: 'counted' | 'incremented' | 'not_applicable';
  readonly backoff: 'capped_exponential' | 'none' | 'not_applicable';
  readonly deadLetter: boolean;
  readonly note: string;
}

export interface CatalogEventContract {
  readonly kind: CatalogEventKind;
  /** The SQL table name. Verified to exist in the drizzle schema barrel. */
  readonly table: string;
  /** The drizzle export for that table, used to derive direct writers. */
  readonly tableSymbol: string;
  readonly shape: CatalogEventCarrierShape;
  readonly write: CatalogEventWrite;
  /**
   * Every production module that writes the carrier — through `write.symbol`
   * OR by issuing an `insert`/`update`/`delete` against `tableSymbol` itself.
   *
   * `src`-relative paths, and DERIVED-checked for exact set equality. The union
   * of the two detectors is what makes this real: `enqueueAttributeReindex` has
   * four callers, and the FIFTH writer of that queue
   * (`services/backfill/stages/projections.ts`) never calls it. A census over
   * the repository function alone reports four and is wrong in the direction
   * that reads as tidy.
   */
  readonly producers: readonly string[];
  readonly consumer: CatalogEventConsumer;
  readonly retry: CatalogEventRetry;
  readonly note: string;
}

/* -------------------------------------------------------------------------- */
/* The register                                                               */
/* -------------------------------------------------------------------------- */

export const CATALOG_EVENT_CONTRACTS: Record<CatalogEventKind, CatalogEventContract> = {
  /**
   * A category, product type version, attribute definition version or
   * navigation tree changed lifecycle.
   *
   * The durable record of the ACT is the governance audit trail. The
   * CONSEQUENCE — that every composed authoring schema depending on it must
   * stop being served — is `cache_invalidation`'s carrier, and which action owes
   * which bump is `CATALOG_PUBLICATION_INVALIDATION` below.
   *
   * The trail covers every governance act and not only publication. That is
   * deliberate and is why the producer list is the seven governance services
   * rather than the publish functions: one trail, one place an operator looks,
   * and `catalog_governance_audit_events` is append-only against UPDATE and
   * DELETE so a publication cannot be edited out of it afterwards.
   */
  schema_publication: {
    kind: 'schema_publication',
    table: 'catalog_governance_audit_events',
    tableSymbol: 'catalogGovernanceAuditEvents',
    shape: 'append_only_trail',
    write: {
      by: 'repository',
      symbol: 'recordAuditEvent',
      definedIn: 'db/catalogGovernance/auditRepository.ts',
    },
    producers: [
      'services/catalog-governance/attribute-claim.service.ts',
      'services/catalog-governance/change-request.service.ts',
      'services/catalog-governance/compatibility-claim.service.ts',
      'services/catalog-governance/review.service.ts',
      'services/catalog-governance/role.service.ts',
      'services/catalog-governance/snapshot.service.ts',
      'services/catalog-governance/vertical-package.service.ts',
    ],
    consumer: {
      state: 'reads',
      symbol: 'listAuditEvents',
      note:
        'The operator surface, through controllers/catalog-governance.controller.ts. A trail is ' +
        'read and never drained, so `reads` is the terminal state rather than a gap.',
    },
    retry: {
      attempts: 'not_applicable',
      backoff: 'not_applicable',
      deadLetter: false,
      note:
        'The write commits in the same transaction as the act it records. There is no attempt to ' +
        'retry: a rolled-back act leaves no audit row, which is correct, and a committed one ' +
        'cannot fail separately.',
    },
    note:
      'applyChange itself does NOT record the audit event — change-request.service.ts does, around ' +
      'it. So `producers` is the set of governance services, not the publish functions, and ' +
      'services/catalog-governance/apply.ts is legitimately absent from it.',
  },

  /**
   * A localized string changed — its value, its review status or its
   * provenance.
   *
   * Trigger-written, on purpose. `db/catalogLocalization/revisionRepository.ts`
   * states that there is deliberately no `recordRevision` function, because a
   * second writer would disagree with the triggers the first time a path forgot
   * to call it. `producers` is therefore EMPTY, and the gate asserting it stays
   * empty is what turns that docblock sentence into something that fails.
   */
  translation_change: {
    kind: 'translation_change',
    table: 'catalog_localization_revisions',
    tableSymbol: 'catalogLocalizationRevisions',
    shape: 'append_only_trail',
    write: {
      by: 'database_trigger',
      triggers: [
        'mercaria_attribute_labels_localization_revision',
        'mercaria_attribute_value_localization_revision',
        'mercaria_canonical_product_family_localization_revision',
        'mercaria_canonical_product_localization_revision',
        'mercaria_category_localization_revision',
        'mercaria_listing_localization_revision',
        'mercaria_product_type_field_localization_revision',
        'mercaria_product_type_localization_revision',
      ],
    },
    producers: [],
    consumer: {
      state: 'absent',
      reason:
        'db/catalogLocalization/revisionRepository.ts exports readLocalizationFieldHistory, ' +
        'findLocalizationRevision and rollbackLocalizationField, and NO production module imports ' +
        'it. Every reference outside the repository is a test or a sentence in ' +
        'services/curation/merge-plan.ts. So the trail is write-only: eight triggers fill it and ' +
        'nothing in the running service can show a translator what a string used to say, or roll ' +
        'one back.',
      owedBy: '#367',
      probe: { kind: 'no_importer_of', module: 'db/catalogLocalization/revisionRepository.ts' },
      note:
        'This is the copy-forward defect one domain over (impact-plan.ts records ' +
        'copyForwardProductTypeLocalizations having had zero production callers until #650): a ' +
        'real, correct, realdb-tested surface that nothing reaches. docs/translation-revisions.md ' +
        'defers the HTTP surface to routes/internal-catalog-localization.ts and says it "lands ' +
        'after that PR merges" — that PR (#660) HAS merged and the router exists carrying three ' +
        'GET routes, none of them the history or the rollback, so the precondition is met and the ' +
        'work is not. Recorded rather than fixed here because the route owes decisions this ' +
        'register does not get to make: which governance role may read a translation history, and ' +
        'whether a rollback is a review action (#660\'s own "registers no write verb" gate turns ' +
        'on that answer).',
    },
    retry: {
      attempts: 'not_applicable',
      backoff: 'not_applicable',
      deadLetter: false,
      note:
        'A trigger writes inside the statement that caused it. There is no attempt separate from ' +
        'the localization write itself, so a failure rolls that write back rather than being retried.',
    },
    note:
      'The trail is the HISTORY of a translation change. The CACHE consequence is a separate ' +
      'obligation carried by cache_invalidation: reviewLocalization bumps `localization` in the ' +
      'same transaction as the upsert (#655 — before that the subject had no producer at all and ' +
      'every task served the previous text until it restarted).',
  },

  /**
   * Something has to be re-indexed, and why.
   *
   * The only one of the four that is a QUEUE, and the only one whose consumer
   * being absent is a defect rather than a category error. It has the
   * moderation outbox's shape as far as the schema goes — deterministic id, a
   * lease held all-or-nothing by a CHECK, an attempts counter, a pending index
   * — and nothing claims, completes or increments anything.
   */
  reindex_request: {
    kind: 'reindex_request',
    table: 'attribute_reindex_requests',
    tableSymbol: 'attributeReindexRequests',
    shape: 'durable_queue',
    write: {
      by: 'repository',
      symbol: 'enqueueAttributeReindex',
      definedIn: 'db/attributes/attributeOpsRepository.ts',
    },
    producers: [
      'services/attributes/attribute-observation.service.ts',
      'services/attributes/definition-registry.service.ts',
      'services/attributes/source-mapping.service.ts',
      'services/backfill/stages/projections.ts',
      'services/curation/correction.service.ts',
    ],
    consumer: {
      state: 'absent',
      reason:
        'No claim function exists, no code path writes `processed_at`, and `attempts` is never ' +
        'incremented. listPendingReindexRequests is the only reader with a caller and it is a ' +
        'read-only operator listing (controllers/internal-catalog-attributes.controller.ts). ' +
        'Every row ever enqueued is still pending.',
      owedBy: '#61',
      probe: { kind: 'no_update_of_carrier' },
      note:
        'Gate the loop, never the record: the rows are correct and a consumer can drain the ' +
        'backlog whenever one appears. The absence is already surfaced honestly rather than as a ' +
        'zero — catalog-observability reports the reindex hop `unreachable` and ' +
        '`reindex_throughput` `unmeasured`, and rewire-entry-point-census.test.ts asserts ' +
        'completionWriters(attribute_reindex_requests, processed_at) is empty, which is the ' +
        'direction a list that only grows can never report.',
    },
    retry: {
      attempts: 'counted',
      backoff: 'none',
      deadLetter: false,
      note:
        'The `attempts` column exists and nothing increments it, so it counts nothing today. ' +
        'There is no status column, no dead_letter member and no expires_at — the three ways this ' +
        'queue diverges from moderation_outboxes. A consumer arriving owes all three decisions, ' +
        'and `deadLetter: false` is what stops "we gave up" being reported for work nobody attempts.',
    },
    note:
      'FIVE producers, and the fifth is the one a census over the repository function alone cannot ' +
      'see: services/backfill/stages/projections.ts inserts the table directly, gated by ' +
      'CANONICAL_SEARCH_INDEXING_ENABLED. ATTRIBUTE_ENTITY_KINDS is canonical product and variant ' +
      'only, so no native listing id can appear in entity_id and no publication path can enqueue ' +
      'a row naming one.',
  },

  /**
   * A composed authoring schema must stop being served.
   *
   * A revision per subject, bumped transactionally and read INTO the cache key
   * — not an event pushed at a listener. ADR 0007 D10's own words are
   * "invalidated through transactional outbox events"; the implementation
   * diverged deliberately and `db/schema/catalogAuthoring.ts` argues it: an
   * outbox has a delivery window in which every task still serves the old entry
   * and nothing says so, while an entry composed under revision 4 is
   * unreachable the instant the revision is 5, in every ECS task at once,
   * because no lookup can name it.
   */
  cache_invalidation: {
    kind: 'cache_invalidation',
    table: 'catalog_authoring_schema_invalidations',
    tableSymbol: 'catalogAuthoringSchemaInvalidations',
    shape: 'revision_register',
    write: {
      by: 'repository',
      symbol: 'bumpAuthoringSchemaInvalidation',
      definedIn: 'db/catalogAuthoring/schemaInvalidationRepository.ts',
    },
    producers: [
      'services/catalog-governance/apply.ts',
      'services/catalog-governance/review.service.ts',
      'services/catalog-proposals/review.service.ts',
    ],
    consumer: {
      state: 'reads',
      symbol: 'readAuthoringSchemaRevisions',
      note:
        'services/catalog-authoring/schema.service.ts reads the revisions of the subjects a ' +
        'composition depends on and folds them into the memo key AND the ETag. One indexed read ' +
        'per composition, against a composition that already issues five.',
    },
    retry: {
      attempts: 'not_applicable',
      backoff: 'not_applicable',
      deadLetter: false,
      note:
        'A bump is an ON CONFLICT DO UPDATE in the writer\'s own transaction. It cannot be ' +
        'half-applied and there is nothing to retry: if the write that caused it rolls back, so ' +
        'does the bump, which is the property a delivery queue would not have.',
    },
    note:
      'Every member of AUTHORING_INVALIDATION_SUBJECTS must have a production producer, and the ' +
      'gate derives that rather than trusting this note. `localization` is why: it was declared, ' +
      'folded into the memo key and the ETag, and bumped by NOTHING until #655.',
  },
};

/* -------------------------------------------------------------------------- */
/* Which publication action owes which bump                                   */
/* -------------------------------------------------------------------------- */

/**
 * The invalidation obligation of each governance action, or the reason it has
 * none.
 *
 * Total over `CATALOG_GOVERNANCE_ACTIONS`, so an action added to that
 * vocabulary without a decision about cache invalidation fails the build
 * instead of quietly serving stale schemas. `GUEST_PORTAL_MESSAGE_TRIGGERS` is
 * the precedent; the difference is that this one is verified against the code
 * rather than against a `/\.ts/` shape check.
 *
 * `null` means NO bump is owed, and every `null` here carries a STRUCTURAL
 * reason rather than a judgement: nothing can have composed against a row that
 * did not exist when the composition ran.
 */
export type CatalogPublicationInvalidation = {
  /** The subject bumped in the same call, or `null` if none is owed. */
  readonly bumps: AuthoringInvalidationSubject | null;
  readonly note: string;
};

export const CATALOG_PUBLICATION_INVALIDATION: Record<
  CatalogGovernanceAction,
  CatalogPublicationInvalidation
> = {
  taxonomy_rename: {
    bumps: 'category',
    note:
      'ONE case block in applyChange covers all eight taxonomy actions, so all eight bump ' +
      '`category` and none of them can be edited to skip it without moving out of that block. ' +
      'Nothing bumped this for a taxonomy change before #367 Workstream 12: every open authoring ' +
      'draft went on composing against a category whose lifecycle or slug had moved.',
  },
  taxonomy_move: {
    bumps: 'category',
    note:
      'A move rewrites the browse path and both ancestry arrays, which a composed schema reads ' +
      'through the category it names. Same case block as taxonomy_rename.',
  },
  taxonomy_merge: {
    bumps: 'category',
    note:
      'The loser stops being selectable and its redirect is minted, so a draft composing against ' +
      'it must re-read. Same case block as taxonomy_rename.',
  },
  taxonomy_redirect: {
    bumps: 'category',
    note:
      'A redirect changes where an old id or slug resolves, which the composition follows. Same ' +
      'case block as taxonomy_rename.',
  },
  taxonomy_publish: {
    bumps: 'category',
    note:
      'The lifecycle transition a schema reads for selectability. Same case block as ' +
      'taxonomy_rename, which is why publishing and deprecating cannot diverge here.',
  },
  taxonomy_deprecate: {
    bumps: 'category',
    note:
      'A deprecated category still composes but stops being offered, so the entry must go. Same ' +
      'case block as taxonomy_rename.',
  },
  taxonomy_suppress: {
    bumps: 'category',
    note:
      'Suppression is the strongest of the lifecycle states and the one where serving a stale ' +
      'entry is worst. Same case block as taxonomy_rename.',
  },
  taxonomy_restore: {
    bumps: 'category',
    note:
      'The inverse transition, and it owes the bump for the same reason: an entry composed while ' +
      'the category was suppressed is wrong the moment it is not. Same case block as taxonomy_rename.',
  },
  product_type_publish: {
    bumps: 'product_type',
    note:
      'publishProductTypeVersion bumps NOTHING itself and opens its own transaction; applyChange ' +
      'bumps around it. So a direct product-type publish route, if one is ever added, would skip ' +
      'the bump silently — there is none today, and its only non-governance caller is the ' +
      'vertical-package seed.',
  },
  product_type_deprecate: {
    bumps: 'product_type',
    note: 'The CAS out of `published` and the bump are in the same applyChange transaction.',
  },
  attribute_publish: {
    bumps: 'attribute_values',
    note:
      'publishAttributeDefinition also enqueues one attribute_reindex_requests row per affected ' +
      'entity, which is the reindex_request contract being produced from the publication path. ' +
      'POST /internal/catalog-attributes/.../publish reaches the same function and bumps nothing; ' +
      'apply.ts records that asymmetry as settled for deprecate/retire and explicitly NOT settled ' +
      'for publish, because publish also supersedes the previous active version.',
  },
  attribute_deprecate: {
    bumps: 'attribute_values',
    note:
      'Over-invalidation by design: a composed schema does not render a definition differently ' +
      'once its version leaves `active`, so the bump costs one recomposition and the direct route ' +
      'owes no producer (measured by attribute-lifecycle-invalidation.realdb.test.ts).',
  },
  attribute_retire: {
    bumps: 'attribute_values',
    note:
      'Same reasoning and the same over-invalidation as attribute_deprecate, and the same direct ' +
      'route that bumps nothing. Retire also enqueues a reindex row (reason ' +
      '`definition_deprecated`), so this action produces two of the four contracts at once.',
  },
  navigation_publish: {
    bumps: null,
    note:
      'A navigation tree is not an input to composeAuthoringSchema — no invalidationRefs subject ' +
      'names one, so there is no register row a bump could move. Navigation freshness is the ' +
      'navigation domain\'s own question.',
  },
  navigation_archive: {
    bumps: null,
    note:
      'Same reasoning as navigation_publish: no invalidationRefs subject names a navigation tree, ' +
      'so there is no register row to move and a bump here would be a no-op wearing the look of ' +
      'diligence.',
  },
  definition_snapshot_restore: {
    bumps: null,
    note:
      'restoreDefinitions is INSERT-ONLY: an entity that already exists is reported `divergent` ' +
      'and never overwritten, because a restore that corrected it would undo whatever changed it. ' +
      'Nothing can have composed against a category that did not exist, so no entry is stale. ' +
      'Driven by snapshot.service.ts and refused by applyChange, which is why it is absent from ' +
      'DIRECT_APPLY_ACTIONS.',
  },
  vertical_package_apply: {
    bumps: null,
    note:
      'Insert-only for the same reason and with the same `divergent` ruling. Driven by ' +
      'vertical-package.service.ts, refused by applyChange.',
  },
};
