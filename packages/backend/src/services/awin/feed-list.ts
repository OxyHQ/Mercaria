/**
 * Reading Awin's feed list — the network's own inventory of what this publisher
 * may download (#66 feed lifecycle 1 and 3).
 *
 * The list is a CSV, so it is parsed with #63's `streamFeedRecords` and not with
 * a second reader. That is issue rule 1 applied to the one file in this domain
 * that is not a product feed: a network's index is still somebody else's CSV,
 * with the same quoting, the same embedded newlines and the same BOM, and a
 * hand-rolled split on commas gets all three wrong in ways that only appear on
 * the advertiser whose name contains one.
 *
 * ## An unreadable row is SEEN, not skipped
 *
 * This is the decision worth reading twice, because the obvious alternative is
 * silently destructive. Discovery infers CLOSURE from absence: an advertiser the
 * list stopped mentioning has left the network. So a row Mercaria cannot fully
 * parse — a membership word Awin added last week, a malformed date — must not
 * be dropped, or the advertiser it names reads as absent and the reconciliation
 * closes a live programme and retires its catalogue.
 *
 * {@link AwinFeedListEntry} therefore has two branches and BOTH carry the
 * advertiser and feed ids: `listing` is a row that was understood, `unreadable`
 * is a row that was seen. Discovery marks both as seen and applies a membership
 * change only from the first.
 */

import { createHash } from 'node:crypto';
import type { AwinFeedListing, AwinMembershipStatus } from '@mercaria/shared-types';
import { MALFORMED_RECORD_FIELD, streamFeedRecords } from '../feed-import/parse/index.js';
import { AWIN_FEED_LIST_PARSE_OPTIONS } from './constants.js';

/**
 * One row of the list: understood, or merely seen.
 *
 * The `unreadable` branch has no membership, no region and no `lastImported` —
 * a discriminated union rather than a listing with optional fields, so a caller
 * cannot apply a membership it does not have without the compiler objecting.
 */
export type AwinFeedListEntry =
  | { readonly kind: 'listing'; readonly listing: AwinFeedListing }
  | {
      readonly kind: 'unreadable';
      readonly advertiserId: string;
      readonly advertiserName: string;
      readonly feedId: string;
      /** A BOUNDED token from a closed external vocabulary, never a whole row. */
      readonly observedToken: string | null;
      readonly reason: 'unknown_membership' | 'missing_identifier';
    };

/** What one list read produced. */
export interface AwinFeedListResult {
  readonly entries: readonly AwinFeedListEntry[];
  /** sha-256 of the list's own bytes — what tells one poll from the next. */
  readonly digest: string;
}

/**
 * How Awin spells a membership, mapped onto Mercaria's own tuple.
 *
 * A TABLE rather than a switch, and it is deliberately not exhaustive over
 * whatever Awin might publish: a word that is not here produces an `unreadable`
 * entry, which is visible, rather than a default, which is not. The one default
 * that would be tempting — `not_joined` — is exactly the wrong one, because it
 * is a real state Awin also reports and the two would become indistinguishable.
 */
const MEMBERSHIP_BY_TOKEN: Readonly<Record<string, AwinMembershipStatus>> = {
  joined: 'joined',
  active: 'joined',
  approved: 'joined',
  pending: 'pending',
  'pending approval': 'pending',
  applied: 'pending',
  notjoined: 'not_joined',
  'not joined': 'not_joined',
  none: 'not_joined',
  declined: 'declined',
  rejected: 'declined',
  suspended: 'suspended',
  paused: 'suspended',
  left: 'left',
  removed: 'left',
  closed: 'left',
};

/**
 * Normalize a header or a token.
 *
 * Awin's list header row is human-facing (`Advertiser ID`, `Last Imported`), so
 * every lookup goes through this rather than through a literal — a provider that
 * changes `Feed ID` to `Feed Id` would otherwise be a silent total failure that
 * reads as an empty network.
 */
function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '');
}

