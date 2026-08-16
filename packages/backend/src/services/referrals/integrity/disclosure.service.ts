/**
 * Disclosure copy, per surface, market and language (#148 "Disclosure and
 * promotion compliance").
 *
 * ## The resolution is MOST SPECIFIC WINS, and it is written out
 *
 * A request for `(video, ES, es)` prefers, in order: the exact pair, then the
 * market-specific default, then the language-specific default, then the
 * universal one. Four steps rather than a scoring function, because a score
 * over two independent dimensions has ties and a tie here means two different
 * sentences are shown to two partners in one market with nothing saying why.
 *
 * ## A disclosure may not claim a relationship
 *
 * `REFERRAL_DISCLOSURE_FORBIDDEN_CLAIMS` is scanned against the copy at
 * PUBLICATION time, and the refusal names the phrase. #148 rules 6–8: a partner
 * is not an employee, not an official store, not a brand representative and not
 * verified — those are #55's relationships to establish, and a marketing
 * program able to grant one by publishing a sentence would be a second answer
 * to a question the relationship layer already answers.
 *
 * The scan is a SUBSTRING match on the case-folded copy, which is deliberately
 * crude: it catches the phrase somebody writes, it does not attempt to catch
 * every paraphrase, and pretending otherwise would be the "aggressive
 * normalizer" mistake `duplicate-signals.ts` names one domain over. What makes
 * it enough is that the copy is short, published by an operator, and versioned
 * with an author on the trail.
 *
 * ## No jurisdiction table
 *
 * Which markets REQUIRE a disclosure is a legal question ADR 0005's open item 1
 * assigns to the legal entity. What is representable is what Mercaria DECIDED
 * to require, per market, on a row with a version and an author behind it — so
 * the decision has provenance whenever it is made, and Mercaria never asserts a
 * legal conclusion nobody gave it.
 */

