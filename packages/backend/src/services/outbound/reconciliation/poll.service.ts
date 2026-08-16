/**
 * One reconciliation pass: read a network's report, apply every row, record the
 * run (#67 conversion requirements 1–8, reporting item 8).
 *
 * ## A pass is one run PER WINDOW, per account
 *
 * `affiliate_report_runs` is "one request to a network for one window", and the
 * lookback is longer than any network will answer in a single call — 45 days
 * against Awin's 31-day maximum — so a pass over one publisher is two runs. The
 * chunker is #66's and is consumed rather than re-derived, because a chunker
 * off by one at a boundary silently drops a day of commission at every seam and
 * its only symptom is a number that is slightly too small, forever.
 *
 * ## The lookback is long on purpose
 *
 * `AFFILIATE_REPORT_LOOKBACK_DAYS` defaults to 45. A window covering only NEW
 * transactions would never see a correction, and a correction — an approval
 * turning into a reversal weeks later — is the event this whole domain is
 * shaped around. Re-reading a transaction that has not changed is cheap: it is
 * classified `unchanged`, writes no observation row, and moves one timestamp.
 *
 * ## The vacuity floor
 *
 * A run completes only when its five buckets account for exactly what it
 * applied (`affiliate_report_runs_counters_total_check`, and
 * `completeAffiliateReportRun` refuses the same inequality first). On top of
 * that: a window whose report carried rows and from which NOT ONE could be
 * applied FAILS with `response_unreadable`, rather than completing with
 * `seen = 0`. Those two are indistinguishable in a table of counters and mean
 * opposite things — one is a quiet month, the other is a network that renamed a
 * field.
 */

import { randomUUID } from 'node:crypto';
import type {
  AffiliateNetworkId,
  AffiliateReportFailureReason,
} from '@mercaria/shared-types';
import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import type { Database } from '../../../db/postgres.js';
import {
  completeAffiliateReportRun,
  failAffiliateReportRun,
  findRunningAffiliateReportRun,
  openAffiliateReportRun,
  type AffiliateReportCounters,
} from '../../../db/affiliateOutbound/reportRunRepository.js';
import { applyReportedTransaction, type AffiliateApplyRefusal } from './apply.js';
import { awinReportReader, awinReportWindows, logRejectedAwinRow } from './awin.js';
import { EBAY_REPORT_READER_UNAVAILABLE } from './ebay.js';
import type { AffiliateReportReader, AffiliateReportReaderResolution } from './reader.js';

/**
 * The reader for one network.
 *
 * A `switch` over the closed union rather than a mutable registry: two networks
 * are compiled in, and a `registerAffiliateReportReader` would be a production
 * seam existing only so a test could avoid injecting a transport — which is
 * what `createAwinReportReader` already accepts.
 */
export function resolveAffiliateReportReader(
  network: AffiliateNetworkId,
  overrides: { readonly awin?: AffiliateReportReader } = {},
): AffiliateReportReaderResolution {
  switch (network) {
    case 'awin':
      return { outcome: 'reader', reader: overrides.awin ?? awinReportReader };
    case 'ebay':
      return EBAY_REPORT_READER_UNAVAILABLE;
  }
}

/** What one window's run did. */
export interface AffiliateReportRunSummary {
  readonly runId: string;
  readonly accountRef: string;
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly state: 'completed' | 'failed';
  readonly failureReason: AffiliateReportFailureReason | null;
  readonly counters: AffiliateReportCounters;
  /** Rows the reader could not interpret. NOT part of `counters.seen`. */
  readonly rejected: number;
  /** Rows that parsed and could not be applied, by reason. */
  readonly refused: Readonly<Record<AffiliateApplyRefusal, number>>;
}

/** What one pass over one network did. */
export interface AffiliateReconciliationPassResult {
  readonly network: AffiliateNetworkId;
  readonly runs: readonly AffiliateReportRunSummary[];
  /**
   * Why the pass produced no run at all, when it produced none.
   *
   * `network_not_configured` covers both a network with no reader (eBay) and a
   * network with a reader and no account: neither can be recorded as a run,
   * because `affiliate_report_runs.account_ref` names the publisher a report
   * was drawn under and there is none to name. Reporting it here rather than
   * inventing an account ref is what keeps that column honest.
   */
  readonly unavailable: { readonly reason: AffiliateReportFailureReason; readonly detail: string } | null;
  /** Accounts another task was already polling when this pass ran. */
  readonly skippedAccounts: number;
}

const NO_REFUSALS: Readonly<Record<AffiliateApplyRefusal, number>> = Object.freeze({
  currency_restated: 0,
  attribution_unresolvable: 0,
});

/**
 * Run one pass over one network.
 *
 * Exported and callable directly, so an operator surface and a test drive the
 * SAME code the loop drives — a second entry point would be a second answer to
 * what a pass does.
 */
