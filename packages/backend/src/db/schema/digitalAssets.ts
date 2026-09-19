/**
 * The digital DELIVERABLE — #1015 Workstream 1, ADR 0010.
 *
 * Seven tables: `digital_assets` and its immutable `asset_versions`, the
 * `asset_files` one version owns, the `asset_packages` an offer sells with its
 * `asset_package_files` membership, the measured `asset_file_inspections`, and
 * the upload-time `asset_provenance_signals`.
 *
 * They sit ON TOP of the canonical graph and add no column to it. A digital
 * product is a `canonical_products` row with `canonical_variants` exactly like a
 * physical one; what this domain adds is what gets HANDED OVER, which the
 * catalogue has never modelled for anything.
 *
 * ## Why the asset is not the version, and the version is not the file
 *
 * #1015 boundary 8: *"uploading v2 must never silently mutate what v1 was"*. The
 * only structure that makes that true without a rule somebody follows is for the
 * bytes to belong to a row nothing updates. So:
 *
 * - `digital_assets` is the commercial identity and owns NO bytes.
 * - `asset_versions` is one immutable release. A trigger refuses UPDATE of its
 *   identity and content columns once it leaves `draft`, and refuses DELETE
 *   outright once any right names it.
 * - `asset_files` belong to a VERSION. Publishing v2 inserts new rows; v1's rows
 *   are untouched, so v1 is still exactly what it was.
 *
 * The trigger is the load-bearing half and a comment would not have been. #402
 * is the precedent: two ordinary calls laundered a moderation decision because
 * the guard lived in one service and the second call reached the row another way.
 *
 * ## There is NO url column, anywhere, and that is asserted
 *
 * #1015 boundary 3 and 4: a file URL is never the ownership record, and a paid
 * payment does not itself authorize a download. `asset_files.storage_key` is an
 * opaque object-storage key that no response body may carry;
 * `digital-commerce-walls.test.ts` fails the build on any `*_url` column in these
 * tables, because the cheap repair for "the client needs the file" is a permanent
 * URL and it would look like a convenience.
 *
 * ## Measured facts and seller claims are different TABLES
 *
 * #1015 W4: *"store measured metadata separately from seller claims"*. A
 * creator's "optimized for Unreal" lives in the product-type attribute values
 * #367 already owns; the analyzer's "42,180 triangles" lives in
 * `asset_file_inspections` with the processor name and version that produced it.
 * One table with a provenance flag would let a write path set the flag wrongly;
 * two tables cannot be confused by a write path at all.
 *
 * ## No price, no stock, no training flag
 *
 * A price on an asset would be a second answer to what something costs (offers
 * are the first). A stock column would be #1015 boundary 1's fake inventory. A
 * `training_use_allowed` column would imply the permitting value exists — ADR
 * 0010 D14 says it does not and cannot until a separate explicit contract does,
 * and a nullable boolean is exactly how a default becomes negotiable.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  ASSET_FILE_ROLES,
  ASSET_FILE_VISIBILITIES,
  ASSET_FORMAT_KEYS,
  ASSET_INSPECTION_VERDICTS,
  ASSET_PROVENANCE_SIGNAL_KINDS,
  ASSET_SCAN_VERDICTS,
  ASSET_VERSION_STATES,
  DIGITAL_ASSET_STATES,
  DIGITAL_VERTICALS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { stores } from './stores';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog';

/**
 * The largest single file the upload path will accept, in bytes.
 *
 * A CHECK rather than only a service bound, because a byte size is what every
 * storage cost, every worker memory ceiling and every buyer's download estimate
 * is derived from, and a row claiming 9 exabytes would poison all three. 8 GiB
 * is generous for a source `.blend` with 4K textures and far below anything a
 * single HTTP transfer should carry.
 */
export const MAX_ASSET_FILE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * `digital_assets` — the creative work as a COMMERCIAL identity.
 *
 * Owned by a store, and only by a store. A creator on Mercaria is a seller, and
 * #1015 W6 asks to *"treat creators as first-class sellers using existing
 * Mercaria seller/store ownership where possible"* — so there is no
 * `creators` table and no second ownership model. A P2P individual selling a 3D
 * model sells it through the store record every seller already has.
 *
 * `canonical_product_id` is NULLABLE and that is the draft window: a creator
 * uploads files before the catalogue entry exists, and forcing the product first
 * would mean authoring a canonical product for an asset that may never be
 * published.
 */
