-- oxy:deploy-phase=pre
-- oxy:rollback=restore: affiliate_report_runs_network_check and affiliate_transactions_network_check lose their previous expressions, which this file drops and does not carry — their two-member form is in 0082, where both constraints were created. Re-adding them narrowed is the whole inverse and nothing else is gone: no column, no row and no index is touched, and the widening cannot have rewritten a value. It REFUSES while any row holds the new value, which is the correct refusal rather than a defect: re-narrowing a CHECK over rows the narrower form forbids is exactly the statement a constraint exists to stop. Read affiliate_transactions.network and affiliate_report_runs.network for 'direct' first; if either has rows, the schema rollback is blocked until they are dealt with as commercial records, not deleted to make a DDL statement pass.
-- Widens two CHECKs to admit the `direct` affiliate network. Additive in
-- effect: the new constraint admits a strict superset, so every statement the
-- currently-running code can issue is still admitted while it runs, and the
-- code that writes `direct` cannot ship before the CHECK that permits it.
-- Running it as `post` would leave the new code unable to write the value
-- through the whole rollout window.
--
-- Each pair is a DROP and an ADD because Postgres has no ALTER for a CHECK
-- expression. The window between them holds no constraint at all, which is
-- safe in this direction and would not be in the other: nothing widens what a
-- concurrent writer may store.
ALTER TABLE "affiliate_report_runs" DROP CONSTRAINT "affiliate_report_runs_network_check";--> statement-breakpoint
ALTER TABLE "affiliate_transactions" DROP CONSTRAINT "affiliate_transactions_network_check";--> statement-breakpoint
ALTER TABLE "affiliate_report_runs" ADD CONSTRAINT "affiliate_report_runs_network_check" CHECK ("affiliate_report_runs"."network" in ('awin', 'ebay', 'direct'));--> statement-breakpoint
ALTER TABLE "affiliate_transactions" ADD CONSTRAINT "affiliate_transactions_network_check" CHECK ("affiliate_transactions"."network" in ('awin', 'ebay', 'direct'));