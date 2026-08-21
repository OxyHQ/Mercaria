-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- #589 follow-up: the swap evidence #631 said an operator already had.
--
-- Additive in all three statements — two NULLABLE columns the previously
-- serving image names nowhere, and a CHECK every clause of which is satisfied by
-- a NULL on both sides. Nothing here breaks a write that image performs.
--
-- ## Why a `pre` follows a `post` in the journal, which is unusual
--
-- #631 landed `0110` (`pre`) and `0111` (`post`) together. Those are applied
-- history and are not renamed, renumbered or edited — so this correction is a
-- NEW migration, and its phase is decided by what it does rather than by where
-- it sits. It only ADDS, so `pre` is correct: the columns must exist before the
-- image that writes them serves.
--
-- The two runs stay independent. `--phase=pre` applies `0110` and this file;
-- `--phase=post` applies `0111`, which drops `awin_advertisers.declared_host`
-- and narrows the `awin_link_samples` findings CHECK. Neither statement here
-- touches either object.
--
-- ## It was `0112`, then `0113`, then `0114`, and is REGENERATED each time
--
-- #633, #646 and #657 each took the index this file was sitting on while it was
-- in review. Every time, the `.sql` AND its `meta/NNNN_snapshot.json` were
-- DELETED, `_journal.json` was restored from `origin/main` WHOLESALE (never a
-- resolved hunk), and `db:generate` re-ran against the post-merge snapshot
-- chain. Never renamed: a renamed migration keeps a snapshot that diffs against
-- the wrong parent, and the damage lands on whoever generates NEXT rather than
-- here. A hand-resolved journal is the same failure wearing a tidier diff — two
-- entries at one idx apply cleanly and corrupt the chain silently.
--
-- `bun run build:shared-types` ran before each regeneration and the BUILT
-- `dist/` was probed for the SIBLINGS' own new symbols, not just for this
-- branch's: #646 added `compatibility_endpoint_collapse` and `close_relation`
-- to `shared-types/src/curation.ts`, #657 added `redirect_endpoint_collapse`
-- and `retain_history`. A stale `dist/` renders those closed-value-set CHECKs
-- from the OLD tuples and emits `DROP CONSTRAINT … ADD CONSTRAINT` pairs
-- narrowing somebody else's domain back out, in a diff that looks entirely
-- plausible. The regenerated file was then read in full: three statements, all
-- additive, all this issue's.
--
-- ## What the columns are for, and why they are HOSTS
--
-- #631's detector flags a row whose DESTINATION is one of `AWIN_TRACKING_HOSTS`
-- while its deep link is not, and its stated residual is that such a row cannot
-- be told from a deliberate configuration by inspection — so an operator has to
-- see both values. #631 claimed the offer already carried them. It does not, on
-- exactly the rows that are flagged: a swapped row's deep-link column holds a
-- RETAILER url, `assessAwinTrackingLink` refuses it as `rejected_host`, and
-- `withAssessedAwinTracking` withholds it, so
-- `offers.affiliate_tracking_template` is NULL and only the tracked destination
-- survives.
--
-- HOSTS and not URLs. This schema stores no URL of any kind, because the
-- product-data API key lives in the PATH of a feed URL and
-- `awin-isolation.test.ts` fails the build on any column here whose name reads
-- as one. The evidence does not ask that gate for an exemption: a host has no
-- path and no query, so the hazard is removed rather than excused — and nothing
-- is lost, because a host is exactly what the detector compared.
--
-- The CHECK makes the pair BOUNDED (by the handle length every
-- provider-supplied host in this schema carries), PAIRED (a deep-link host with
-- no destination beside it describes nothing) and EARNED (no example on a
-- snapshot whose swap counter is zero, so a row cannot carry evidence for a
-- finding it did not make).
ALTER TABLE "awin_advertiser_quality" ADD COLUMN "swap_example_destination_host" text;--> statement-breakpoint
ALTER TABLE "awin_advertiser_quality" ADD COLUMN "swap_example_deep_link_host" text;--> statement-breakpoint
ALTER TABLE "awin_advertiser_quality" ADD CONSTRAINT "awin_advertiser_quality_swap_example_check" CHECK (("awin_advertiser_quality"."swap_example_destination_host" is null
           or (length("awin_advertiser_quality"."swap_example_destination_host")
               <= 200
               and "awin_advertiser_quality"."destination_tracking_host" > 0))
          and ("awin_advertiser_quality"."swap_example_deep_link_host" is null
               or (length("awin_advertiser_quality"."swap_example_deep_link_host")
                   <= 200
                   and "awin_advertiser_quality"."swap_example_destination_host" is not null)));