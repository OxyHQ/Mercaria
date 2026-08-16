/**
 * Reading Awin's Publisher API transaction report (#67, closing #66's seam).
 *
 * #66 built the two pieces this needs and called neither from anywhere:
 * `splitAwinTransactionWindows` (Awin accepts at most 31 days, and a chunker
 * off by one at the boundary silently drops a day of commission at every seam)
 * and `withAwinNetworkLease` (Awin's 20-calls-per-minute limit is a NETWORK
 * limit, and #67's poll joins the SAME budget rather than opening a second
 * answer to "how hard may Mercaria knock"). Both are consumed here rather than
 * re-derived.
 *
 * ## The money is the part that goes wrong silently
 *
 * Awin publishes `commissionAmount: { amount: 1.2, currency: "GBP" }` — MAJOR
 * units, as a JSON number. Two traps, and the second is the subtle one:
 *
 * 1. `Math.round(value * 100)` is wrong for exactly the values that matter:
 *    `1.005 * 100` is `100.49999999999999`, so a half-penny commission rounds
 *    DOWN by a penny, forever, invisibly. So the value is converted through
 *    #63's `parseFeedMoney`, which does the conversion in STRING arithmetic —
 *    and there is deliberately no second money parser in this repository.
 * 2. `parseFeedMoney` reads a SINGLE separator followed by exactly three digits
 *    as a THOUSANDS separator, because `1.005` is one thousand and five in
 *    every European feed it was written for. That rule is right for a CSV and
 *    catastrophically wrong for a JSON number, where `.` is unambiguously the
 *    decimal point: `1.005` GBP would be read as 1005 GBP, a thousandfold
 *    error. {@link awinAmountText} closes it by appending one zero when — and
 *    only when — the fraction is exactly three digits long, which cannot change
 *    the value and removes the only ambiguity the parser has. Appending
 *    unconditionally would CREATE the ambiguity for `19.99`.
 *
 * Exponent notation (`1e-7`) is refused rather than normalized: the parser
 * cannot read it and a hand-rolled expansion would be the second money parser
 * this module exists to avoid.
 *
 * ## An unrecognised status is a REJECTED ROW, never a guessed state
 *
 * `AWIN_COMMISSION_STATUS_STATES` is the whole map. A status outside it means
 * Awin has published a lifecycle Mercaria has not read, and inventing a state
 * for it would put a commission in `approved` — which books money — on the
 * strength of a word nobody has checked. The row is rejected, named, counted,
 * and the pass carries on: one unreadable row must not cost a whole window.
 *
 * ## What has NOT been verified
 *
 * There is no Awin publisher account on this deployment and no call has ever
 * been made. Every request shape here is built from Awin's published Publisher
 * API documentation, and the first live call is what will confirm the date
 * format and the envelope. The parser is written so that a shape it does not
 * recognise is `response_unreadable` rather than a partial apply, which is what
 * makes that first call safe to attempt.
 */

import {
  ALL_CURRENCY_CODES,
  type AffiliateTransactionState,
  type CurrencyCode,
} from '@mercaria/shared-types';
import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { listPollableAwinAccounts } from '../../../db/awin/awinAccountRepository.js';
import { resolveAwinCredential } from '../../awin/credential.js';
import { withAwinNetworkLease } from '../../awin/network.js';
import { splitAwinTransactionWindows } from '../../awin/reconciliation.js';
import { parseFeedMoney } from '../../feed-import/money.js';
import {
  assertAwinPublisherUrl,
  awinPublisherTransport,
  type AwinPublisherTransport,
} from './awin-transport.js';
import type {
  AffiliateReportAccount,
  AffiliateReportReader,
  AffiliateReportWindowResult,
  RejectedReportRow,
  ReportedAffiliateTransaction,
} from './reader.js';

