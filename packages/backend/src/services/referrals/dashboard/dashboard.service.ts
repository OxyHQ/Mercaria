/**
 * The composed referral partner dashboard (#147 acceptance 1).
 *
 * ## Composed server-side, for #71's reason
 *
 * The parts are separate reads over separate tables in separate orders, and a
 * client joining them drops whatever fell outside its own window — silently, as
 * a hole in a figure somebody is being paid against. Composing here is the only
 * place the join cannot be wrong.
 *
 * ## The owner is a PARAMETER and there is no second way to decide it
 *
 * Every function in this module takes `{ownerType, ownerId}` resolved by the
 * MOUNT — #146's `makeReferralPartnerRouter` shape, where the store mount has
 * already run `requireStorePermission('store:manage')` and the self mount's
 * owner IS `getRequiredOxyUserId(req)`. Nothing here reads a partner id off a
 * query string, a body or a header, and `requirePartner` takes an OWNER and
 * never an id, so a request reaching somebody else's record is
 * unrepresentable rather than refused.
 *
 * ## Nothing in it can be forged by a client
 *
 * #147 acceptance 2. Every number comes from a table no client can write —
 * `referral_touches` (the redirect edge), `referral_conversions` (#144's
 * accrual path), `referral_rewards` and `ledger_entries` (#145's single
 * writer). There is no amount, count or state on any request schema in this
 * domain, so there is nothing for a forged event to arrive in.
 */

import type {
  ReferralPartnerDashboard,
  ReferralPartnerOwnerType,
  ReferralSupportUnavailableReason,
} from '@mercaria/shared-types';
import { notFound } from '../../../lib/errors/error-codes.js';
import { getDb, type DatabaseOrTransaction } from '../../../db/postgres.js';
import { findPartnerByOwner } from '../../../db/referrals/partnerRepository.js';
import { findCodeById, findLinkById } from '../../../db/referrals/instrumentRepository.js';
import { readPartnerStanding } from '../partner-standing.service.js';
import { partnerCodesView, partnerLinksView } from '../read.service.js';
import { readPartnerEarnings } from './earnings.service.js';
import { readPartnerPayoutReadiness } from './payouts.service.js';
import { readProgramOffers } from './programs.service.js';
import {
  defaultPerformanceWindow,
  performanceMetricDefinitions,
  readPartnerPerformance,
} from './performance.service.js';
import { resolveReferralDisclosure } from './disclosure-text.js';
import { assertPartnerSafeProjection } from './partner-projection.js';

/** How many codes the dashboard's instrument section carries. */
const DASHBOARD_CODE_LIMIT = 50;

/** How many links per code it expands. */
const DASHBOARD_LINKS_PER_CODE = 10;

/**
 * What #147's support and dispute section asks for and this increment does not
 * build.
 *
 * Named as VALUES the client switches on rather than left to a document,
 * because the alternative a UI reaches for is a support entry point that leads
 * nowhere — which is worse than one that says the channel does not exist yet.
 *
 * A dispute THREAD needs its own tables (a thread, its messages, its evidence,
 * its decision and its appeal, each append-only with an actor and a reason) and
 * an operator queue to work it, which is #110's shape one domain over and is
 * not a projection. Evidence attachment needs the digest channel #110 and the
 * moderation domain both record as missing. Notifications need an outbound mail
 * transport Mercaria still does not have — #108's empty registry, unchanged.
 */
const SUPPORT_UNAVAILABLE: readonly ReferralSupportUnavailableReason[] = [
  'dispute_thread_not_built',
  'evidence_attachment_not_built',
  'outbound_notification_transport_not_configured',
];

export interface ReferralPartnerOwnerRef {
  ownerType: ReferralPartnerOwnerType;
  ownerId: string;
}

/**
 * Read one owner's whole dashboard.
 *
 * Answers with `partner: undefined` rather than 404 when the owner has never
 * enrolled — `readPartnerStanding`'s decision, for its reason: "you are not a
 * partner yet, here is what you would be agreeing to" is the state the
 * enrollment surface renders, and a 404 makes the first screen of the flow an
 * error.
 */
