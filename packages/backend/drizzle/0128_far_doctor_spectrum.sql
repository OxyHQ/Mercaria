-- oxy:deploy-phase=pre
--
-- #765: five refusal kinds join `buyer_request_events_kind_check`, so the trail
-- can record a refused instruction, receipt, refund commit, cancellation
-- completion and return cancellation — not only a refused decision.
--
-- `pre` because the widening is strict: every one of the twelve members the
-- serving image writes is still admitted, and the image that writes the five new
-- ones cannot deploy until the CHECK admits them.

ALTER TABLE "buyer_request_events" DROP CONSTRAINT "buyer_request_events_kind_check";--> statement-breakpoint
ALTER TABLE "buyer_request_events" ADD CONSTRAINT "buyer_request_events_kind_check" CHECK ("buyer_request_events"."kind" in ('submitted', 'withdrawn', 'accepted', 'rejected', 'instructions_issued', 'item_received', 'refund_committed', 'refund_settled', 'completed', 'cancelled', 'completion_failed', 'decision_refused', 'completion_refused', 'instructions_refused', 'receipt_refused', 'refund_commit_refused', 'return_cancellation_refused'));