/**
 * Awin's `commissionStatus` vocabulary, mapped onto Mercaria's.
 *
 * A `Record` over Awin's own words, so an unrecognised one is a MISS rather
 * than a default. Two of the four are worth reading:
 *
 * - **`deleted` becomes `reversed`, not `declined`.** Awin's `deleted` is a
 *   transaction an advertiser removed after the fact, which is money taken
 *   BACK; `declined` is money never granted. They book differently — a reversal
 *   unwinds an accrual and a decline may have nothing to unwind — so collapsing
 *   them would leave an approved commission recognized forever.
 * - **`pending` stays `pending` and books nothing**, which is the whole of the
 *   trust rule this domain enforces.
 */
export const AWIN_COMMISSION_STATUS_STATES: Readonly<Record<string, AffiliateTransactionState>> =
  Object.freeze({
    pending: 'pending',
    approved: 'approved',
    declined: 'declined',
    deleted: 'reversed',
  });

/** How many minutes Mercaria waits on one Awin transactions call. */
const AWIN_TRANSACTIONS_TIMEOUT_MS = 60_000;

/**
 * A JSON number as text `parseFeedMoney` cannot misread.
 *
 * See the module docblock. `null` for anything that is not a plain decimal —
 * an exponent, an infinity, a NaN — because the honest answer to a number this
 * module cannot read exactly is a rejected row.
 */
export function awinAmountText(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const text = String(value);
  // A plain decimal only. `1e-7` and `1e+21` are what `String` produces for the
  // extremes, and both are refused rather than expanded by hand — expanding one
  // would be the second money parser this module exists to avoid.
  if (!/^-?\d+(?:\.\d+)?$/u.test(text)) return null;
  const dot = text.indexOf('.');
  if (dot === -1) return text;
  const fraction = text.slice(dot + 1);
  // ONLY a three-digit fraction, and only one zero. `19.99` must stay `19.99`:
  // padding it to `19.990` would create exactly the ambiguity this closes.
  return fraction.length === 3 ? `${text}0` : text;
}

/** A currency Mercaria can store, or `null`. Narrowed rather than asserted. */
function knownCurrency(value: unknown): CurrencyCode | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return (ALL_CURRENCY_CODES as readonly string[]).includes(upper) ? (upper as CurrencyCode) : null;
}

/** An Awin money object → minor units, or the reason it could not be read. */
function readAwinMoney(
  value: unknown,
): { readonly kind: 'money'; readonly amount: number; readonly currency: CurrencyCode }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'absent' } {
  if (value === null || value === undefined) return { kind: 'absent' };
  if (typeof value !== 'object') return { kind: 'refused', reason: 'money is not an object' };
  const record = value as Record<string, unknown>;
  const currency = knownCurrency(record['currency']);
  if (currency === null) {
    return { kind: 'refused', reason: 'the currency is absent or is one Mercaria cannot store' };
  }
  const amountText = awinAmountText(record['amount']);
  if (amountText === null) {
    return { kind: 'refused', reason: 'the amount is not a plain decimal number' };
  }
  const parsed = parseFeedMoney({
    amountText,
    currencyText: currency,
    defaultCurrency: null,
    minorUnits: false,
  });
  if (parsed.kind === 'refused') {
    return { kind: 'refused', reason: `the amount was refused (${parsed.failure})` };
  }
  const parsedCurrency = knownCurrency(parsed.money.currency);
  if (parsedCurrency === null) {
    return { kind: 'refused', reason: 'the parsed currency is one Mercaria cannot store' };
  }
  return { kind: 'money', amount: parsed.money.amount, currency: parsedCurrency };
}

