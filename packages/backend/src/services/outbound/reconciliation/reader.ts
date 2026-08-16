/**
 * What a network's transaction report has to be able to answer (#67).
 *
 * One narrow contract, and the two things it deliberately cannot do are the
 * point:
 *
 * - **A reader cannot answer "nothing happened" by accident.** Its window
 *   result is a discriminated union whose failure branch carries a bounded
 *   `AffiliateReportFailureReason`, so a credential that stopped working, a
 *   quota that was spent and a genuinely quiet week are three different
 *   answers. An implementation that returned an empty list on failure would
 *   report a healthy zero forever — which is exactly the shape a broken
 *   integration takes.
 * - **A reader cannot write anything.** It gets no database handle and returns
 *   plain normalized facts, so the observation trail, the ledger and the run
 *   counters are all the poll's, and an adapter cannot reach past them (#62's
 *   adapter-signature rule, one domain over).
 *
 * `resolveAffiliateReportReader` is the registry, and it is a switch over the
 * closed `AFFILIATE_NETWORK_IDS` union rather than a mutable map: two networks
 * are compiled in, and a runtime registry would be a production seam existing
 * only for a test's convenience (#69's `getConnectorProvider` ruling).
 */

import type {
  AffiliateNetworkId,
  AffiliateReportFailureReason,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../../db/postgres.js';
import type { ObservedAffiliateTransaction } from '../../../db/affiliateOutbound/transactionRepository.js';

/**
 * One transaction a network reported, normalized and NOT yet matched.
 *
 * `Omit`s the four fields Mercaria decides (`network`, the match verdict and
 * its reason, the digest) from the repository's own input type, so a reader
 * that tried to assert an attribution would fail `tsc` rather than be reviewed
 * — the `MerchantOrder` device, applied to an adapter boundary.
 */
export type ReportedAffiliateTransaction = Omit<
  ObservedAffiliateTransaction,
  'network' | 'matchedClickId' | 'matchState' | 'unmatchedReason' | 'contentDigest'
>;

/**
 * A row the reader could not interpret.
 *
 * Recorded rather than dropped: a `rejected` counter says a page dropped eleven
 * rows, and only these say all eleven were the same field a network renamed
 * (#62's `catalog_source_rejections` argument, at a smaller scale). The id is
 * nullable because the row may be unreadable in the field that would name it.
 */
export interface RejectedReportRow {
  readonly networkTransactionId: string | null;
  readonly reason: string;
}

/** One window's read, or the reason there was none. A STRING discriminant. */
export type AffiliateReportWindowResult =
  | {
      readonly outcome: 'read';
      readonly transactions: readonly ReportedAffiliateTransaction[];
      readonly rejected: readonly RejectedReportRow[];
    }
  | {
      readonly outcome: 'failed';
      readonly reason: AffiliateReportFailureReason;
      readonly detail: string;
    };

/** One publisher account a report may be drawn under. */
export interface AffiliateReportAccount {
  /** The network's own publisher id. Recorded on the run; never a secret. */
  readonly accountRef: string;
}

/** How one network's transaction report is read. */
export interface AffiliateReportReader {
  readonly network: AffiliateNetworkId;
  /**
   * Every account this deployment can poll.
   *
   * An EMPTY list means nothing is configured — which the poll reports as such
   * rather than as a completed pass over zero transactions.
   */
  listAccounts(db: DatabaseOrTransaction): Promise<readonly AffiliateReportAccount[]>;
  /**
   * Read one window for one account, both ends inclusive.
   *
   * Takes the `accountRef` rather than an opaque handle, so the interface
   * carries no `unknown` that every implementation would have to cast out of.
   */
  readWindow(input: {
    readonly db: DatabaseOrTransaction;
    readonly accountRef: string;
    readonly from: Date;
    readonly to: Date;
    readonly signal?: AbortSignal;
  }): Promise<AffiliateReportWindowResult>;
}

/** A reader, or the reason this network has none. */
export type AffiliateReportReaderResolution =
  | { readonly outcome: 'reader'; readonly reader: AffiliateReportReader }
  | {
      readonly outcome: 'unavailable';
      readonly reason: AffiliateReportFailureReason;
      readonly detail: string;
    };
