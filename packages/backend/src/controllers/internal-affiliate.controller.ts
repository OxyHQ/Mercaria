/**
 * `/internal/affiliate/*` — the affiliate outbound operator surface (#67).
 *
 * ## What this surface can and cannot do
 *
 * It can approve a destination host, revoke one, read one offer's clicks and
 * read the aggregate report. It CANNOT set a click's disposition, delete a
 * click, edit a commission, mark a transaction paid, or name a destination for
 * an offer. Every one of those would be a way to make the record say something
 * that did not happen — and the commission half additionally answers to a
 * balanced ledger whose only correction is a reversing transaction.
 *
 * ## The trace opens from an OFFER and nothing else
 *
 * Not from a person, not from a host, not from a market. "Show me every click
 * that went to this merchant" is an enumeration question, and there is no actor
 * column for "show me everything this shopper did" to be asked with — so the
 * narrow entry point costs nothing and closes the shape of question this domain
 * must not be able to answer.
 */

import type { Request, Response } from 'express';
import { operatorId } from '../middleware/operator-authz.js';
import { conflict, notFound, respondWithError } from '../lib/errors/error-codes.js';
import {
  approveOutboundHost,
  listOutboundHostsForSource,
  revokeOutboundHost,
} from '../db/affiliateOutbound/hostRepository.js';
import {
  countAffiliateOutboundClicks,
  listAffiliateOutboundClicksForOffer,
} from '../db/affiliateOutbound/clickRepository.js';

/** GET /internal/affiliate/hosts?catalogSourceId= — live and revoked. */
export async function listOutboundHostsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { catalogSourceId } = req.query as { catalogSourceId: string };
    const rows = await listOutboundHostsForSource(catalogSourceId);
    res.json({ success: true, data: rows });
  } catch (err) {
    respondWithError(res, err, 'Failed to list outbound hosts');
  }
}

/**
 * POST /internal/affiliate/hosts — approve one host for one source.
 *
 * An already-approved host is a 409 rather than a silent success. The repository
 * converges (`ON CONFLICT DO NOTHING`), so nothing is duplicated either way; the
 * distinction matters because an operator who typed a host and got a 200 would
 * reasonably believe they had just changed something.
 */
export async function approveOutboundHostHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      catalogSourceId: string;
      host: string;
      kind: 'network_redirector' | 'merchant_site';
      reason: string;
    };
    const row = await approveOutboundHost({
      catalogSourceId: body.catalogSourceId,
      host: body.host,
      kind: body.kind,
      reason: body.reason,
      approvedByOxyUserId: operatorId(req),
    });
    if (row === undefined) {
      throw conflict('That host is already approved for this source.');
    }
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    respondWithError(res, err, 'Failed to approve outbound host');
  }
}

/** POST /internal/affiliate/hosts/:id/revoke — attributable, dated, explained. */
export async function revokeOutboundHostHandler(req: Request, res: Response): Promise<void> {
  try {
    const { reason } = req.body as { reason: string };
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? (rawId[0] ?? '') : (rawId ?? '');
    const row = await revokeOutboundHost({
      id,
      revokedByOxyUserId: operatorId(req),
      revokedReason: reason,
    });
    if (row === undefined) {
      // Covers "no such row" and "already revoked" with one answer, because the
      // second is not an error an operator needs distinguished — the outcome
      // they asked for holds either way.
      throw notFound('No live approval with that id.');
    }
    res.json({ success: true, data: row });
  } catch (err) {
    respondWithError(res, err, 'Failed to revoke outbound host');
  }
}

/** GET /internal/affiliate/clicks?offerId= — one offer's recent clicks. */
export async function outboundClickTraceHandler(req: Request, res: Response): Promise<void> {
  try {
    const { offerId, limit } = req.query as unknown as { offerId: string; limit: number };
    const rows = await listAffiliateOutboundClicksForOffer({ offerId, limit });
    res.json({ success: true, data: rows });
  } catch (err) {
    respondWithError(res, err, 'Failed to trace outbound clicks');
  }
}

/**
 * GET /internal/affiliate/report — the click half of #67's reporting.
 *
 * Human clicks, non-human clicks and refusals, over one window, for one
 * network. It returns NO conversion or commission figure and never will from
 * this handler: #37 acceptance 3 forbids deriving a network conversion from a
 * click, and the two must never be divided into a "conversion rate" — a report
 * is revisable for weeks and a click is not, so the ratio would move without
 * either input being wrong. The commission figures are read from
 * `affiliate_transactions` by the reconciliation half, whose source the metric
 * registry already names as `affiliate_reports`.
 */
export async function affiliateReportHandler(req: Request, res: Response): Promise<void> {
  try {
    const { network, from, to } = req.query as unknown as {
      network: string;
      from: Date;
      to: Date;
    };
    const clicks = await countAffiliateOutboundClicks({ from, to, affiliateNetwork: network });
    res.json({
      success: true,
      data: {
        network,
        from: from.toISOString(),
        to: to.toISOString(),
        ...clicks,
      },
    });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the affiliate report');
  }
}