/** An ISO instant, or `null`. Never a guessed one. */
function readInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A non-empty trimmed string, or `null`. Numbers are rendered, not coerced away. */
function readRef(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * One Awin transaction object → a normalized report row.
 *
 * PURE and exported so every field decision is measurable directly against a
 * fixture of Awin's own documented shape, including the ones that are only
 * reachable through a malformed payload.
 */
export function normalizeAwinTransaction(
  raw: unknown,
):
  | { readonly outcome: 'transaction'; readonly transaction: ReportedAffiliateTransaction }
  | { readonly outcome: 'rejected'; readonly rejected: RejectedReportRow } {
  if (raw === null || typeof raw !== 'object') {
    return {
      outcome: 'rejected',
      rejected: { networkTransactionId: null, reason: 'the entry is not an object' },
    };
  }
  const record = raw as Record<string, unknown>;
  const networkTransactionId = readRef(record['id']);
  if (networkTransactionId === null) {
    return {
      outcome: 'rejected',
      rejected: { networkTransactionId: null, reason: 'the entry carries no transaction id' },
    };
  }

  const statusText = typeof record['commissionStatus'] === 'string'
    ? record['commissionStatus'].trim().toLowerCase()
    : '';
  const mapped = AWIN_COMMISSION_STATUS_STATES[statusText];
  if (mapped === undefined) {
    return {
      outcome: 'rejected',
      rejected: {
        networkTransactionId,
        // The status is echoed because it comes from a CLOSED external
        // vocabulary and is the one value an operator needs in order to widen
        // the map — #63's `observed_token` exception, at the same narrowness.
        reason: `unrecognised commissionStatus (${statusText === '' ? '<absent>' : statusText})`,
      },
    };
  }

  // `paidToPublisher` promotes an EARNED state to `paid` and never a refused
  // one: a transaction Awin paid and later deleted is a clawback, and reading
  // it as `paid` would leave the reversal unbooked while the money is gone.
  const paid = record['paidToPublisher'] === true;
  const state: AffiliateTransactionState =
    paid && (mapped === 'approved' || mapped === 'paid') ? 'paid' : mapped;

  const commission = readAwinMoney(record['commissionAmount']);
  if (commission.kind !== 'money') {
    return {
      outcome: 'rejected',
      rejected: {
        networkTransactionId,
        reason:
          commission.kind === 'absent'
            ? 'the entry carries no commission amount'
            : `commissionAmount: ${commission.reason}`,
      },
    };
  }

  const saleAmount = readAwinMoney(record['saleAmount']);
  if (saleAmount.kind === 'refused') {
    return {
      outcome: 'rejected',
      rejected: { networkTransactionId, reason: `saleAmount: ${saleAmount.reason}` },
    };
  }

  const eventAt = readInstant(record['transactionDate']);
  if (eventAt === null) {
    return {
      outcome: 'rejected',
      rejected: { networkTransactionId, reason: 'transactionDate is absent or unreadable' },
    };
  }

  const clickRefs = record['clickRefs'];
  const clickRef =
    clickRefs !== null && typeof clickRefs === 'object'
      ? readRef((clickRefs as Record<string, unknown>)['clickRef'])
      : null;

  return {
    outcome: 'transaction',
    transaction: {
      networkTransactionId,
      advertiserRef: readRef(record['advertiserId']),
      publisherRef: readRef(record['publisherId']),
      state,
      orderValue:
        saleAmount.kind === 'money'
          ? { amount: saleAmount.amount, currency: saleAmount.currency }
          : null,
      commission: { amount: commission.amount, currency: commission.currency },
      eventAt,
      networkProcessedAt: readInstant(record['validationDate']),
      networkClickRef: clickRef,
    },
  };
}

/**
 * Awin's date parameter format: `YYYY-MM-DDTHH:mm:ss`, no zone suffix.
 *
 * The zone is carried by the separate `timezone=UTC` parameter, which is why
 * the instant is rendered from its UTC parts rather than through
 * `toISOString().slice(...)` — that spelling silently depends on the string
 * ending in `Z`, which is true today and is not a property anybody stated.
 */
export function awinDateParam(instant: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${pad(instant.getUTCFullYear(), 4)}-${pad(instant.getUTCMonth() + 1)}-` +
    `${pad(instant.getUTCDate())}T${pad(instant.getUTCHours())}:` +
    `${pad(instant.getUTCMinutes())}:${pad(instant.getUTCSeconds())}`
  );
}

/** The transactions URL for one publisher and one window. */
export function awinTransactionsUrl(input: {
  baseUrl: string;
  publisherId: string;
  from: Date;
  to: Date;
}): string {
  const url = new URL(`/publishers/${encodeURIComponent(input.publisherId)}/transactions/`, input.baseUrl);
  url.searchParams.set('startDate', awinDateParam(input.from));
  url.searchParams.set('endDate', awinDateParam(input.to));
  url.searchParams.set('timezone', 'UTC');
  return url.toString();
}

/**
 * Classify a non-2xx status.
 *
 * The STATUS first and nothing else, because Awin publishes no error taxonomy
 * this module could key on. A 401 and a 403 are the same operator action (the
 * Publisher API token is wrong or has lost its scope); a 429 is a quota Mercaria
 * spent; everything else is the provider.
 */
function classifyAwinStatus(status: number): {
  reason: 'auth_failure' | 'rate_limited' | 'upstream_unavailable';
} {
  if (status === 401 || status === 403) return { reason: 'auth_failure' };
  if (status === 429) return { reason: 'rate_limited' };
  return { reason: 'upstream_unavailable' };
}

/** Build the reader. The transport is injected so the whole reader is testable. */
export function createAwinReportReader(
  transport: AwinPublisherTransport = awinPublisherTransport,
): AffiliateReportReader {
  return {
    network: 'awin',

    async listAccounts(db): Promise<readonly AffiliateReportAccount[]> {
      const accounts = await listPollableAwinAccounts(db);
      return accounts.map((account) => ({ accountRef: account.publisherId }));
    },

    async readWindow(input): Promise<AffiliateReportWindowResult> {
      // Re-resolved from the publisher id rather than carried as an opaque
      // handle on the account: `awin_accounts_publisher_key` makes the id unique
      // so the lookup is exact, and the reader interface stays free of an
      // `unknown` every implementation would have to cast out of. The list is
      // ACCOUNTS (one per Awin publisher), not advertisers, so it is short.
      const accounts = await listPollableAwinAccounts(input.db);
      const account = accounts.find((row) => row.publisherId === input.accountRef);
      if (!account) {
        return {
          outcome: 'failed',
          reason: 'network_not_configured',
          detail: `No Awin account is registered for publisher ${input.accountRef}.`,
        };
      }

      const credential = resolveAwinCredential(account.publisherApiCredentialRef);
      if (credential.kind === 'unavailable') {
        // BLOCKS, and is never a silent skip: a publisher whose Publisher API
        // token is missing reports no commission at all, which is
        // indistinguishable from a quiet month unless the run says why.
        return {
          outcome: 'failed',
          reason: 'credential_unavailable',
          detail:
            `The Publisher API credential for publisher ${account.publisherId} is unavailable ` +
            `(${credential.reason}: ${credential.detail}).`,
        };
      }

      const url = awinTransactionsUrl({
        baseUrl: config.awin.publisherApiBaseUrl,
        publisherId: account.publisherId,
        from: input.from,
        to: input.to,
      });
      // Before DNS, before a socket, before the credential is composed into a
      // header. See `awin-transport.ts`.
      assertAwinPublisherUrl(url, config.awin.publisherApiBaseUrl);

      let response;
      try {
        response = await withAwinNetworkLease(
          {
            budget: {
              accountId: account.id,
              maxConcurrency: account.maxConcurrency,
              maxCallsPerMinute: account.maxCallsPerMinute,
            },
            leaseOwner: `affiliate-reconciliation-${account.id}`,
          },
          async () =>
            withTimeout(
              transport.get(url, {
                Authorization: `Bearer ${credential.secret}`,
                Accept: 'application/json',
              }),
              AWIN_TRANSACTIONS_TIMEOUT_MS,
            ),
        );
      } catch (err) {
        // A refused lease is `FeedImportRefusal('upstream_status')` — Mercaria
        // declined to make the call. It is reported as `rate_limited` because
        // that is what an operator acts on (wait, or raise the account's
        // allowance), and never as `upstream_unavailable`, which would send
        // somebody to check a service that is answering perfectly well.
        const message = err instanceof Error ? err.message : String(err);
        const rateLimited = message.includes('allowance') || message.includes('concurrency slot');
        return {
          outcome: 'failed',
          reason: rateLimited ? 'rate_limited' : 'upstream_unavailable',
          detail: message,
        };
      }

      if (response.status < 200 || response.status >= 300) {
        const classified = classifyAwinStatus(response.status);
        return {
          outcome: 'failed',
          reason: classified.reason,
          // The STATUS and never the body: an error body from a provider is
          // unbounded text that can echo a request, and the request carries a
          // bearer token.
          detail: `Awin answered HTTP ${String(response.status)} for a transactions window.`,
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        return {
          outcome: 'failed',
          reason: 'response_unreadable',
          detail: 'Awin answered 200 with a body that is not JSON.',
        };
      }

      // Awin documents a bare ARRAY. An object is accepted only when it carries
      // a `transactions` array, because a provider wrapping its own envelope is
      // ordinary; anything else is refused whole rather than partially applied.
      const entries = Array.isArray(payload)
        ? payload
        : payload !== null &&
            typeof payload === 'object' &&
            Array.isArray((payload as Record<string, unknown>)['transactions'])
          ? ((payload as Record<string, unknown>)['transactions'] as unknown[])
          : null;
      if (entries === null) {
        return {
          outcome: 'failed',
          reason: 'response_unreadable',
          detail:
            'Awin answered 200 with a shape this reader does not recognise: neither an array ' +
            'of transactions nor an object carrying one.',
        };
      }

      const transactions: ReportedAffiliateTransaction[] = [];
      const rejected: RejectedReportRow[] = [];
      for (const entry of entries) {
        const normalized = normalizeAwinTransaction(entry);
        if (normalized.outcome === 'transaction') transactions.push(normalized.transaction);
        else rejected.push(normalized.rejected);
      }
      return { outcome: 'read', transactions, rejected };
    },
  };
}

/**
 * Bound one call in wall-clock time.
 *
 * `safeFetch` carries no deadline of its own, and a provider that accepts a
 * connection and never answers would hold a network lease slot until the task
 * restarts — which is a fleet-wide budget spent on nothing.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => { reject(new Error('The Awin Publisher API call timed out.')); },
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The windows one lookback covers, both ends inclusive and contiguous.
 *
 * #66's chunker gives whole UTC DAYS; the last instant of the final day is
 * extended to `23:59:59` so a window's own last day is actually queried. Two
 * adjacent windows are then `…T23:59:59` and the next `…T00:00:00`, which has
 * neither a gap nor an overlap — the property the chunker's own randomized
 * tests assert, preserved through the format conversion.
 */
export function awinReportWindows(from: Date, to: Date): readonly { from: Date; to: Date }[] {
  return splitAwinTransactionWindows(from, to).map((window) => {
    const start = new Date(window.from);
    const end = new Date(window.to);
    end.setUTCHours(23, 59, 59, 0);
    return { from: start, to: end };
  });
}

/** Log a rejected row once, bounded. Exported so the poll and tests share it. */
export function logRejectedAwinRow(rejected: RejectedReportRow): void {
  log.general.warn(
    {
      network: 'awin',
      networkTransactionId: rejected.networkTransactionId,
      reason: rejected.reason,
    },
    '[AffiliateReconciliation] a reported transaction could not be read',
  );
}

/** The reader over the real transport. */
export const awinReportReader = createAwinReportReader();