export async function runAffiliateReconciliationPass(
  db: Database,
  input: {
    readonly network: AffiliateNetworkId;
    readonly now?: Date;
    readonly leaseOwner?: string;
    readonly readerOverrides?: { readonly awin?: AffiliateReportReader };
    readonly signal?: AbortSignal;
  },
): Promise<AffiliateReconciliationPassResult> {
  const now = input.now ?? new Date();
  const resolved = resolveAffiliateReportReader(input.network, input.readerOverrides ?? {});
  if (resolved.outcome === 'unavailable') {
    return {
      network: input.network,
      runs: await recordRefusedAttempt(db, {
        network: input.network,
        reason: resolved.reason,
        detail: resolved.detail,
        now,
      }),
      unavailable: { reason: resolved.reason, detail: resolved.detail },
      skippedAccounts: 0,
    };
  }

  const accounts = await resolved.reader.listAccounts(db);
  if (accounts.length === 0) {
    const detail = `No pollable ${input.network} account is registered on this deployment.`;
    return {
      network: input.network,
      runs: await recordRefusedAttempt(db, {
        network: input.network,
        reason: 'network_not_configured',
        detail,
        now,
      }),
      unavailable: { reason: 'network_not_configured', detail },
      skippedAccounts: 0,
    };
  }

  const lookbackMs = Math.max(1, config.affiliateOutbound.reportLookbackDays) * 24 * 60 * 60 * 1_000;
  const windows = awinReportWindows(new Date(now.getTime() - lookbackMs), now);
  const leaseSince = new Date(now.getTime() - Math.max(1_000, config.affiliateOutbound.reportLeaseMs));

  const runs: AffiliateReportRunSummary[] = [];
  let skippedAccounts = 0;

  for (const account of accounts) {
    // The LEASE: another task's live `running` run for this (network, account).
    // A run older than the lease belongs to a task that died and is not allowed
    // to stop the network being polled forever — see `reportRunRepository`.
    const held = await findRunningAffiliateReportRun(db, {
      network: input.network,
      accountRef: account.accountRef,
      since: leaseSince,
    });
    if (held) {
      skippedAccounts += 1;
      continue;
    }

    for (const window of windows) {
      const run = await openAffiliateReportRun(db, {
        network: input.network,
        accountRef: account.accountRef,
        windowFrom: window.from,
        windowTo: window.to,
        now: new Date(),
      });

      const summary = await runOneWindow(db, {
        reader: resolved.reader,
        network: input.network,
        runId: run.id,
        accountRef: account.accountRef,
        window,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      runs.push(summary);

      // A failed window stops this ACCOUNT's pass: a credential that was
      // rejected for January will be rejected for February too, and spending
      // the network's per-minute allowance proving it is a bill nobody asked
      // for.
      if (summary.state === 'failed') break;
    }
  }

  return { network: input.network, runs, unavailable: null, skippedAccounts };
}

/** Read one window and apply every row it carried. */
async function runOneWindow(
  db: Database,
  input: {
    reader: AffiliateReportReader;
    network: AffiliateNetworkId;
    runId: string;
    accountRef: string;
    window: { from: Date; to: Date };
    signal?: AbortSignal;
  },
): Promise<AffiliateReportRunSummary> {
  const base = {
    runId: input.runId,
    accountRef: input.accountRef,
    windowFrom: input.window.from,
    windowTo: input.window.to,
  };

  const read = await input.reader.readWindow({
    db,
    accountRef: input.accountRef,
    from: input.window.from,
    to: input.window.to,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  if (read.outcome === 'failed') {
    await failAffiliateReportRun(db, { id: input.runId, reason: read.reason });
    log.general.warn(
      { network: input.network, accountRef: input.accountRef, reason: read.reason },
      `[AffiliateReconciliation] ${read.detail}`,
    );
    return {
      ...base,
      state: 'failed',
      failureReason: read.reason,
      counters: emptyCounters(),
      rejected: 0,
      refused: NO_REFUSALS,
    };
  }

  for (const rejected of read.rejected) logRejectedAwinRow(rejected);

  const counters = {
    seen: 0,
    created: 0,
    stateChanged: 0,
    amountChanged: 0,
    restated: 0,
    unchanged: 0,
  };
  const refused = { currency_restated: 0, attribution_unresolvable: 0 };
  const now = new Date();

  for (const reported of read.transactions) {
    const applied = await applyReportedTransaction(db, {
      network: input.network,
      reportRunId: input.runId,
      reported,
      now,
    });
    if (applied.outcome === 'refused') {
      refused[applied.reason] += 1;
      log.general.warn(
        {
          network: input.network,
          networkTransactionId: reported.networkTransactionId,
          reason: applied.reason,
        },
        `[AffiliateReconciliation] ${applied.detail}`,
      );
      continue;
    }
    counters.seen += 1;
    switch (applied.kind) {
      case 'first_observation':
        counters.created += 1;
        break;
      case 'state_change':
        counters.stateChanged += 1;
        break;
      case 'amount_change':
        counters.amountChanged += 1;
        break;
      case 'restated':
        counters.restated += 1;
        break;
      case 'unchanged':
        counters.unchanged += 1;
        break;
    }
  }

  const unapplied = read.rejected.length + refused.currency_restated + refused.attribution_unresolvable;
  if (counters.seen === 0 && unapplied > 0) {
    // The vacuity floor: rows arrived and none of them could be applied. A
    // `completed` run with `seen = 0` is what a quiet month looks like, and
    // reporting this as one would hide a network that renamed a field behind a
    // green dashboard.
    await failAffiliateReportRun(db, { id: input.runId, reason: 'response_unreadable' });
    return {
      ...base,
      state: 'failed',
      failureReason: 'response_unreadable',
      counters: emptyCounters(),
      rejected: read.rejected.length,
      refused,
    };
  }

  await completeAffiliateReportRun(db, { id: input.runId, counters });
  return {
    ...base,
    state: 'completed',
    failureReason: null,
    counters,
    rejected: read.rejected.length,
    refused,
  };
}

/**
 * The publisher identity a refused attempt may be recorded under, or `null`.
 *
 * PURE and takes the eBay identity as an ARGUMENT rather than reading `config`,
 * so both branches are measurable — a function that read the environment
 * directly could only ever be tested against whichever branch this deployment
 * happens to be in, which is the half that already works.
 */
export function resolveRefusalAccountRef(
  network: AffiliateNetworkId,
  ebay: { readonly campaignId: string; readonly attributionEnabled: boolean },
): string | null {
  if (network !== 'ebay') return null;
  if (!ebay.attributionEnabled) return null;
  const trimmed = ebay.campaignId.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Record durably that a pass ASKED and was refused before it could poll.
 *
 * #124's rule: a refusal is an OUTCOME. "We never asked" and "we asked and
 * there was nothing to ask with" lead an operator to opposite conclusions, and
 * an absent row says both — including "the loop has never run", which is the
 * reading that lets a broken dispatcher look like a quiet network.
 *
 * A `failed` run rather than a completed one with zero counters: nothing was
 * read, and a completed run is what a genuinely empty window writes. The
 * failure reason carries WHY.
 *
 * ## What it will NOT do is invent an account
 *
 * `account_ref` names the publisher account a report was drawn under, and a
 * placeholder there would make every reader of that column wrong forever. So
 * the row is written only when the deployment HAS an identity for the network
 * that could have been used:
 *
 * - **eBay** — `EPN_CAMPAIGN_ID`, and only when `attributionEnabled` says it is
 *   one EPN could have issued. That id IS Mercaria's publisher identity at
 *   eBay (#65 sends it on every ingestion call), so naming it is accurate.
 * - **Awin** — the refusal is reached only when no account row exists at all,
 *   so there is no publisher id, and the pass result carries the reason
 *   instead. A deployment with no Awin account and no eBay campaign is one
 *   where "nothing is configured" is the whole truth.
 */
async function recordRefusedAttempt(
  db: Database,
  input: {
    network: AffiliateNetworkId;
    reason: AffiliateReportFailureReason;
    detail: string;
    now: Date;
  },
): Promise<readonly AffiliateReportRunSummary[]> {
  const accountRef = resolveRefusalAccountRef(input.network, {
    campaignId: config.ebay.campaignId,
    attributionEnabled: config.ebay.attributionEnabled,
  });
  if (accountRef === null) return [];

  const lookbackMs = Math.max(1, config.affiliateOutbound.reportLookbackDays) * 24 * 60 * 60 * 1_000;
  const windowFrom = new Date(input.now.getTime() - lookbackMs);
  const run = await openAffiliateReportRun(db, {
    network: input.network,
    accountRef,
    windowFrom,
    windowTo: input.now,
    now: input.now,
  });
  await failAffiliateReportRun(db, { id: run.id, reason: input.reason, now: input.now });
  return [
    {
      runId: run.id,
      accountRef,
      windowFrom,
      windowTo: input.now,
      state: 'failed',
      failureReason: input.reason,
      counters: emptyCounters(),
      rejected: 0,
      refused: NO_REFUSALS,
    },
  ];
}

/** All zeroes. A failed run reports what it applied, which is nothing. */
function emptyCounters(): AffiliateReportCounters {
  return { seen: 0, created: 0, stateChanged: 0, amountChanged: 0, restated: 0, unchanged: 0 };
}

/** A lease owner id for one task, stable for the process. */
export function affiliateReconciliationLeaseOwner(): string {
  return `affiliate-reconciliation-${randomUUID()}`;
}
