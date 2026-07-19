/**
 * FX rates controller (THIN) — the PUBLIC display-side rate endpoint.
 *
 * `GET /rates?base=FAIR&quote=USD,EUR` returns the conversion rates a consumer
 * client uses for dual-currency display. FAIR is canonical and the default base;
 * stored amounts are ALWAYS FAIR and are NEVER mutated by this read path. The
 * service `getRates` never throws (it falls back to last-good/static rates), so
 * display can't break on a transient provider/Redis outage.
 */

import type { Request, Response } from 'express';
import { ALL_CURRENCY_CODES, type CurrencyCode } from '@mercaria/shared-types';
import { getRates as resolveRates } from '../services/fx.service.js';
import { sendSuccess, sendError, ErrorCodes } from '../utils/api-response.js';
import { respondWithError } from '../lib/errors/error-codes.js';
import { log } from '../lib/logger.js';

/** Default quotes when the caller omits `quote`. */
const DEFAULT_QUOTES: readonly CurrencyCode[] = ['USD', 'EUR'];

/** Narrow an arbitrary string to a `CurrencyCode`, or `null` if unsupported. */
function toCurrencyCode(value: string): CurrencyCode | null {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(value) ? (value as CurrencyCode) : null;
}

/** GET /rates — conversion rates for dual-currency display (PUBLIC). */
export async function getRates(req: Request, res: Response): Promise<void> {
  try {
    const base = ((req.query.base as string | undefined) ?? 'FAIR');
    const baseCode = toCurrencyCode(base);
    if (!baseCode) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, `Unsupported base currency: ${base}`, 400);
      return;
    }

    const rawQuote = req.query.quote as string | undefined;
    let quotes: CurrencyCode[];
    if (rawQuote) {
      const tokens = rawQuote.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      const parsed: CurrencyCode[] = [];
      for (const token of tokens) {
        const code = toCurrencyCode(token);
        if (!code) {
          sendError(res, ErrorCodes.VALIDATION_ERROR, `Unsupported quote currency: ${token}`, 400);
          return;
        }
        parsed.push(code);
      }
      quotes = parsed.length > 0 ? parsed : [...DEFAULT_QUOTES];
    } else {
      quotes = [...DEFAULT_QUOTES];
    }

    const { rates, asOf, stale, ttlSeconds } = await resolveRates(baseCode, quotes);
    sendSuccess(res, { base: baseCode, rates, asOf, stale, ttlSeconds });
  } catch (err) {
    log.general.error({ err }, 'Failed to resolve FX rates');
    respondWithError(res, err, 'Failed to resolve exchange rates');
  }
}
