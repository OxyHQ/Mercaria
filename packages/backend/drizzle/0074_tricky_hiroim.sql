-- oxy:deploy-phase=pre
-- oxy:rollback=accepted: connections.webhook_registration_state is backfilled to 'registered' where webhook_ids is non-empty, and connections_webhook_registration_state_check is widened. The backfill is a derivation from webhook_ids, which is still there, so re-running reproduces it exactly
--
-- #297: give `webhook_registration_state` a success value, and reclassify the
-- rows whose success it could not previously record.
--
-- ## Why `pre`
--
-- The real question, not its paraphrase: does any statement here break a write
-- the CURRENTLY SERVING image performs? It does not. That image writes only
-- `pending` and `dead_letter`, and the widened CHECK accepts both — this is a
-- strictly additive value, so every write the old image can issue still lands.
--
-- ## What the backfill KNOWS, and what it does not
--
-- Existing `pending` rows are genuinely ambiguous: before this migration a
-- successful registration and a connection nobody ever tried wrote the same
-- value. Only rows carrying positive evidence of success are reclassified, and
-- the evidence is the row itself:
--
--   * `cardinality(webhook_ids) > 0` — ids are written in exactly ONE place,
--     `recordConnectionWebhookRegistration`, and only when the attempt's outcome
--     is `reconciled`, i.e. it READ the platform's subscription list. A non-empty
--     array is therefore a registration that reached the platform and recorded
--     what it found, not an inference from something adjacent.
--   * no `connection_webhook_failures` row at all — the attempt refused nothing.
--     Note this is STRICTER than the sweep's predicate, which asks only about
--     RETRYABLE reasons: for deciding whether to spend another attempt "nothing
--     retryable is outstanding" is the right question, but for asserting that a
--     registration SUCCEEDED any refusal at all disqualifies it.
--   * `attempts = 0 AND next_attempt_at IS NULL` — nothing is mid-backoff. A
--     release with a retry scheduled leaves both set; a completion resets them.
--
-- What it CANNOT know is whether those subscriptions are still live on the
-- platform. A merchant, or a sibling connection sharing the callback address,
-- can delete them and nothing in Mercaria observes it (#218). So `registered`
-- asserts "Mercaria completed a registration and recorded these ids", which is
-- exactly what the sweep already believes about the same rows — the backfill
-- widens no claim, it records the one already being acted on.
--
-- Rows with no evidence are LEFT ALONE as `pending`: a connection with no ids
-- never reconciled, and one mid-backoff has work outstanding. Both are what
-- `pending` now means, and guessing either into a success value would put a
-- claim in the column that nothing in the row supports.
--
-- ## The one transient this accepts, stated rather than discovered
--
-- `pre` runs while the OLD image is still serving, and that image emits the
-- registration DTO for any state but `pending` — so during the rollout window a
-- backfilled row is serialized as `registered` to a dashboard that predates the
-- value and renders anything present as "Mercaria is retrying". It is a wrong
-- sentence on one screen, self-correcting when the rollout completes, with no
-- system action behind it.
--
-- The alternative was a `post` backfill, which avoids it and was rejected: a
-- zero-capacity deploy skips `post` entirely, and a stranded backfill leaves
-- every pre-existing healthy connection reading `pending` — which is precisely
-- the ambiguity that makes the "simplify the sweep to everything still pending"
-- mistake catastrophic on WooCommerce, where re-registration RECREATES rather
-- than adopts (#218). A transient sentence is a smaller cost than leaving that
-- armed indefinitely.
--
-- ## On a regeneration
--
-- The two ALTER statements are drizzle-kit's, rendered from
-- `CONNECTOR_WEBHOOK_REGISTRATION_STATES` in the BUILT `@mercaria/shared-types`.
-- The UPDATE below is hand-written and regeneration DROPS it — re-apply it after
-- the constraint pair, never before: it writes a value the old CHECK refuses.
ALTER TABLE "connections" DROP CONSTRAINT "connections_webhook_registration_state_check";--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_webhook_registration_state_check" CHECK ("connections"."webhook_registration_state" in ('pending', 'registered', 'dead_letter'));--> statement-breakpoint
UPDATE "connections"
SET "webhook_registration_state" = 'registered'
WHERE "webhook_registration_state" = 'pending'
  AND cardinality("webhook_ids") > 0
  AND "webhook_registration_attempts" = 0
  AND "webhook_registration_next_attempt_at" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "connection_webhook_failures"
    WHERE "connection_webhook_failures"."connection_id" = "connections"."id"
  );
