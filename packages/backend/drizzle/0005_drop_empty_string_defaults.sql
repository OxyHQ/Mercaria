-- oxy:deploy-phase=post
--
-- `stores.description` and `listings.description` carried Mongoose's
-- `default: ''` across. `findSchemaInvariantViolations` — wired into the suite
-- with the Postgres harness in Fase 2 — rejects an empty-string DEFAULT in every
-- Oxy schema, and caught both the first time it ran against a real database.
--
-- Both columns stay NOT NULL: the DTOs declare `description: string` and every
-- writer already supplies `input.description ?? ''`. Only the DEFAULT goes, so
-- an INSERT that omits the column now fails instead of manufacturing a sentinel
-- that makes "absent" and "empty" the same row.
--
-- `post` rather than `pre`: dropping a default NARROWS what an INSERT may omit,
-- so it is only safe once the image that supplies the column explicitly is live.
ALTER TABLE "stores" ALTER COLUMN "description" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "description" DROP DEFAULT;
