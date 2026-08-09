/**
 * Shared Column Shapes for the Canonical Commerce Graph (ADR 0002 D16/D19/D25)
 *
 * Every canonical entity type carries the SAME three shapes — a lifecycle, an
 * alias-table row, and a source-link-table row — and ADR 0002 D25 binds them to
 * ONE definition here (the `money()`/`dualMoney()` precedent in `columns.ts`:
 * state the shape once, so a hand-written copy cannot silently diverge). #53
 * owns this file; #54 and #56 build their alias and source-link tables from
 * these same helpers.
 *
 * Like `columns.ts`, this is schema SUPPORT, not a table module: it exports no
 * table and is deliberately not re-exported from the schema barrel.
 *
 * Unlike `money()`, none of these helpers uses computed template-literal keys,
 * so TypeScript infers the returned column set without a type assertion — the
 * one hazard that made `money()` need its pinning test does not exist here.
 */

import { sql } from 'drizzle-orm';
import { doublePrecision, text } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CANONICAL_ALIAS_KINDS,
  CANONICAL_ENTITY_STATUSES,
  SOURCE_LINK_METHODS,
  SOURCE_LINK_STATUSES,
} from '@mercaria/shared-types';
import { asEnumValues } from './columns';
import { sourceRecords } from './provenance';

/**
 * The lifecycle every canonical entity carries (ADR 0002 D12, issue #53).
 *
 * - `status` is ONE stored verdict (the `onboarding_state` precedent): nothing
 *   re-derives it and no boolean sits beside it. Each table adds its own
 *   `checkOneOf(...)` for it — a CHECK needs the table name, which a column
 *   helper does not have.
 * - `firstSeenAt`/`lastSeenAt`/`lastReviewedAt` are OBSERVATION times, distinct
 *   from the row bookkeeping `createdAt`/`updatedAt`: a source observation can
 *   legitimately predate the row that records it.
 * - `pinnedFields` is the `listings.overriddenFields` precedent (ADR 0002 D16):
 *   field names an operator corrected, which ingestion must respect on every
 *   subsequent apply.
 *
 * `mergedIntoId` is NOT here even though every canonical entity has one: a
 * self-referencing foreign key needs the table constant, so each table declares
 * it beside its own `merged`-consistency CHECK.
 */
export function canonicalLifecycleColumns() {
  return {
    status: text({ enum: asEnumValues(CANONICAL_ENTITY_STATUSES) }).notNull().default('active'),
    firstSeenAt: timestamptz()
      .notNull()
      .default(sql`date_trunc('milliseconds', now())`),
    lastSeenAt: timestamptz(),
    lastReviewedAt: timestamptz(),
    /** Field names operator-corrected and PINNED against source re-application. */
    pinnedFields: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  };
}

/**
 * One row of an `<entity>_aliases` table (ADR 0002 D16).
 *
 * The entity FK column is per-table (it needs the parent table constant and its
 * own `cascade`); everything else is stated here. `normalizedAlias` is
 * GENERATED — `lower(btrim(alias))` — so the alias and its lookup key cannot
 * disagree, by construction rather than by call-site discipline. Both functions
 * are IMMUTABLE, which a generated column requires. The column name in the
 * expression is a literal because the helper runs before any table exists to
 * reference; `"alias"` is this helper's own column and is stated once.
 *
 * Deeper normalization (accents, punctuation, legal suffixes) is deliberately
 * NOT in this column: it is application vocabulary that evolves
 * (`services/canonical/normalization.ts`), and baking it into DDL would turn
 * every normalization improvement into a column rewrite that silently drops
 * indexes (see CONVENTIONS.md on generated-column rewrites).
 *
 * Each table adds: its `checkOneOf(... kind ...)`, the
 * `(entity_id, normalized_alias)` unique, and the trigram GIN index (D21).
 */
export function aliasColumns() {
  return {
    /** The alias exactly as observed — display form, never normalized away. */
    alias: text().notNull(),
    normalizedAlias: text()
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim("alias"))`),
    kind: text({ enum: asEnumValues(CANONICAL_ALIAS_KINDS) }).notNull(),
    /** BCP-47 language tag for a `localized_name`, when known. */
    language: text(),
    /**
     * The observation this alias came from, when it was imported rather than
     * operator-entered. `restrict`: an alias citing a source record is a claim
     * about provenance, and the evidence must be able to block a delete.
     */
    sourceRecordId: text().references(() => sourceRecords.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key; ledgered in `deferredForeignKeys.ts`. */
    createdByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  };
}

/**
 * One row of an `<entity>_source_links` table (ADR 0002 D19).
 *
 * The link direction is the anti-circularity rule: canonical rows own NOTHING
 * about sources and source records own nothing about canonical entities — this
 * row, downstream of both, is where a matching decision lives, gets its
 * confidence, and gets reviewed (#59).
 *
 * The entity FK column is per-table (`cascade` — a link is meaningless without
 * its entity). Each table adds: `checkOneOf` for `method` and `status`, the
 * 0–1 `confidence` range CHECK, the partial unique on
 * `(entity_id, source_record_id) WHERE status = 'active'`, and an index on
 * `source_record_id` for the reverse lookup.
 */
export function sourceLinkColumns() {
  return {
    /** `restrict`: the observation history must be able to block a delete. */
    sourceRecordId: text()
      .notNull()
      .references(() => sourceRecords.id, { onDelete: 'restrict' }),
    method: text({ enum: asEnumValues(SOURCE_LINK_METHODS) }).notNull(),
    /** The explainable rule id that produced this link; #58 owns the vocabulary. */
    matchRule: text().notNull(),
    /**
     * 0–1, NULL for deterministic or human decisions — a number appears only on
     * imported/machine-matched links, and never substitutes for evidence.
     */
    confidence: doublePrecision(),
    status: text({ enum: asEnumValues(SOURCE_LINK_STATUSES) }).notNull().default('active'),
    /** An Oxy account id — no foreign key; ledgered in `deferredForeignKeys.ts`. */
    decidedByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  };
}