import {
  REFERRAL_DISCLOSURE_FORBIDDEN_CLAIMS,
  REFERRAL_DISCLOSURE_SURFACES,
  type ReferralDisclosureSurface,
  type ReferralDisclosureView,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { appendReferralEvent } from '../../../db/referrals/eventRepository.js';
import {
  activateDisclosure,
  findActiveDisclosures,
  findDisclosureById,
  insertDisclosureDraft,
  nextDisclosureVersion,
  type ReferralDisclosureRow,
} from '../../../db/referralIntegrity/policyRepository.js';

/** The ONE disclosure key at launch. A code constant, like the policy key. */
export const REFERRAL_DISCLOSURE_KEY = 'referral-partner-disclosure';

/** The wildcard both scope columns use for "any". */
export const DISCLOSURE_ANY = '*';

/** A row, projected. */
export function toDisclosureView(row: ReferralDisclosureRow): ReferralDisclosureView {
  return {
    surface: row.surface as ReferralDisclosureSurface,
    market: row.market,
    language: row.language,
    version: row.version,
    copy: row.copy,
    required: row.required === 'yes',
  };
}

/**
 * The copy for one surface in one market and language, most specific first.
 *
 * `undefined` when nothing is published for that surface at all — an honest
 * absence rather than a fabricated sentence. A partner surface renders "no
 * disclosure text has been published for this surface" and an operator knows
 * to publish one; a default sentence composed in code would be a legal claim
 * with no author.
 */
export function resolveDisclosure(
  rows: readonly ReferralDisclosureRow[],
  input: { surface: ReferralDisclosureSurface; market: string; language: string },
): ReferralDisclosureView | undefined {
  const market = input.market.toUpperCase();
  const language = input.language.toLowerCase();
  const forSurface = rows.filter((row) => row.surface === input.surface);
  const preference: readonly [string, string][] = [
    [market, language],
    [market, DISCLOSURE_ANY],
    [DISCLOSURE_ANY, language],
    [DISCLOSURE_ANY, DISCLOSURE_ANY],
  ];
  for (const [wantMarket, wantLanguage] of preference) {
    const hit = forSurface.find(
      (row) => row.market === wantMarket && row.language === wantLanguage,
    );
    if (hit) return toDisclosureView(hit);
  }
  return undefined;
}

/**
 * Every surface's copy for one market and language — what a partner is given.
 *
 * ONE query, then the resolution per surface in memory: seven surfaces would
 * otherwise be seven round trips, and a partner opening their disclosure page
 * is the commonest read this domain has.
 */
export async function readDisclosuresForPartner(
  input: { market: string; language: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ReferralDisclosureView[]> {
  const rows = await findActiveDisclosures(db, REFERRAL_DISCLOSURE_KEY);
  const out: ReferralDisclosureView[] = [];
  for (const surface of REFERRAL_DISCLOSURE_SURFACES) {
    const hit = resolveDisclosure(rows, { surface, ...input });
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * Every forbidden claim a copy makes.
 *
 * Returns the list rather than a boolean so the refusal can NAME the phrase —
 * an operator told "unrecognized copy" edits at random, and one told
 * "'official store' is a relationship #55 establishes" learns the model.
 */
export function forbiddenClaimsIn(copy: string): readonly string[] {
  const folded = copy.toLowerCase();
  return REFERRAL_DISCLOSURE_FORBIDDEN_CLAIMS.filter((claim) => folded.includes(claim));
}

/** Draft one disclosure version. */
export async function draftDisclosure(input: {
  surface: ReferralDisclosureSurface;
  market?: string;
  language?: string;
  copy: string;
  required?: boolean;
  effectiveFrom: Date;
  actorOxyUserId: string;
}): Promise<ReferralDisclosureView> {
  const copy = input.copy.trim();
  if (copy.length === 0) throw validationError('A disclosure requires copy');
  const claims = forbiddenClaimsIn(copy);
  if (claims.length > 0) {
    throw validationError(
      `A referral disclosure may not claim ${claims.join(', ')} — a partner is not an ` +
        'employee, an official store, a brand representative or verified. Those are ' +
        'relationships #55 establishes, and a disclosure cannot grant one.',
    );
  }

  const market = (input.market ?? DISCLOSURE_ANY).toUpperCase();
  const language = (input.language ?? DISCLOSURE_ANY).toLowerCase();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const version = await nextDisclosureVersion(tx, {
      disclosureKey: REFERRAL_DISCLOSURE_KEY,
      surface: input.surface,
      market,
      language,
    });
    const row = await insertDisclosureDraft(tx, {
      disclosureKey: REFERRAL_DISCLOSURE_KEY,
      version,
      surface: input.surface,
      market,
      language,
      copy,
      required: input.required ?? true,
      effectiveFrom: input.effectiveFrom,
    });
    await appendReferralEvent(tx, {
      subjectType: 'disclosure_requirement',
      subjectId: row.id,
      action: 'disclosure_requirement_drafted',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `${input.surface} ${market}/${language} v${version}`,
    });
    return toDisclosureView(row);
  });
}

/** Publish a draft, superseding the incumbent of its own scope. */
export async function publishDisclosure(input: {
  disclosureId: string;
  actorOxyUserId: string;
  at?: Date;
}): Promise<ReferralDisclosureView> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const existing = await findDisclosureById(tx, input.disclosureId);
    if (!existing) throw notFound('Disclosure version not found');
    if (existing.status !== 'draft') {
      throw conflict(`That version is ${existing.status} and cannot be published again`);
    }
    const row = await activateDisclosure(tx, {
      id: input.disclosureId,
      disclosureKey: existing.disclosureKey,
      surface: existing.surface as ReferralDisclosureSurface,
      market: existing.market,
      language: existing.language,
      publishedByOxyUserId: input.actorOxyUserId,
      at,
    });
    if (!row) throw conflict('That version is no longer a draft');
    await appendReferralEvent(tx, {
      subjectType: 'disclosure_requirement',
      subjectId: row.id,
      action: 'disclosure_requirement_activated',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: `${row.surface} ${row.market}/${row.language} v${row.version}`,
    });
    return toDisclosureView(row);
  });
}
