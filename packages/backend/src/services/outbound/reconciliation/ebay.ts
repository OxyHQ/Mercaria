/**
 * eBay commission reconciliation — a NAMED seam that fails closed (#67).
 *
 * **There is no eBay transaction reader and this file does not pretend
 * otherwise.** `resolveAffiliateReportReader('ebay')` answers
 * `network_not_configured`, which is a member of
 * `AFFILIATE_REPORT_FAILURE_REASONS` that exists for exactly this, and no run
 * is opened.
 *
 * ## Why not a stub that returns an empty list
 *
 * Because an empty list and "no conversions this month" are the same value, and
 * a domain whose whole failure mode is a number that is quietly too small would
 * then report a healthy zero forever. #65 already made this mistake impossible
 * to make twice: a search API is not a catalogue, and an absence is not a
 * statement. The same rule at the money layer is stronger — nobody
 * reconciles a publisher statement against a report nobody produced, so the
 * discrepancy would be found by eBay, months later, or not at all.
 *
 * ## What would close it, exactly
 *
 * 1. **An EPN account.** #65 ships the Browse ingestion under `EPN_CAMPAIGN_ID`
 *    and Mercaria has no publisher account behind it; there is nothing to
 *    authenticate a reporting call with.
 * 2. **eBay Partner Network's reporting API.** EPN does not expose transactions
 *    through the Browse credential #65 already holds — it is a separate
 *    programme with its own authorization, its own rate policy and its own
 *    report semantics, and those semantics are what would decide the state map
 *    (EPN's `Earnings` report has no member that means "reversed" in Mercaria's
 *    sense; it restates a period's total).
 * 3. **A state map somebody has read the contract for**, in the shape of
 *    `AWIN_COMMISSION_STATUS_STATES`. Guessing it is what books money on a word
 *    nobody checked.
 *
 * When those exist, this file becomes an `AffiliateReportReader` beside
 * `awin.ts` and NOTHING else in #67 changes: the observation trail, the
 * matching, the postings and the run counters are all network-neutral.
 */

import type { AffiliateReportReaderResolution } from './reader.js';

/** The refusal, as one value, so the poll and a test read the same sentence. */
export const EBAY_REPORT_READER_UNAVAILABLE: AffiliateReportReaderResolution = Object.freeze({
  outcome: 'unavailable',
  reason: 'network_not_configured',
  detail:
    'Mercaria has no eBay Partner Network publisher account and no EPN reporting reader. An ' +
    'empty transaction list is deliberately NOT returned: it is indistinguishable from a month ' +
    'with no conversions, and this domain exists to stop a number being quietly too small. See ' +
    'services/outbound/reconciliation/ebay.ts for the three things that would close it.',
});
