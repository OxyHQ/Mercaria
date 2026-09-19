/**
 * A directly-signed shop's commission — a NAMED seam that fails closed (#67).
 *
 * `direct` is a shop Mercaria contracted with itself: it supplies a product
 * feed and its own tracking URL, and it pays a commission under that contract.
 * Everything #67 already builds is network-neutral and works for it today — the
 * offer carries `affiliate_network = 'direct'`, the redirect admits its
 * approved host, the click row is written on both paths, and
 * `GET /internal/affiliate/report` counts it.
 *
 * **What does not exist is a way to BOOK its commission**, and this file is the
 * refusal rather than a stub. `resolveAffiliateReportReader('direct')` answers
 * `network_not_configured` and no run is opened — `resolveRefusalAccountRef`
 * returns `null` for every network but eBay, so the hourly tick writes no row
 * for this one either.
 *
 * ## Why it is NOT a reader that returns an empty list
 *
 * `ebay.ts`'s argument, unchanged and if anything stronger here: an empty list
 * and "this shop sold nothing this month" are the same value, so a stub would
 * report a healthy zero forever against a partner whose statement nobody
 * reconciled. The whole failure mode of this domain is a number quietly too
 * small.
 *
 * ## Why it is not a POLL either, which is what makes it different from eBay
 *
 * eBay's seam waits on an account and an API that both exist. A directly-signed
 * shop is not an API: its statement arrives as a document on whatever cadence
 * the contract says. So the thing that would close this is not a credential —
 * it is an OPERATOR INGESTION surface, `POST /internal/affiliate/reports/direct`
 * on the payment-operator allow-list, which opens a report run for the window
 * the operator states and drives the SAME apply path
 * (`applyReportedTransaction`) the Awin poll drives.
 *
 * That surface is deliberately not in this change. It needs `runOneWindow`'s
 * read step to become a value rather than a call so both callers share one
 * apply path, and it needs the state map for a contract nobody has signed yet —
 * `AWIN_COMMISSION_STATUS_STATES`' shape, decided by reading the terms rather
 * than guessing which of Mercaria's five states a shop's word means. Booking
 * money on a word nobody checked is the one thing this domain refuses.
 */

import type { AffiliateReportReaderResolution } from './reader.js';

/** The refusal, as one value, so the poll and a test read the same sentence. */
export const DIRECT_REPORT_READER_UNAVAILABLE: AffiliateReportReaderResolution = Object.freeze({
  outcome: 'unavailable',
  reason: 'network_not_configured',
  detail:
    'A directly-signed shop is not polled: it has no reporting API, and its statements arrive ' +
    'as documents under the contract. An empty transaction list is deliberately NOT returned — ' +
    'it is indistinguishable from a month with no conversions. Booking one needs the operator ' +
    'ingestion surface described in services/outbound/reconciliation/direct.ts.',
});