export const digitalAssets = pgTable(
  'digital_assets',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /**
     * `restrict`, never `cascade`. An asset with sales behind it is a commerce
     * record: deleting the store must fail rather than silently take every
     * buyer's deliverable with it (#1015 W0 question 8).
     */
    canonicalProductId: text().references(() => canonicalProducts.id, {
      onDelete: 'restrict',
    }),
    /** Which vertical's format registry and product profiles apply. */
    vertical: text({ enum: asEnumValues(DIGITAL_VERTICALS) }).notNull(),
    /** Creator-facing title. Display copy; the catalogue owns the public name. */
    title: text().notNull(),
    state: text({ enum: asEnumValues(DIGITAL_ASSET_STATES) })
      .notNull()
      .default('draft'),
    /**
     * The version a new acquisition pins, or NULL when none is publishable yet.
     *
     * Denormalized deliberately, and it is the one column here that a version
     * transition writes: resolving "what would I buy right now" by scanning
     * `asset_versions` for the newest `published` row is a sort on every product
     * page, and the answer has to be a single value anyway because two
     * concurrent publications must not both become current. No foreign key
     * DECLARED here — it would be circular with `asset_versions.asset_id` — and
     * `digital-commerce.realdb.test.ts` is what holds it instead.
     */
    currentVersionId: text(),
    /**
     * FIRST publication, never the row's birthday — `listings.published_at`'s
     * rule (CONVENTIONS.md §Timestamps), for the same reason: `created_at`
     * already holds when the row was written, and two representations of one
     * fact can disagree.
     */
    publishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('digital_assets_state_check', t.state, DIGITAL_ASSET_STATES),
    checkOneOf('digital_assets_vertical_check', t.vertical, DIGITAL_VERTICALS),
    index('digital_assets_store_state_idx').on(t.storeId, t.state),
    index('digital_assets_canonical_product_idx').on(t.canonicalProductId),
  ],
);

/**
 * `asset_versions` — ONE immutable release of an asset.
 *
 * `UNIQUE(asset_id, label)` because a creator referring to "v1.4" in a changelog,
 * a support thread and an order confirmation must mean one release. The label is
 * the creator's own string rather than a parsed semver: #1015 asks for an
 * immutable version identifier and a changelog, not for Mercaria to have an
 * opinion about numbering.
 *
 * `major_version` IS parsed, and separately, because the `same_major_version`
 * update policy has to be answerable in SQL. A creator who numbers releases
 * "spring-2026" gets `major_version` 0 and that policy then behaves as
 * `purchased_version_only` for them — stated in ADR 0010 D4 rather than left to
 * be discovered, since the alternative is a policy whose meaning depends on a
 * string nobody validated.
 */
