/**
 * The eBay run's PHASE MACHINE and its cursor — issue #65 reliability 3, and the
 * single most consequential decision in this integration.
 *
 * ## eBay has no catalogue export, so "complete enumeration" has to be EARNED
 *
 * #62 makes retirement conditional on two things agreeing: the adapter said the
 * page completed a full enumeration (`AdapterFetchPage.complete`), and the run's
 * outcome is in `CATALOG_SOURCE_RETIRING_OUTCOMES`. The framework then retires
 * every object the run did not mention. That is exactly right for a feed, whose
 * enumeration IS its catalogue — and it is a catalogue-destroying trap for a
 * search API, because a search enumeration is NOT an enumeration of what
 * Mercaria tracks:
 *
 *  - eBay refuses a search `offset` beyond 10,000, so no query can enumerate
 *    more than that many items whatever cadence it runs at. The provider is
 *    telling you, in an error code, that you have not seen everything.
 *  - An item found last week can be perfectly public today and simply not be in
 *    this week's results — a price change moved it out of a filtered query, a
 *    relevance ranking reordered it past the depth limit, a category was
 *    re-assigned. Absence from a search says nothing about existence.
 *
 * So a DISCOVERY sweep never reports completeness. If it did, the first sweep
 * after a category grew past 10,000 items would retire everything below the cut.
 *
 * ## What DOES earn it: a verification pass over what Mercaria tracks
 *
 * eBay's API License Agreement obliges Mercaria to delete content once the
 * listing is no longer publicly available, and the only way to establish that is
 * to ask eBay about the items Mercaria holds, BY ID. `getItems` answers twenty
 * ids per call, so a source tracking 40,000 items costs 2,000 calls to verify
 * completely — inside a 5,000/day budget.
 *
 * A verification pass that visits EVERY tracked id, and is not truncated by the
 * budget, has established exactly what retirement needs: every item Mercaria
 * believes this source publishes was asked about, and the ones eBay no longer
 * answers for were not re-observed. That pass — and only that pass — sets
 * `complete`.
 *
 * ## The three phases, and why the order is not arbitrary
 *
 * `discovery` → `verify` → done.
 *
 * Discovery first, so items found in this pass are already tracked by the time
 * verification enumerates the cohort and cannot be retired for having been found
 * five minutes too late. Verification last, so `complete` is the final page's to
 * set. A run whose discovery half was truncated carries `truncated` forward and
 * the verification half refuses completeness anyway — which is the honest
 * reading, since the cohort it verified is the one discovery left behind.
 *
 * ## The cursor is JSON and it is OPAQUE to the framework
 *
 * #62 stores and returns it without looking, which is the contract. It is
 * versioned so a deploy landing mid-run does not misread an older shape as a
 * newer one: an unreadable cursor restarts the pass from the beginning, which
 * costs a pass and cannot corrupt anything, where a misread one could claim a
 * completeness nobody established.
 */

/** The phase a run is in. `done` is not stored — it is a `null` next cursor. */
export type EbayRunPhase = 'discovery' | 'verify';

/** The cursor shape, version 1. */
export interface EbayCursor {
  /** Schema version. An unrecognised value restarts the pass. */
  readonly v: 1;
  readonly phase: EbayRunPhase;
  /** Which configured discovery target the sweep is on. */
  readonly targetIndex: number;
  /** The search offset within that target. */
  readonly offset: number;
  /** The last tracked item id verified, exclusive. `null` starts the cohort. */
  readonly afterExternalId: string | null;
  /**
   * When this PASS began, as an ISO instant, stamped on its first page.
   *
   * It is what makes verification cheap and still complete: the cohort it
   * enumerates is every tracked item NOT re-observed since this instant, so a
   * discovery sweep that re-found most of the catalogue leaves only the
   * remainder to ask about by name. The completeness claim is unaffected —
   * every tracked item was either re-observed by discovery or asked about by
   * `getItems`, which is exactly what "the source no longer publishes this" has
   * to rest on.
   *
   * It lives in the CURSOR rather than being read from the run, because a pass
   * spans many pages on possibly different tasks and `AdapterFetchRequest`
   * carries no run start. `null` on a cursor written before this field existed,
   * which verifies the whole cohort — the conservative direction.
   */
  readonly startedAt: string | null;
  /**
   * Whether anything in this pass was cut short — by the call budget, by eBay's
   * offset ceiling, or by a query's own `max_offset`.
   *
   * Carried through both phases, and it is what makes the completeness claim
   * honest rather than optimistic. Once true it never goes false: a pass that
   * was truncated ANYWHERE did not enumerate the source, and a later phase
   * finishing tidily does not undo that.
   */
  readonly truncated: boolean;
}

