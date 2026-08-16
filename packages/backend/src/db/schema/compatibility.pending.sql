-- Hand-written statements for the compatibility and automotive-fitment domain
-- (#367 merge-order step 8, ADR 0007 D8).
--
-- NOT APPLIED. This file is a staging area: `bun run db:generate` has not been
-- run on this branch, because the drizzle journal is a single shared file and
-- ADR 0007 D11 serializes the migration slot across the six agents implementing
-- this epic. When the slot arrives, paste each block below into the generated
-- `.sql`, inside its `-- oxy:handwritten-begin=` / `-- oxy:handwritten-end=`
-- markers, and re-verify by grepping the regenerated file for each function and
-- trigger pair — regeneration DROPS every hand-written statement, silently, and
-- a lost trigger applies cleanly and enforces nothing.
--
-- Deploy phase: every statement here is ADDITIVE. The migration carrying them is
-- `-- oxy:deploy-phase=pre`.
--
-- The `-- oxy:handwritten-begin=` / `-- oxy:handwritten-end=` pairs below are
-- NOT a paste aid — `migration-handwritten-markers.test.ts` fails the build on
-- any `CREATE FUNCTION`, `CREATE TRIGGER` or `CREATE CONSTRAINT TRIGGER` in a
-- migration that is not inside one. Pairs match by NAME, nest on a stack, admit
-- no orphans, and no name may be reused within a file. Each name here is the
-- FUNCTION it wraps, matching `0088`'s convention, so the rebase protocol's
-- "grep the regenerated file for each trigger/function pair" is one grep.
--
-- Nine statements in three blocks: three functions and six triggers. Verified
-- against the gate's rules, including a mutation self-test on each rule and on
-- the `CREATE CONSTRAINT TRIGGER` form specifically — `CREATE\s+TRIGGER` does
-- not match it, and `0040_equal_sharon_ventura.sql` is the file that proves it
-- matters: it carries three of them, and the naive matcher sees 3 of its 10
-- statements while missing every constraint trigger and every function.
--
-- Every statement is separated by drizzle's own breakpoint token, in `0088`'s
-- style: appended to the terminating line inside a block, on its own line after
-- the `-- oxy:handwritten-end=` between blocks. When pasting below the generated
-- output, a separator is needed BEFORE the first block too — drizzle-kit does
-- not leave a trailing one.
--
-- **Never write that token in prose, including in this header.** The migrator
-- does a plain `split()` on the raw string BEFORE anything parses a comment, so
-- a quoted mention inside a comment is a live split point: it cuts the comment
-- in two and the tail becomes a chunk of its own, which fails as a syntax
-- error. Measured here — quoting it once in this header took a file that
-- applied 9/9 down to 4/9, and the errors named CREATE TRIGGER statements that
-- were entirely correct. Say "drizzle's breakpoint token" instead.
--
-- **A separator must never land inside a `$$ … $$` body.** The migrator splits
-- the file on the token before it parses anything, so one inside a body cuts a
-- function in half and the halves fail as two statements. Every separator here
-- sits after `$$ LANGUAGE plpgsql;` or after a trigger's own `;`.
--
-- Worth stating precisely, because the obvious reason to do this is not the
-- true one: the un-separated form APPLIES CLEANLY on this stack. The migrator
-- runs `db.execute(sql.raw(chunk))`, which reaches postgres.js as
-- `client.unsafe(query, [])`, and with no parameters postgres.js uses the
-- SIMPLE protocol — which accepts multiple commands in one string. Measured:
-- the un-separated file applied 1/1 and the separated file 9/9, both green.
-- The reasons to separate are therefore that a failure names ONE statement
-- instead of a block of nine, and that the un-separated form works only by
-- leaning on a driver fallback that a `prepare: true`, a parameter, or a
-- different driver would remove.
--
-- Six triggers, in the order they should appear:
--
--   1. mercaria_vehicle_makes_key_freeze
--   2. mercaria_vehicle_models_key_freeze
--   3. mercaria_vehicle_generations_key_freeze
--   4. mercaria_vehicle_configurations_key_freeze
--   5. mercaria_automotive_fitment_ancestry
--   6. mercaria_compatibility_claims_raw_freeze
--
-- ---------------------------------------------------------------------------
-- oxy:handwritten-begin=mercaria_vehicle_key_freeze
-- ---------------------------------------------------------------------------
-- ADR 0007 D1 rule 2: a stable machine key is FROZEN after insert.
--
-- A key exists so seeds, fixtures, external mappings and operator tooling can
-- name a concept without embedding a uuid. Renaming one is therefore not a
-- correction — to every seed and mapping that cited the old key it is
-- indistinguishable from the concept having been deleted and a different one
-- created, and the failure is silent: the mapping stops matching, the import
-- creates a duplicate, and nothing errors. A wrong key is corrected by a MERGE
-- (`status = 'merged'` plus `merged_into_id`), which keeps the loser resolvable.
--
-- One function, four triggers. `TG_TABLE_NAME` is in the message so an operator
-- reading the log knows which of the four ladder levels refused.
CREATE OR REPLACE FUNCTION mercaria_vehicle_key_freeze()
RETURNS trigger AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'a vehicle record''s key is frozen (% %): correct it with a merge, never a rename',
      TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_vehicle_makes_key_freeze
BEFORE UPDATE ON "vehicle_makes"
FOR EACH ROW EXECUTE FUNCTION mercaria_vehicle_key_freeze();--> statement-breakpoint

CREATE TRIGGER mercaria_vehicle_models_key_freeze
BEFORE UPDATE ON "vehicle_models"
FOR EACH ROW EXECUTE FUNCTION mercaria_vehicle_key_freeze();--> statement-breakpoint

CREATE TRIGGER mercaria_vehicle_generations_key_freeze
BEFORE UPDATE ON "vehicle_generations"
FOR EACH ROW EXECUTE FUNCTION mercaria_vehicle_key_freeze();--> statement-breakpoint

CREATE TRIGGER mercaria_vehicle_configurations_key_freeze
BEFORE UPDATE ON "vehicle_configurations"
FOR EACH ROW EXECUTE FUNCTION mercaria_vehicle_key_freeze();
-- oxy:handwritten-end=mercaria_vehicle_key_freeze
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- oxy:handwritten-begin=mercaria_automotive_fitment_ancestry
-- ---------------------------------------------------------------------------
-- `automotive_fitments` names its make at EVERY scope, and the copy must agree
-- with the tree.
--
-- `vehicle_make_id` is denormalized on purpose — "which makes does this part
-- cover" is the first question a fitment surface asks, and without the column
-- that read is a three-level join per row. The cost of the denormalization is
-- that it can DISAGREE with the narrower target, and a fitment claiming a Ford
-- part fits a Volkswagen generation would render perfectly, sit in the make
-- index under Ford, and answer the vehicle picker under Volkswagen.
--
-- A CHECK cannot express this: it may not read another row. So the agreement is
-- a trigger, and it walks whichever pointers the scope shape has set —
-- `automotive_fitments_scope_shape_check` guarantees the ancestors are present
-- for the scope, so each branch below can rely on the level above it.
--
-- BEFORE INSERT OR UPDATE, and it compares rather than repairs: silently
-- rewriting `vehicle_make_id` to match would make a caller's mistake invisible,
-- and the caller is usually an importer whose mapping is wrong for every row in
-- the batch.
CREATE OR REPLACE FUNCTION mercaria_automotive_fitment_ancestry()
RETURNS trigger AS $$
DECLARE
  expected_model_id text;
  expected_generation_id text;
  expected_make_id text;
BEGIN
  IF NEW.vehicle_configuration_id IS NOT NULL THEN
    SELECT generation_id INTO expected_generation_id
    FROM vehicle_configurations WHERE id = NEW.vehicle_configuration_id;
    IF expected_generation_id IS DISTINCT FROM NEW.vehicle_generation_id THEN
      RAISE EXCEPTION 'fitment names configuration % under generation %, which is not its generation',
        NEW.vehicle_configuration_id, NEW.vehicle_generation_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.vehicle_generation_id IS NOT NULL THEN
    SELECT model_id INTO expected_model_id
    FROM vehicle_generations WHERE id = NEW.vehicle_generation_id;
    IF expected_model_id IS DISTINCT FROM NEW.vehicle_model_id THEN
      RAISE EXCEPTION 'fitment names generation % under model %, which is not its model',
        NEW.vehicle_generation_id, NEW.vehicle_model_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.vehicle_model_id IS NOT NULL THEN
    SELECT make_id INTO expected_make_id
    FROM vehicle_models WHERE id = NEW.vehicle_model_id;
    IF expected_make_id IS DISTINCT FROM NEW.vehicle_make_id THEN
      RAISE EXCEPTION 'fitment names model % under make %, which is not its make',
        NEW.vehicle_model_id, NEW.vehicle_make_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_automotive_fitment_ancestry
BEFORE INSERT OR UPDATE ON "automotive_fitments"
FOR EACH ROW EXECUTE FUNCTION mercaria_automotive_fitment_ancestry();
-- oxy:handwritten-end=mercaria_automotive_fitment_ancestry
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- oxy:handwritten-begin=mercaria_compatibility_claims_raw_freeze
-- ---------------------------------------------------------------------------
-- What a source SAID is frozen; only what Mercaria decided about it moves.
--
-- ADR 0007 D7: "a canonical fact never overwrites the claim that disagreed with
-- it — both are retained, which is what makes a correction auditable." That
-- sentence is only true if the claim cannot be edited afterwards, and the edit
-- that would actually happen is not malice: it is a re-import that finds the row
-- and updates every column, quietly replacing the raw text an operator was about
-- to read with a newer source's wording.
--
-- `state`, `unresolved_reason`, `relation_id`, `fitment_id`, the review columns
-- and `updated_at` are what a selection or a review moves, and they are
-- deliberately NOT frozen. A repeat observation from the same source is a NEW
-- claim row whose predecessor becomes `superseded`, which is what keeps the
-- history readable.
--
-- DELETE is refused outright. An unresolved claim is the only evidence that a
-- source published something Mercaria could not read; removing it makes the next
-- import look like the first, and the count an operator uses to tell an
-- unmappable feed from an unmapped one silently resets to zero.
CREATE OR REPLACE FUNCTION mercaria_compatibility_claims_raw_freeze()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compatibility claims are never deleted; a superseded claim keeps its row'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- IS DISTINCT FROM, never <>: `<>` against a NULL yields NULL, and `IF NOT
  -- (...)` treats a NULL condition as false — so the whole guard would silently
  -- permit every edit on any row with a NULL in it, which is most of them.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.subject_product_id IS DISTINCT FROM OLD.subject_product_id
     OR NEW.subject_variant_id IS DISTINCT FROM OLD.subject_variant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.raw_target_text IS DISTINCT FROM OLD.raw_target_text
     OR NEW.raw_qualifier_text IS DISTINCT FROM OLD.raw_qualifier_text
     OR NEW.asserted_by_kind IS DISTINCT FROM OLD.asserted_by_kind
     OR NEW.asserted_by_source_id IS DISTINCT FROM OLD.asserted_by_source_id
     OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id
     OR NEW.source_url IS DISTINCT FROM OLD.source_url
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a compatibility claim records what a source said and is frozen; only its resolution and review may move'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_compatibility_claims_raw_freeze
BEFORE UPDATE OR DELETE ON "compatibility_claims"
FOR EACH ROW EXECUTE FUNCTION mercaria_compatibility_claims_raw_freeze();
-- oxy:handwritten-end=mercaria_compatibility_claims_raw_freeze