export async function readReferralPartnerDashboard(
  owner: ReferralPartnerOwnerRef,
  db: DatabaseOrTransaction = getDb(),
  now: Date = new Date(),
): Promise<ReferralPartnerDashboard> {
  const standing = await readPartnerStanding(owner, db);
  const partner = await findPartnerByOwner(db, owner);

  const acceptedTermsVersions = standing.agreement.acceptances.map((row) => row.termsVersion);
  const { offers, limits } = await readProgramOffers(
    {
      ownerType: owner.ownerType,
      acceptedTermsVersions,
      ...(partner ? { partnerId: partner.id } : {}),
    },
    db,
  );

  const window = defaultPerformanceWindow(now);

  if (!partner) {
    // No partner record: there are no instruments, no touches, no rewards and
    // no payouts, and every read below would be a query for rows that cannot
    // exist. The empty shapes are stated explicitly rather than assembled from
    // reads returning nothing, so a future reader can see this is the
    // "not enrolled" branch rather than an outage.
    const dashboard: ReferralPartnerDashboard = {
      enrollment: {
        earningStarted: standing.earningStarted,
        outstanding: standing.outstanding,
        agreementStanding: standing.agreement.standing,
        requiredAgreementVersion: standing.agreement.requiredVersion,
        ...(standing.application ? { applicationState: standing.application.state } : {}),
      },
      programs: offers,
      limits,
      instruments: {
        codes: [],
        links: [],
        disclosureText: resolveReferralDisclosure(undefined).terms.text,
        disclosureVersion: resolveReferralDisclosure(undefined).terms.version,
      },
      performance: emptyPerformance(window),
      earnings: { pendingConversions: 0, byCurrency: [], recentRewards: [], metrics: [] },
      payouts: {
        earningEnabled: false,
        payoutEnabled: false,
        identity: 'pending',
        tax: 'pending',
        payout: 'pending',
        outstanding: standing.outstanding,
        supportedCurrencies: [],
        cadence: 'monthly',
        recentPayouts: [],
      },
      support: { appealAvailable: false, unavailable: SUPPORT_UNAVAILABLE },
    };
    assertPartnerSafeProjection(dashboard, 'readReferralPartnerDashboard(unenrolled)');
    return dashboard;
  }

  const [codes, performance, earnings, payouts] = await Promise.all([
    partnerCodesView({ partnerId: partner.id, limit: DASHBOARD_CODE_LIMIT }),
    readPartnerPerformance(
      { partnerId: partner.id, dimension: 'date', from: window.from, through: window.through },
      db,
    ),
    readPartnerEarnings(partner.id, db),
    readPartnerPayoutReadiness(partner, standing.outstanding, db),
  ]);

  // Links are per code, so the read is per code. Bounded on both axes rather
  // than by a total: a partner with one code and forty links must see all
  // forty, and one with forty codes must not fetch four hundred rows to paint
  // a first screen.
  const links = (
    await Promise.all(
      codes.map((code) =>
        partnerLinksView({ codeId: code.id, limit: DASHBOARD_LINKS_PER_CODE }),
      ),
    )
  ).flat();

  // The disclosure a partner must publish comes from the program their
  // instruments were issued under, not from a deployment default — the version
  // is pinned per program version (#142 field 15) and a partner promoting under
  // two programs may owe two wordings. The first program's is shown; the code
  // list carries `disclosureRequired` per instrument.
  const disclosureVersion = offers[0]?.program.disclosureVersion;
  const disclosure = resolveReferralDisclosure(disclosureVersion);

  const dashboard: ReferralPartnerDashboard = {
    partner: {
      id: partner.id,
      displayName: partner.displayName,
      ownerType: partner.ownerType,
      state: partner.state,
      appealState: partner.appealState,
    },
    enrollment: {
      earningStarted: standing.earningStarted,
      outstanding: standing.outstanding,
      agreementStanding: standing.agreement.standing,
      requiredAgreementVersion: standing.agreement.requiredVersion,
      ...(standing.application ? { applicationState: standing.application.state } : {}),
    },
    programs: offers,
    limits,
    instruments: {
      codes,
      links,
      disclosureText: disclosure.terms.text,
      disclosureVersion: disclosure.terms.version,
    },
    performance,
    earnings,
    payouts,
    support: {
      // An appeal is openable exactly when there is something to appeal and no
      // appeal is already open — #146's own rule, read off the standing rather
      // than re-derived, because two answers to "may I appeal" is how a button
      // appears that the endpoint then refuses.
      appealAvailable:
        (partner.state === 'suspended' || partner.state === 'terminated') &&
        partner.appealState === 'none',
      unavailable: SUPPORT_UNAVAILABLE,
    },
  };

  assertPartnerSafeProjection(dashboard, 'readReferralPartnerDashboard');
  return dashboard;
}