export const assetVersions = pgTable(
  'asset_versions',
  {
    id: generatedId(),
    assetId: text()
      .notNull()
      .references(() => digitalAssets.id, { onDelete: 'restrict' }),
    /** The creator's own identifier for this release, e.g. `1.4`. */
    label: text().notNull(),
    /**
     * The leading integer of {@link label}, or 0 when it has none.
     *
     * Stored rather than derived at read time, because `same_major_version` is a
     * predicate in the download authorizer's WHERE clause and a function call
     * over a text column there is an index nobody can build.
     */
    majorVersion: integer().notNull().default(0),
    state: text({ enum: asEnumValues(ASSET_VERSION_STATES) })
      .notNull()
      .default('draft'),
    /** What changed, creator-authored. NULL on a first release. */
    changelog: text(),
    /** When this version became `published`. Never restamped. */
    publishedAt: timestamptz(),
    /**
     * Which canonical variant this version's deliverable configuration IS.
     *
     * #1015 boundary 7: `printable`, `game-ready` and `rigged` are genuinely
     * different configurations and may be variants. NULLABLE because the
     * ordinary case is one configuration, and a variant per asset would make
     * every single-deliverable 3D model carry a one-member axis.
     */
    canonicalVariantId: text().references(() => canonicalVariants.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('asset_versions_state_check', t.state, ASSET_VERSION_STATES),
    check('asset_versions_major_check', sql`${t.majorVersion} >= 0`),
    /**
     * A published version has a publication instant and an unpublished one does
     * not — a biconditional, so neither half can drift. `superseded` and
     * `withdrawn` were published once and keep their stamp, which is why the
     * predicate is on the STATES THAT WERE NEVER PUBLISHED rather than on
     * `state = 'published'`.
     */
    check(
      'asset_versions_published_at_check',
      sql`(${t.state} in ('draft', 'processing', 'review')) = (${t.publishedAt} is null)`,
    ),
    uniqueIndex('asset_versions_asset_label_key').on(t.assetId, t.label),
    index('asset_versions_asset_state_idx').on(t.assetId, t.state),
  ],
);

/**
 * `asset_files` — one stored binary belonging to one version.
 *
 * `storage_key` is an opaque object-storage key and is a PROTECTED column
 * (`db/protectedColumns.ts`): `db.select().from(assetFiles)` returns every
 * column, and the first naive port of a buyer-library query is the first time a
 * key that a signed URL can be minted from leaves the process. The exclusion is
 * at the TYPE level, so a serializer reading it fails `tsc`.
 *
 * `content_hash` is SHA-256 of the stored bytes, computed server-side (#1015 W1
 * requirement 7) — never taken from the client, which would make it an
 * attacker-chosen value and the duplicate detector in W8 a thing an attacker
 * controls.
 */
export const assetFiles = pgTable(
  'asset_files',
  {
    id: generatedId(),
    versionId: text()
      .notNull()
      .references(() => assetVersions.id, { onDelete: 'restrict' }),
    /** The name the creator uploaded it under, for the buyer's download. */
    fileName: text().notNull(),
    format: text({ enum: asEnumValues(ASSET_FORMAT_KEYS as readonly string[]) }).notNull(),
    /**
     * The media type VERIFIED from content, not from the extension (#1015 W4
     * requirement 1). A `.stl` that is really a zip is a different thing from
     * what the creator said it was, and the verified value is what the
     * authorizer and the viewer read.
     */
    mediaType: text().notNull(),
    role: text({ enum: asEnumValues(ASSET_FILE_ROLES) }).notNull(),
    visibility: text({ enum: asEnumValues(ASSET_FILE_VISIBILITIES) }).notNull(),
    /**
     * `bigint({ mode: 'number' })` — an 8 GiB ceiling exceeds `integer` by a
     * factor of four, and `CONVENTIONS.md` §Money's reasoning about a silently
     * overflowing count applies to bytes exactly as it does to minor units.
     */
    byteSize: bigint({ mode: 'number' }).notNull(),
    /** Lowercase hex SHA-256, computed server-side. */
    contentHash: text().notNull(),
    /** Opaque storage key. PROTECTED — never serialized. */
    storageKey: text().notNull(),
    scanVerdict: text({ enum: asEnumValues(ASSET_SCAN_VERDICTS) })
      .notNull()
      .default('pending'),
    scanAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('asset_files_format_check', t.format, ASSET_FORMAT_KEYS),
    checkOneOf('asset_files_role_check', t.role, ASSET_FILE_ROLES),
    checkOneOf('asset_files_visibility_check', t.visibility, ASSET_FILE_VISIBILITIES),
    checkOneOf('asset_files_scan_verdict_check', t.scanVerdict, ASSET_SCAN_VERDICTS),
    check(
      'asset_files_byte_size_check',
      sql`${t.byteSize} > 0 and ${t.byteSize} <= ${sql.raw(String(MAX_ASSET_FILE_BYTES))}`,
    ),
    check('asset_files_content_hash_check', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    /**
     * A scan verdict and its instant are a biconditional, for the
     * `asset_versions_published_at_check` reason: a `clean` file with no scan
     * time is a file nobody can prove was scanned.
     */
    check(
      'asset_files_scan_at_check',
      sql`(${t.scanVerdict} = 'pending') = (${t.scanAt} is null)`,
    ),
    /**
     * One file name per version. Two files called `model.stl` in one deliverable
     * is a zip a buyer cannot extract, and the collision is the creator's to
     * resolve at upload rather than the buyer's at download.
     */
    uniqueIndex('asset_files_version_name_key').on(t.versionId, t.fileName),
    index('asset_files_version_role_idx').on(t.versionId, t.role),
    /** W8's exact-duplicate detector reads this. Not unique: legitimate reuse exists. */
    index('asset_files_content_hash_idx').on(t.contentHash),
  ],
);

/**
 * `asset_packages` — the named DELIVERABLE an offer sells.
 *
 * The answer to #1015 boundary 6: a format is not a variant, because several
 * formats belong to one purchased thing. A package is that thing — `printable`
 * is one package containing an STL, a 3MF and a printing note, and the buyer
 * bought the package rather than three files or three formats.
 *
 * A package belongs to an ASSET, not to a version, and its membership names
 * files of a version. That is what lets a creator publish v2 and have the same
 * `printable` package keep selling: the package is the commercial identity of a
 * deliverable, and which bytes it contains is a per-version fact.
 */
export const assetPackages = pgTable(
  'asset_packages',
  {
    id: generatedId(),
    assetId: text()
      .notNull()
      .references(() => digitalAssets.id, { onDelete: 'restrict' }),
    /** Stable machine key, unique per asset: `printable`, `game-ready`. */
    key: text().notNull(),
    /** Buyer-facing name. */
    name: text().notNull(),
    /** Creator's description of what is inside and who it is for. */
    summary: text(),
    /**
     * Whether this package may be acquired at all right now.
     *
     * A creator retiring a package must not revoke anybody's right to it, so
     * this gates NEW acquisition only — the same split `ACQUIRABLE_*` and
     * `DOWNLOADABLE_ASSET_VERSION_STATES` make for versions.
     */
    acquirable: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('asset_packages_asset_key_key').on(t.assetId, t.key),
    index('asset_packages_asset_idx').on(t.assetId),
  ],
);

/**
 * `asset_package_files` — which files of which version a package contains.
 *
 * A junction table and never a `jsonb` id array, per `CONVENTIONS.md` §Arrays:
 * the download authorizer joins BY element on every request, which is precisely
 * the query a jsonb array cannot serve.
 *
 * `version_id` is carried alongside `file_id` even though the file already names
 * its version. It is denormalized on purpose: "which files does package P
 * contain at version V" is the authorizer's whole question, and deriving V
 * through `asset_files` makes it a join the hot path pays on every download.
 * A CHECK cannot tie them across tables, so the download-authorization
 * cases in `digital-commerce.realdb.test.ts` do — a file reachable at a version it
 * does not belong to would make one of them green.
 */
export const assetPackageFiles = pgTable(
  'asset_package_files',
  {
    id: generatedId(),
    packageId: text()
      .notNull()
      .references(() => assetPackages.id, { onDelete: 'cascade' }),
    versionId: text()
      .notNull()
      .references(() => assetVersions.id, { onDelete: 'restrict' }),
    fileId: text()
      .notNull()
      .references(() => assetFiles.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    /** `cascade` above and `restrict` here: a membership row is meaningless
     * without its package and must never take a FILE with it. */
    uniqueIndex('asset_package_files_package_file_key').on(t.packageId, t.fileId),
    index('asset_package_files_package_version_idx').on(t.packageId, t.versionId),
  ],
);

/**
 * `asset_file_inspections` — what the pipeline MEASURED, with what measured it.
 *
 * One row per (file, processor version), not one per file: #1015 W4 requirement
 * 13 asks for the processor name and version *"so results can be recomputed
 * later"*, and overwriting the old row would make a recomputation
 * indistinguishable from the original measurement.
 *
 * Every geometry column is NULLABLE and NULL means "not measured", which is why
 * `verdict` exists beside them. A `0` triangle count and an unmeasured one are
 * different facts, and #1015 W4's closing rule — do not overclaim
 * machine-generated validation — is unholdable if they share a representation.
 */
export const assetFileInspections = pgTable(
  'asset_file_inspections',
  {
    id: generatedId(),
    fileId: text()
      .notNull()
      .references(() => assetFiles.id, { onDelete: 'cascade' }),
    verdict: text({ enum: asEnumValues(ASSET_INSPECTION_VERDICTS) }).notNull(),
    /** The worker that produced this, e.g. `mercaria-mesh-inspect`. */
    processorName: text().notNull(),
    /** Its version, so a result can be attributed and recomputed. */
    processorVersion: text().notNull(),
    triangleCount: bigint({ mode: 'number' }),
    vertexCount: bigint({ mode: 'number' }),
    meshCount: integer(),
    /** Bounding box in millimetres. All three present or all three absent. */
    boundingBoxXMm: integer(),
    boundingBoxYMm: integer(),
    boundingBoxZMm: integer(),
    /** NULL means not determined, which for a printable claim is NOT "yes". */
    watertight: boolean(),
    hasUvMapping: boolean(),
    hasRig: boolean(),
    animationCount: integer(),
    /** Texture files the asset references but does not contain. */
    missingResourceCount: integer(),
    /** Why the verdict is a failure, for the creator's own screen. */
    failureDetail: text(),
    measuredAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('asset_file_inspections_verdict_check', t.verdict, ASSET_INSPECTION_VERDICTS),
    /**
     * A bounding box is three numbers or none. Two of three is a measurement
     * nothing can render and a product page would print as `42 × 17 × —`.
     */
    check(
      'asset_file_inspections_bbox_check',
      sql`(${t.boundingBoxXMm} is null) = (${t.boundingBoxYMm} is null)
          and (${t.boundingBoxYMm} is null) = (${t.boundingBoxZMm} is null)`,
    ),
    check(
      'asset_file_inspections_counts_check',
      sql`coalesce(${t.triangleCount}, 0) >= 0 and coalesce(${t.vertexCount}, 0) >= 0
          and coalesce(${t.meshCount}, 0) >= 0 and coalesce(${t.animationCount}, 0) >= 0
          and coalesce(${t.missingResourceCount}, 0) >= 0`,
    ),
    uniqueIndex('asset_file_inspections_file_processor_key').on(
      t.fileId,
      t.processorName,
      t.processorVersion,
    ),
  ],
);

/**
 * `asset_provenance_signals` — privacy-safe evidence retained at upload (#1015 W8).
 *
 * EVIDENCE, never a verdict. There is no `is_stolen`, no `duplicate_of` and no
 * confidence score, because W8's first requirement is that *"a hash match is
 * evidence, not automatic copyright ownership proof"* — and a column holding a
 * conclusion is how an automatic accusation gets made. What a match produces is
 * a moderation review through the existing abuse-report path, and a human
 * decides.
 *
 * Append-only. A creator cannot delete the fingerprint of something they
 * uploaded, which is the whole value of it to the NEXT creator who is copied.
 */
export const assetProvenanceSignals = pgTable(
  'asset_provenance_signals',
  {
    id: generatedId(),
    versionId: text()
      .notNull()
      .references(() => assetVersions.id, { onDelete: 'restrict' }),
    /**
     * NULL for a signal about the version as a whole.
     *
     * `set null`, not `cascade`: a hash outlives the row that named the bytes, and
     * it is the evidence the NEXT creator who gets copied needs. `CONVENTIONS.md`
     * §Foreign keys warns that `SET NULL` promotes an orphan into a category where
     * NULL already means something, and it is checked here rather than assumed —
     * NULL means "about the version as a whole", which is what a file-scoped
     * signal whose file is gone has in fact become.
     */
    fileId: text().references(() => assetFiles.id, { onDelete: 'set null' }),
    kind: text({ enum: asEnumValues(ASSET_PROVENANCE_SIGNAL_KINDS) }).notNull(),
    /**
     * The signal itself — a hash, a fingerprint, or the creator's own words.
     *
     * One text column for five kinds, and that is not a property bag: every kind
     * is a SINGLE scalar and no reader parses it into fields. A per-kind column
     * set would be four always-NULL columns per row.
     */
    value: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf('asset_provenance_signals_kind_check', t.kind, ASSET_PROVENANCE_SIGNAL_KINDS),
    uniqueIndex('asset_provenance_signals_scope_key').on(t.versionId, t.fileId, t.kind, t.value),
    /** The re-upload sweep's query: "who else has this fingerprint". */
    index('asset_provenance_signals_kind_value_idx').on(t.kind, t.value),
  ],
);