/** Read one field by any of its accepted spellings. */
function field(fields: ReadonlyMap<string, string>, ...names: readonly string[]): string | null {
  for (const name of names) {
    const value = fields.get(name);
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return null;
}

/** A bounded, alphabet-restricted token, safe to carry into a log or a report. */
function boundToken(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.replace(/[^A-Za-z0-9 _./-]/gu, '').slice(0, 32);
  return cleaned === '' ? null : cleaned;
}

/** An ISO-8601 instant, or `null`. Never a guess. */
function readInstant(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readCount(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value.replace(/[\s,._]/gu, ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Read the whole feed list.
 *
 * The bytes are digested as they are consumed, so the digest identifies the
 * list Mercaria actually read rather than a second fetch of it.
 *
 * Nothing here throws on a bad ROW. A list whose bytes cannot be parsed at all
 * raises #63's own `FeedImportRefusal` from the parser, which the caller turns
 * into a recorded poll failure; a row that is merely odd becomes an
 * `unreadable` entry. The two are different failures with different blast
 * radii, and collapsing them would let one advertiser's strange name cost the
 * whole network a discovery pass.
 */
export async function readAwinFeedList(
  bytes: AsyncIterable<Uint8Array>,
): Promise<AwinFeedListResult> {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8');

  async function* text(): AsyncGenerator<string> {
    for await (const chunk of bytes) {
      hash.update(chunk);
      yield decoder.decode(chunk, { stream: true });
    }
    const tail = decoder.decode();
    if (tail !== '') yield tail;
  }

  const entries: AwinFeedListEntry[] = [];
  for await (const record of streamFeedRecords(text(), AWIN_FEED_LIST_PARSE_OPTIONS)) {
    // #63 marks a row it could not split; it is still a row that existed, and
    // it names no advertiser, so it cannot be attributed. Counting it is the
    // caller's business (the digest changes), attributing it is nobody's.
    if (record.fields.has(MALFORMED_RECORD_FIELD)) continue;

    const normalized = new Map<string, string>();
    for (const [key, value] of record.fields) normalized.set(normalizeKey(key), value);

    const advertiserId = field(normalized, 'advertiser_id', 'merchant_id', 'programme_id');
    const feedId = field(normalized, 'feed_id', 'datafeed_id', 'fid');
    const advertiserName =
      field(normalized, 'advertiser_name', 'merchant_name', 'programme_name') ?? '';

    if (advertiserId === null || feedId === null) {
      entries.push({
        kind: 'unreadable',
        advertiserId: advertiserId ?? '',
        advertiserName,
        feedId: feedId ?? '',
        observedToken: null,
        reason: 'missing_identifier',
      });
      continue;
    }

    const membershipToken = field(normalized, 'membership_status', 'membership', 'status');
    const membership =
      membershipToken === null
        ? undefined
        : MEMBERSHIP_BY_TOKEN[membershipToken.trim().toLowerCase()];

    if (membership === undefined) {
      entries.push({
        kind: 'unreadable',
        advertiserId,
        advertiserName,
        feedId,
        observedToken: boundToken(membershipToken),
        reason: 'unknown_membership',
      });
      continue;
    }

    entries.push({
      kind: 'listing',
      listing: {
        advertiserId,
        advertiserName: advertiserName === '' ? `Awin advertiser ${advertiserId}` : advertiserName,
        feedId,
        feedName: field(normalized, 'feed_name', 'datafeed_name') ?? `Feed ${feedId}`,
        membershipStatus: membership,
        primaryRegion: field(normalized, 'primary_region', 'region'),
        language: field(normalized, 'language', 'feed_language'),
        currency: field(normalized, 'currency', 'feed_currency'),
        vertical: field(normalized, 'vertical', 'sector'),
        productCount: readCount(field(normalized, 'no_of_products', 'product_count', 'products')),
        lastImported: readInstant(field(normalized, 'last_imported', 'last_import')),
      },
    });
  }

  return { entries, digest: hash.digest('hex') };
}

/**
 * Has this feed been regenerated since the last pass consumed it?
 *
 * The CHEAP staleness detector: one CSV answers it for the whole network, where
 * the correct one (#63's conditional request) costs a connection per feed. Both
 * are used and neither is redundant — see `awin_feeds`' docblock.
 *
 * An UNKNOWN `Last Imported` answers `true`. A provider that stopped publishing
 * a timestamp has told Mercaria nothing about freshness, and reading silence as
 * "unchanged" would freeze a catalogue at whatever it was the day the column
 * disappeared, with no error anywhere. The conditional request then makes the
 * real decision, at the cost of one request.
 */
export function awinFeedNeedsDownload(input: {
  listedLastImported: string | Date | null;
  importedLastImported: Date | null;
}): boolean {
  if (input.listedLastImported === null) return true;
  if (input.importedLastImported === null) return true;
  const listed =
    input.listedLastImported instanceof Date
      ? input.listedLastImported
      : new Date(input.listedLastImported);
  if (Number.isNaN(listed.getTime())) return true;
  return listed.getTime() > input.importedLastImported.getTime();
}