/**
 * The empty breakdown an owner with no partner record gets.
 *
 * It still carries the metric DEFINITIONS: an enrollment screen explaining what
 * a partner would be measured on is exactly where the definitions earn their
 * place, and shipping them only once there are numbers would mean the one
 * reader who has not yet agreed to anything is the one who cannot read the
 * terms of measurement.
 */
function emptyPerformance(window: { from: string; through: string }) {
  return {
    dimension: 'date' as const,
    from: window.from,
    through: window.through,
    rows: [],
    totals: { humanClicks: 0, qualifiedConversions: 0 },
    withheldRowCount: 0,
    metrics: performanceMetricDefinitions(),
  };
}

/**
 * The partner's own instrument list, for the link-and-code tool.
 *
 * Separate from the dashboard because the tool pages and the dashboard does
 * not: a partner with three hundred codes needs a cursor, and a first paint
 * needs fifty rows.
 */
export async function readPartnerInstruments(
  owner: ReferralPartnerOwnerRef,
  input: { limit?: number; before?: Date },
  db: DatabaseOrTransaction = getDb(),
) {
  const partner = await findPartnerByOwner(db, owner);
  if (!partner) return { codes: [], links: [] };
  const codes = await partnerCodesView({
    partnerId: partner.id,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.before !== undefined ? { before: input.before } : {}),
  });
  const links = (
    await Promise.all(
      codes.map((code) => partnerLinksView({ codeId: code.id, limit: DASHBOARD_LINKS_PER_CODE })),
    )
  ).flat();
  const projection = { codes, links };
  assertPartnerSafeProjection(projection, 'readPartnerInstruments');
  return projection;
}

/**
 * Does this owner hold this instrument?
 *
 * A code id arrives from a client on the retire/revoke routes — it has to, since
 * that is what names the instrument — so this is the one place in the domain
 * where an id is compared rather than derived. The comparison is against the
 * OWNER the mount supplied, so the worst a forged id achieves is a 404.
 *
 * It reads the instrument BY ID and compares its partner, rather than listing
 * the owner's instruments and looking for the id in them. The first version did
 * the latter and it was WRONG in the quiet direction: the list was capped at 500
 * codes (and, for a link, 200 links per code), so a partner with more
 * instruments than the cap was answered 404 for one of their OWN — a refusal
 * indistinguishable from the one this function exists to give. It was also up to
 * 501 statements for a single revoke.
 */
export async function assertOwnsCode(
  owner: ReferralPartnerOwnerRef,
  codeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ partnerId: string }> {
  const partner = await findPartnerByOwner(db, owner);
  if (!partner) throw notFoundCode();
  const code = await findCodeById(db, codeId);
  if (!code || code.partnerId !== partner.id) throw notFoundCode();
  return { partnerId: partner.id };
}

/** The same for a link, reached through the code that owns it. */
export async function assertOwnsLink(
  owner: ReferralPartnerOwnerRef,
  linkId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ partnerId: string }> {
  const partner = await findPartnerByOwner(db, owner);
  if (!partner) throw notFoundCode();
  const link = await findLinkById(db, linkId);
  if (!link) throw notFoundCode();
  const code = await findCodeById(db, link.codeId);
  if (!code || code.partnerId !== partner.id) throw notFoundCode();
  return { partnerId: partner.id };
}

/**
 * One refusal for "not yours" and "does not exist".
 *
 * A distinguishable answer enumerates other partners' instruments, which is the
 * `/sellers/:oxyUserId` oracle one domain over. The message names no partner,
 * no owner and no code.
 */
function notFoundCode(): Error {
  return notFound('Referral instrument not found');
}