/** The cursor a fresh pass starts from. */
export const EBAY_INITIAL_CURSOR: EbayCursor = {
  v: 1,
  phase: 'discovery',
  targetIndex: 0,
  offset: 0,
  afterExternalId: null,
  startedAt: null,
  truncated: false,
};

/**
 * Read a stored cursor, or start over.
 *
 * Every unreadable shape — `null`, malformed JSON, a version this build does not
 * know, a negative offset — answers with the initial cursor rather than
 * throwing. A pass that restarts costs one pass; a pass that threw would leave
 * the run failing forever on a value only a deploy could change, and a pass that
 * guessed could claim a completeness nobody established.
 */
export function parseEbayCursor(raw: string | null): EbayCursor {
  if (raw === null) return EBAY_INITIAL_CURSOR;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EBAY_INITIAL_CURSOR;
  }
  if (parsed === null || typeof parsed !== 'object') return EBAY_INITIAL_CURSOR;
  const candidate = parsed as Partial<EbayCursor>;
  if (candidate.v !== 1) return EBAY_INITIAL_CURSOR;
  if (candidate.phase !== 'discovery' && candidate.phase !== 'verify') return EBAY_INITIAL_CURSOR;
  const targetIndex = candidate.targetIndex;
  const offset = candidate.offset;
  if (!Number.isSafeInteger(targetIndex) || (targetIndex ?? -1) < 0) return EBAY_INITIAL_CURSOR;
  if (!Number.isSafeInteger(offset) || (offset ?? -1) < 0) return EBAY_INITIAL_CURSOR;
  const after = candidate.afterExternalId;
  if (after !== null && typeof after !== 'string') return EBAY_INITIAL_CURSOR;
  const startedAt = candidate.startedAt;
  if (startedAt !== null && startedAt !== undefined && typeof startedAt !== 'string') {
    return EBAY_INITIAL_CURSOR;
  }
  return {
    v: 1,
    phase: candidate.phase,
    targetIndex: targetIndex ?? 0,
    offset: offset ?? 0,
    afterExternalId: after ?? null,
    startedAt: startedAt ?? null,
    truncated: candidate.truncated === true,
  };
}

/** Render a cursor for #62 to store. */
export function serializeEbayCursor(cursor: EbayCursor): string {
  return JSON.stringify(cursor);
}

/**
 * May THIS pass claim a complete enumeration?
 *
 * The conjunction, stated once so no caller can assemble a weaker one:
 *
 *  1. It ran the VERIFICATION phase to the end of the cohort. A discovery-only
 *     pass has established nothing about existence.
 *  2. Nothing anywhere in the pass was truncated.
 *  3. #68's refresh MODE entitles it to conclude an absence — `full_snapshot`
 *     and nothing else. A `query_driven` pass enumerates nothing and a
 *     `targeted` one names its own subset, so neither says anything about the
 *     items it did not ask about.
 *
 * Every failure mode this integration has — a budget refusal, an offset ceiling,
 * a disabled query, an auth failure, a rate limit — lands on `false` here, and
 * `false` means #62 retires nothing. That is issue #65 reliability 6 as a single
 * expression rather than a rule spread over six call sites.
 */
export function mayClaimCompleteEnumeration(input: {
  phase: EbayRunPhase;
  cohortExhausted: boolean;
  truncated: boolean;
  mayConclude: boolean;
}): boolean {
  return (
    input.phase === 'verify' && input.cohortExhausted && !input.truncated && input.mayConclude
  );
}
