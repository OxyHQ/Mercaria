/**
 * The referral EDGE (#143) against a REAL PostgreSQL database and the REAL
 * Express app.
 *
 * #143's acceptance criterion 8 asks for "privacy, consent, retention and
 * scanner cases" to have end-to-end coverage, and its testing section names
 * twelve scenarios. The properties pinned here are the ones neither a unit test
 * nor a mocked repository can see: what the redirect actually PUTS ON THE WIRE,
 * which rows exist afterwards, and whether a scanner, a second click, a rotated
 * session or a merged merchant changes the answer.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every identifier carries a per-run tag and teardown
 * deletes exactly what this file created — `referral-writes.realdb`'s
 * discipline, and the reason no assertion below is an unscoped `count(*)`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import {
  referralAttributions,
  referralCodes,
  referralEvents,
  referralLinks,
  referralPartners,
  referralProgramControls,
  referralPrograms,
  referralSubjectRedirects,
  referralTouches,
} from '../../db/schema/referrals.js';
import { merchants } from '../../db/schema/merchants.js';
import { merchantClaims } from '../../db/schema/merchantClaims.js';
import { createProgramDraft, publishProgram } from '../referrals/program.service.js';
import { applyAsPartner, approvePartner } from '../referrals/partner.service.js';
import { issueCode, issueLink } from '../referrals/instrument.service.js';
import { recordSubjectMerge } from '../referrals/attribution.service.js';
import { setProgramControls } from '../referrals/controls.service.js';
import {
  bindCarriedReferral,
  bindEnteredCode,
  bindMerchantCandidate,
  type ReferralBindContext,
} from '../referrals/binding.service.js';
import { mintReferralState } from '../referrals/referral-state.js';
import { resolveReferralRedirect } from '../referrals/redirect.service.js';
import type { CommerceActor } from '../commerce-actor.js';

// Hoisted above the imports, so `config/index.ts` reads them at load. The edge
// is gated by `REFERRALS_ENABLED`, which demands BOTH secrets.
vi.hoisted(() => {
  process.env.REFERRALS_ENABLED = 'true';
  process.env.REFERRAL_LINK_TOKEN_SECRET = 'realdb-edge-link-secret';
  process.env.REFERRAL_STATE_SECRET = 'realdb-edge-state-secret';
  process.env.REFERRAL_REDIRECT_BASE_URL = 'https://mercaria.co';
});

let db: Database;
let createApp: typeof import('../../app.js').createApp;
const servers: Server[] = [];

/** Unique to this run; lower-case hex so it can live inside a code spelling. */
const TAG = uuidv7().replace(/-/g, '').slice(-10);
const OPERATOR = `operator-${TAG}`;
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

const trackedProgramIds: string[] = [];
const trackedPartnerIds: string[] = [];
const trackedRedirectFroms: string[] = [];
const trackedMerchantIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
  ({ createApp } = await import('../../app.js'));
}, 120_000);

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

  const versionIds =
    trackedProgramIds.length > 0
      ? (
          await db
            .select({ id: referralPrograms.id })
            .from(referralPrograms)
            .where(inArray(referralPrograms.programId, trackedProgramIds))
        ).map((row) => row.id)
      : [];
  const codeIds =
    versionIds.length > 0
      ? (
          await db
            .select({ id: referralCodes.id })
            .from(referralCodes)
            .where(inArray(referralCodes.programVersionId, versionIds))
        ).map((row) => row.id)
      : [];
  const linkIds =
    codeIds.length > 0
      ? (
          await db
            .select({ id: referralLinks.id })
            .from(referralLinks)
            .where(inArray(referralLinks.codeId, codeIds))
        ).map((row) => row.id)
      : [];
  const attributionIds =
    trackedProgramIds.length > 0
      ? (
          await db
            .select({ id: referralAttributions.id })
            .from(referralAttributions)
            .where(inArray(referralAttributions.programId, trackedProgramIds))
        ).map((row) => row.id)
      : [];
  const redirectIds =
    trackedRedirectFroms.length > 0
      ? (
          await db
            .select({ id: referralSubjectRedirects.id })
            .from(referralSubjectRedirects)
            .where(inArray(referralSubjectRedirects.fromRef, trackedRedirectFroms))
        ).map((row) => row.id)
      : [];

  const eventSubjectIds = [
    ...versionIds,
    ...codeIds,
    ...linkIds,
    ...attributionIds,
    ...redirectIds,
    ...trackedPartnerIds,
    ...trackedProgramIds,
  ];
  if (eventSubjectIds.length > 0) {
    await db.delete(referralEvents).where(inArray(referralEvents.subjectId, eventSubjectIds));
  }
  // Superseded rows point at their successors, so delete referencING rows
  // until none remain — bounded, since every pass removes at least the heads.
  let remaining = attributionIds;
  for (let pass = 0; pass < 6 && remaining.length > 0; pass += 1) {
    const deleted = await db
      .delete(referralAttributions)
      .where(
        and(
          inArray(referralAttributions.id, remaining),
          sql`not exists (select 1 from "referral_attributions" blocker
               where blocker."supersedes_attribution_id" = "referral_attributions"."id")`,
        ),
      )
      .returning({ id: referralAttributions.id });
    const gone = new Set(deleted.map((row) => row.id));
    remaining = remaining.filter((id) => !gone.has(id));
  }
  if (codeIds.length > 0) {
    await db.delete(referralTouches).where(inArray(referralTouches.codeId, codeIds));
  }
  if (linkIds.length > 0) {
    await db.delete(referralLinks).where(inArray(referralLinks.id, linkIds));
  }
  if (codeIds.length > 0) {
    await db
      .delete(referralCodes)
      .where(and(inArray(referralCodes.id, codeIds), isNotNull(referralCodes.aliasOfCodeId)));
    await db.delete(referralCodes).where(inArray(referralCodes.id, codeIds));
  }
  if (redirectIds.length > 0) {
    await db
      .delete(referralSubjectRedirects)
      .where(inArray(referralSubjectRedirects.id, redirectIds));
  }
  if (trackedProgramIds.length > 0) {
    await db
      .delete(referralProgramControls)
      .where(inArray(referralProgramControls.programId, trackedProgramIds));
  }
  if (trackedPartnerIds.length > 0) {
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  if (trackedProgramIds.length > 0) {
    await db
      .delete(referralPrograms)
      .where(inArray(referralPrograms.programId, trackedProgramIds));
  }
  if (trackedMerchantIds.length > 0) {
    await db.delete(merchantClaims).where(inArray(merchantClaims.merchantId, trackedMerchantIds));
    await db.delete(merchants).where(inArray(merchants.id, trackedMerchantIds));
  }
  await closePostgres();
});

/** A published (ACTIVE) buyer-referral program with a 30-day window. */
async function makeActiveProgram(
  suffix: string,
  overrides?: Partial<Parameters<typeof createProgramDraft>[0]>,
): Promise<{ programId: string; versionId: string }> {
  const draft = await createProgramDraft({
    name: `Edge ${suffix} ${TAG}`,
    description: 'Bring a buyer',
    publicTermsSummary: 'Share your link; earn on the first qualifying order.',
    family: 'buyer_referral',
    eligiblePartnerTypes: ['user', 'store'],
    eligibleSubjectKinds: ['oxy_user', 'guest_checkout'],
    markets: [],
    currencies: [],
    channels: [],
    commercialModes: [],
    attributionPolicy: 'last_touch',
    attributionWindowDays: 30,
    qualifyingEventPolicy: 'first_qualifying_paid_order',
    commissionRuleRef: `rule-${TAG}-${suffix}`,
    holdDays: 60,
    payoutPolicyRef: 'stripe-monthly',
    termsVersion: 't1',
    disclosureVersion: 'd1',
    createdByOxyUserId: OPERATOR,
    cohortKeys: [],
    ...overrides,
  });
  trackedProgramIds.push(draft.programId);
  const published = await publishProgram({ id: draft.id, approvedByOxyUserId: OPERATOR });
  return { programId: draft.programId, versionId: published.id };
}

/** An APPROVED user partner. */
async function makeApprovedPartner(name: string): Promise<{ id: string }> {
  const { partner } = await applyAsPartner({
    ownerType: 'user',
    ownerId: `owner-${name}-${TAG}`,
    displayName: `Partner ${name}`,
    termsVersion: 't1',
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(partner.id);
  await approvePartner({ partnerId: partner.id, actorOxyUserId: OPERATOR, reason: 'test' });
  return { id: partner.id };
}

/** A program, a partner, a code and a link — the whole chain one click needs. */
async function makeLink(suffix: string): Promise<{
  programId: string;
  partnerId: string;
  codeId: string;
  code: string;
  linkId: string;
  token: string;
}> {
  const { programId } = await makeActiveProgram(suffix);
  const partner = await makeApprovedPartner(suffix);
  const code = await issueCode({
    partnerId: partner.id,
    programId,
    requestedCode: `edge-${suffix}-${TAG}`,
  });
  const link = await issueLink({
    codeId: code.id,
    context: { destinationType: 'listing', destinationRef: 'abc123' },
  });
  return {
    programId,
    partnerId: partner.id,
    codeId: code.id,
    code: code.code,
    linkId: link.id,
    token: link.token,
  };
}

function listen(): Promise<string> {
  return new Promise((resolve) => {
    const server = createApp().listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

/** Follow nothing: the 302 itself is what is under test. */
async function click(
  base: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${base}/r/${encodeURIComponent(token)}`, {
    redirect: 'manual',
    headers: { 'user-agent': CHROME, ...headers },
  });
}

/** Every touch recorded for one code — scoped, never a table-wide count. */
async function touchesForCode(codeId: string) {
  return await db.select().from(referralTouches).where(inArray(referralTouches.codeId, [codeId]));
}

/** Every ACTIVE attribution for one program. */
async function activeAttributionsFor(programId: string) {
  return await db
    .select()
    .from(referralAttributions)
    .where(
      and(
        inArray(referralAttributions.programId, [programId]),
        sql`${referralAttributions.state} = 'active'`,
      ),
    );
}

function contextFor(actor: CommerceActor, at = new Date()): ReferralBindContext {
  return { actor, clientSurface: 'web', consentMode: 'granted', trafficClass: 'organic', at };
}

describe('acceptance 1: a valid signed link reaches ONE allow-listed destination', () => {
  it('302s to the composed Mercaria URL and issues the purpose-specific carrier', async () => {
    const base = await listen();
    const link = await makeLink('a1');

    const response = await click(base, link.token);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://mercaria.co/listings/abc123');
    // A permanent redirect would be cached forever: the click ceiling would
    // stop counting, a revoked link would keep working, and the operator lever
    // would be inert. 302 + no-store is the only pair under which every click
    // reaches the row that decides.
    expect(response.headers.get('cache-control')).toContain('no-store');
    // The destination page must not learn the token from a Referer header.
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('mercaria_referral');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // Not a guest cart credential, not a portal credential.
    expect(cookie).toContain('mrf_');
    expect(cookie).not.toContain('mgs_');
    expect(cookie).not.toContain('mgp_');
  });

  it('creates ONLY the approved touch state — no touch row for an anonymous click', async () => {
    // ADR 0003 T10: browsing creates no row. ADR 0005 D6: a guest touch is
    // stored against the CHECKOUT SCOPE. An anonymous click has no scope, so
    // the evidence travels in the carrier and the row is written when a
    // subject appears. Both rules hold; neither is bent.
    const base = await listen();
    const link = await makeLink('a1b');

    await click(base, link.token);

    expect(await touchesForCode(link.codeId)).toHaveLength(0);
    expect(await activeAttributionsFor(link.programId)).toHaveLength(0);
  });

  it('counts the click against the link ceiling', async () => {
    const base = await listen();
    const link = await makeLink('a1c');
    await click(base, link.token);
    const [row] = await db
      .select()
      .from(referralLinks)
      .where(inArray(referralLinks.id, [link.linkId]));
    expect(row?.clickCount).toBe(1);
  });
});

describe('a click by a request that ALREADY has a subject resolves completely', () => {
  it('records the touch AND attributes it, with no carrier to redeem', async () => {
    // The bug this pins, found by re-reading the branch rather than by a
    // failing test: the redirect recorded the touch and stopped. No carrier is
    // issued when a subject is present — there is nothing to defer — so
    // `POST /referrals/bind` would have had nothing to present, and a
    // signed-in buyer's click would sit unattributed forever, silently earning
    // the partner nothing. Deleting the `attributeRecordedTouch` call in
    // `redirect.service.ts` turns this red.
    const link = await makeLink('signedin');
    const oxyUserId = `buyer-signedin-${TAG}`;

    const outcome = await resolveReferralRedirect({
      token: link.token,
      trafficClass: 'organic',
      clientSurface: 'web',
      consentMode: 'granted',
      actor: { kind: 'oxy', oxyUserId },
      at: new Date(),
    });

    expect(outcome.outcome).toBe('redirect');
    if (outcome.outcome !== 'redirect') return;
    expect(outcome.location).toBe('https://mercaria.co/listings/abc123');
    // No carrier: there is nothing to defer.
    expect(outcome.state).toBeUndefined();
    expect(outcome.touchId).toBeDefined();

    const touches = await touchesForCode(link.codeId);
    expect(touches).toHaveLength(1);
    expect(touches[0]?.actorKind).toBe('oxy_user');

    const active = await activeAttributionsFor(link.programId);
    expect(active).toHaveLength(1);
    expect(active[0]?.subjectKind).toBe('oxy_user');
    expect(active[0]?.subjectRef).toBe(oxyUserId);
    expect(active[0]?.partnerId).toBe(link.partnerId);
  });

  it('still respects the attribution lever on that branch', async () => {
    const link = await makeLink('signedin-lever');
    await setProgramControls({
      programId: link.programId,
      redirectEnabled: true,
      attributionEnabled: false,
      payoutEnabled: true,
      actorOxyUserId: OPERATOR,
      reason: 'incident drill',
    });

    await resolveReferralRedirect({
      token: link.token,
      trafficClass: 'organic',
      clientSurface: 'web',
      consentMode: 'granted',
      actor: { kind: 'oxy', oxyUserId: `buyer-sl-${TAG}` },
      at: new Date(),
    });

    expect(await touchesForCode(link.codeId)).toHaveLength(1);
    expect(await activeAttributionsFor(link.programId)).toHaveLength(0);
  });
});

describe('acceptance 2: the redirect is not an open redirect or a campaign injector', () => {
  it('ignores every query parameter a caller adds', async () => {
    const base = await listen();
    const link = await makeLink('a2');

    const response = await fetch(
      `${base}/r/${encodeURIComponent(link.token)}` +
        '?next=https://evil.example&utm_campaign=stolen&redirect=//evil.example',
      { redirect: 'manual', headers: { 'user-agent': CHROME } },
    );

    // The destination is composed from a configured allow-listed origin and a
    // closed template. Nothing the caller sent appears in it, and there is no
    // query string on the target at all.
    expect(response.headers.get('location')).toBe('https://mercaria.co/listings/abc123');
  });

  it('cannot be steered by a forged Host or X-Forwarded-Host', async () => {
    const base = await listen();
    const link = await makeLink('a2b');
    const response = await click(base, link.token, {
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
    });
    expect(response.headers.get('location')).toBe('https://mercaria.co/listings/abc123');
  });

  it('answers 404 for garbage, an unknown token and a forged signature', async () => {
    const base = await listen();
    const link = await makeLink('a2c');
    const [payload, sig] = link.token.split('.');

    for (const token of [
      'not-a-token',
      `${payload ?? ''}.${'x'.repeat((sig ?? '').length)}`,
      'a.b',
    ]) {
      const response = await click(base, token);
      expect(response.status, token).toBe(404);
      expect(response.headers.get('location'), token).toBeNull();
    }
  });
});

describe('acceptance 8: bots, previews and scanners are classified and unattributed', () => {
  it('redirects a crawler identically and records NOTHING', async () => {
    const base = await listen();
    const link = await makeLink('bot');

    const response = await click(base, link.token, {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    });

    // Identical destination: a redirect that varied on the User-Agent would be
    // cloaking, and search engines treat it as such.
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://mercaria.co/listings/abc123');
    // No carrier, no touch, and — the part a partner cares about — no click
    // spent against their ceiling.
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await touchesForCode(link.codeId)).toHaveLength(0);
    const [row] = await db
      .select()
      .from(referralLinks)
      .where(inArray(referralLinks.id, [link.linkId]));
    expect(row?.clickCount).toBe(0);
  });

  it('treats a link unfurler and a browser prefetch the same way', async () => {
    const base = await listen();
    for (const [suffix, headers] of [
      ['preview', { 'user-agent': 'facebookexternalhit/1.1' }],
      ['prefetch', { 'user-agent': CHROME, 'sec-purpose': 'prefetch;prerender' }],
    ] as const) {
      const link = await makeLink(suffix);
      const response = await click(base, link.token, headers);
      expect(response.status, suffix).toBe(302);
      expect(response.headers.get('set-cookie'), suffix).toBeNull();
      expect(await touchesForCode(link.codeId), suffix).toHaveLength(0);
    }
  });
});

describe('the two operator levers are independent (#143 link rule 8)', () => {
  it('redirect OFF stops the link and leaves a typed code attributing', async () => {
    const base = await listen();
    const link = await makeLink('lever1');

    await setProgramControls({
      programId: link.programId,
      redirectEnabled: false,
      attributionEnabled: true,
      payoutEnabled: true,
      actorOxyUserId: OPERATOR,
      reason: 'incident drill',
    });

    // Same 404 an unknown token gets: a stranger must not be able to tell
    // "no such link" from "that programme is paused".
    expect((await click(base, link.token)).status).toBe(404);

    // …and the OTHER instrument still works, which is what "independently"
    // means.
    const actor: CommerceActor = { kind: 'oxy', oxyUserId: `buyer-lever1-${TAG}` };
    const result = await bindEnteredCode({
      code: link.code,
      moment: 'at_checkout',
      context: contextFor(actor),
    });
    expect(result.state).toBe('attributed');
  });

  it('attribution OFF still RECORDS the touch and creates no winner', async () => {
    // ADR 0005 D18: gating loops and gates, never records. An effect that did
    // not happen must stay distinguishable from one that never arrived.
    const link = await makeLink('lever2');
    await setProgramControls({
      programId: link.programId,
      redirectEnabled: true,
      attributionEnabled: false,
      payoutEnabled: true,
      actorOxyUserId: OPERATOR,
      reason: 'incident drill',
    });

    const actor: CommerceActor = { kind: 'oxy', oxyUserId: `buyer-lever2-${TAG}` };
    const result = await bindEnteredCode({
      code: link.code,
      moment: 'in_app',
      context: contextFor(actor),
    });

    expect(result.state).toBe('recorded_not_attributed');
    expect(await touchesForCode(link.codeId)).toHaveLength(1);
    expect(await activeAttributionsFor(link.programId)).toHaveLength(0);
  });

  it('records who pulled a lever and why', async () => {
    const link = await makeLink('lever3');
    await setProgramControls({
      programId: link.programId,
      redirectEnabled: false,
      attributionEnabled: false,
      payoutEnabled: true,
      actorOxyUserId: OPERATOR,
      reason: 'suspected abuse, pending review',
    });
    const events = await db
      .select()
      .from(referralEvents)
      .where(inArray(referralEvents.subjectId, [link.programId]));
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('program_controls_set');
    expect(events[0]?.actorRef).toBe(OPERATOR);
    expect(events[0]?.reason).toContain('suspected abuse');
  });
});

describe('binding: the carrier becomes a touch only when there is a subject', () => {
  it('answers `pending` and writes nothing for an anonymous caller', async () => {
    const link = await makeLink('bind1');
    const { token } = mintReferralState({
      linkId: link.linkId,
      codeId: link.codeId,
      clickedAt: new Date(),
      lifetimeSeconds: 30 * 24 * 3_600,
    });

    const result = await bindCarriedReferral({
      stateToken: token,
      context: contextFor({ kind: 'anonymous' }),
    });

    expect(result.state).toBe('pending');
    expect(result.redeemed).toBe(false);
    expect(await touchesForCode(link.codeId)).toHaveLength(0);
  });

  it('binds a GUEST click to the guest session — ADR 0005 D6s checkout scope', async () => {
    const link = await makeLink('bind2');
    const guestSessionId = `guest-session-${TAG}-bind2`;
    const clickedAt = new Date(Date.now() - 60_000);
    const { token } = mintReferralState({
      linkId: link.linkId,
      codeId: link.codeId,
      clickedAt,
      lifetimeSeconds: 30 * 24 * 3_600,
    });

    const result = await bindCarriedReferral({
      stateToken: token,
      context: contextFor({ kind: 'guest', guestSessionId, transport: 'cookie' }),
    });

    expect(result.state).toBe('attributed');
    expect(result.redeemed).toBe(true);

    const touches = await touchesForCode(link.codeId);
    expect(touches).toHaveLength(1);
    expect(touches[0]?.actorKind).toBe('guest_session');
    expect(touches[0]?.guestSessionRef).toBe(guestSessionId);
    expect(touches[0]?.oxyUserId).toBeNull();
    // The CLICK instant, not the bind's — #143 web rule 7.
    //
    // Truncated to the SECOND, because the carrier stores epoch seconds to
    // keep a cookie small. The direction is what makes that safe: truncation
    // rounds DOWN, so a carried click can only ever look OLDER than it was and
    // can never jump ahead of a code typed in the same second. Under ADR 0005
    // D4 an exact tie resolves by touch id, deterministically, so the loss of
    // sub-second precision cannot change who wins in a way anybody could aim.
    const clickSecond = Math.floor(clickedAt.getTime() / 1_000) * 1_000;
    expect(touches[0]?.occurredAt.getTime()).toBe(clickSecond);
    expect(touches[0]?.occurredAt.getTime()).toBeLessThanOrEqual(clickedAt.getTime());

    const [attribution] = await activeAttributionsFor(link.programId);
    expect(attribution?.subjectKind).toBe('guest_checkout');
    expect(attribution?.subjectRef).toBe(guestSessionId);
    expect(attribution?.partnerId).toBe(link.partnerId);
  });

  it('a rotated guest session neither duplicates nor loses the attribution', async () => {
    // #143 guest rule 3. Structural rather than a merge rule: #103's rotation
    // swaps `token_hash` IN PLACE, so the session ROW id — which is what the
    // attribution's subject reference is — never moves. Binding again under
    // the same session id converges on the one winner.
    const link = await makeLink('rotate');
    const guestSessionId = `guest-session-${TAG}-rotate`;
    const mintFor = (clickedAt: Date) =>
      mintReferralState({
        linkId: link.linkId,
        codeId: link.codeId,
        clickedAt,
        lifetimeSeconds: 30 * 24 * 3_600,
      }).token;

    const actor: CommerceActor = {
      kind: 'guest',
      guestSessionId,
      transport: 'cookie',
    };
    await bindCarriedReferral({
      stateToken: mintFor(new Date(Date.now() - 120_000)),
      context: contextFor(actor),
    });
    // A second click, after the rotation, from the same browser.
    await bindCarriedReferral({
      stateToken: mintFor(new Date(Date.now() - 60_000)),
      context: contextFor(actor),
    });

    const active = await activeAttributionsFor(link.programId);
    expect(active).toHaveLength(1);
    expect(active[0]?.subjectRef).toBe(guestSessionId);
  });

  it('refuses to redeem a carrier presented by non-organic traffic', async () => {
    // And does NOT consume it: a preview fetch that burned somebody's carrier
    // would cost them the attribution they clicked for.
    const link = await makeLink('bind3');
    const { token } = mintReferralState({
      linkId: link.linkId,
      codeId: link.codeId,
      clickedAt: new Date(),
      lifetimeSeconds: 30 * 24 * 3_600,
    });
    const result = await bindCarriedReferral({
      stateToken: token,
      context: {
        ...contextFor({ kind: 'oxy', oxyUserId: `buyer-${TAG}-b3` }),
        trafficClass: 'preview',
      },
    });
    expect(result.reason).toBe('traffic_not_organic');
    expect(result.redeemed).toBe(false);
    expect(await touchesForCode(link.codeId)).toHaveLength(0);
  });

  it('refuses an expired carrier uniformly', async () => {
    const link = await makeLink('bind4');
    const { token } = mintReferralState({
      linkId: link.linkId,
      codeId: link.codeId,
      clickedAt: new Date(Date.now() - 10_000),
      lifetimeSeconds: 1,
    });
    const result = await bindCarriedReferral({
      stateToken: token,
      context: contextFor({ kind: 'oxy', oxyUserId: `buyer-${TAG}-b4` }),
    });
    expect(result.reason).toBe('state_unusable');
    expect(await touchesForCode(link.codeId)).toHaveLength(0);
  });
});

describe('acceptance 3: competing links and codes resolve under last-touch', () => {
  it('a code typed later beats an earlier click, and supersedes its attribution', async () => {
    // ADR 0005 D4, and it needs no precedence branch anywhere: code entry IS a
    // touch and is by construction the latest one.
    const first = await makeLink('compete-a');
    const second = await makeLink('compete-b');
    const oxyUserId = `buyer-compete-${TAG}`;
    const actor: CommerceActor = { kind: 'oxy', oxyUserId };

    const clickedAt = new Date(Date.now() - 120_000);
    await bindCarriedReferral({
      stateToken: mintReferralState({
        linkId: first.linkId,
        codeId: first.codeId,
        clickedAt,
        lifetimeSeconds: 30 * 24 * 3_600,
      }).token,
      context: contextFor(actor),
    });
    const firstActive = await activeAttributionsFor(first.programId);
    expect(firstActive[0]?.partnerId).toBe(first.partnerId);

    // A code from a DIFFERENT program: each program keeps its own winner, so
    // the assertion below is about the program the code belongs to.
    const entered = await bindEnteredCode({
      code: second.code,
      moment: 'at_checkout',
      context: contextFor(actor),
    });
    expect(entered.state).toBe('attributed');
    const secondActive = await activeAttributionsFor(second.programId);
    expect(secondActive).toHaveLength(1);
    expect(secondActive[0]?.partnerId).toBe(second.partnerId);
    expect(secondActive[0]?.evidenceTouchKind).toBe('code_entry_at_checkout');
  });

  it('a later click within ONE program supersedes the standing winner exactly once', async () => {
    const { programId } = await makeActiveProgram('super');
    const partnerA = await makeApprovedPartner('super-a');
    const partnerB = await makeApprovedPartner('super-b');
    const codeA = await issueCode({
      partnerId: partnerA.id,
      programId,
      requestedCode: `sup-a-${TAG}`,
    });
    const codeB = await issueCode({
      partnerId: partnerB.id,
      programId,
      requestedCode: `sup-b-${TAG}`,
    });
    const oxyUserId = `buyer-super-${TAG}`;
    const actor: CommerceActor = { kind: 'oxy', oxyUserId };

    await bindEnteredCode({
      code: codeA.code,
      moment: 'in_app',
      context: contextFor(actor, new Date(Date.now() - 120_000)),
    });
    await bindEnteredCode({
      code: codeB.code,
      moment: 'in_app',
      context: contextFor(actor, new Date()),
    });

    const active = await activeAttributionsFor(programId);
    expect(active).toHaveLength(1);
    expect(active[0]?.partnerId).toBe(partnerB.id);
  });

  it('refuses an unknown, expired and paused code with ONE indistinguishable answer', async () => {
    // #143 code rule 6: an error must not reveal private partner status, and a
    // distinguishable "that code exists but is paused" is an enumeration
    // oracle over every partner's instruments.
    const actor: CommerceActor = { kind: 'oxy', oxyUserId: `buyer-guess-${TAG}` };
    for (const code of [`no-such-code-${TAG}`, `ALSO-MISSING-${TAG}`]) {
      const result = await bindEnteredCode({
        code,
        moment: 'in_app',
        context: contextFor(actor),
      });
      expect(result.state, code).toBe('none');
      expect(result.reason, code).toBe('instrument_unusable');
    }
  });

  it('needs a subject before a typed code can be recorded', async () => {
    const link = await makeLink('anon-code');
    const result = await bindEnteredCode({
      code: link.code,
      moment: 'in_app',
      context: contextFor({ kind: 'anonymous' }),
    });
    expect(result.state).toBe('pending');
    expect(result.reason).toBe('no_subject');
    expect(await touchesForCode(link.codeId)).toHaveLength(0);
  });
});

describe('acceptance 5: contact and payment data are never cross-checkout identity', () => {
  it('two guest sessions are two subjects, whatever they share off-platform', async () => {
    // There is no email, hash, card or device column in this domain and no
    // parameter in this path that could carry one — so "separate guest
    // checkouts remain separate even when contact or payment details match"
    // (#143 guest rule 7) is true because nothing here can observe that they
    // match. Both sessions bind the same link and get their OWN attribution.
    const link = await makeLink('sep');
    const clickedAt = new Date(Date.now() - 60_000);
    const carrier = () =>
      mintReferralState({
        linkId: link.linkId,
        codeId: link.codeId,
        clickedAt,
        lifetimeSeconds: 30 * 24 * 3_600,
      }).token;

    for (const suffix of ['one', 'two']) {
      const result = await bindCarriedReferral({
        stateToken: carrier(),
        context: contextFor({
          kind: 'guest',
          guestSessionId: `guest-${TAG}-sep-${suffix}`,
          transport: 'cookie',
        }),
      });
      expect(result.state, suffix).toBe('attributed');
    }

    const active = await activeAttributionsFor(link.programId);
    expect(active).toHaveLength(2);
    expect(new Set(active.map((row) => row.subjectRef)).size).toBe(2);
  });
});

describe('acceptance 7: merchant binding survives correction and merge', () => {
  async function makeMerchantWithClaim(
    suffix: string,
    claimantOxyUserId: string,
  ): Promise<string> {
    const [merchant] = await db
      .insert(merchants)
      .values({ name: `Merchant ${suffix} ${TAG}`, slug: `merchant-${suffix}-${TAG}` })
      .returning();
    if (!merchant) throw new Error('fixture merchants insert returned no row');
    trackedMerchantIds.push(merchant.id);
    await db.insert(merchantClaims).values({
      merchantId: merchant.id,
      claimantOxyUserId,
      method: 'dns_txt',
      subjectKind: 'domain',
      subjectRef: `example-${suffix}-${TAG}.test`,
      state: 'challenge_pending',
    });
    return merchant.id;
  }

  it('refuses a caller who holds no claim on that merchant', async () => {
    // The security half of "a domain-verification claimant cannot steal an
    // existing merchant attribution silently": a body naming any merchant
    // would let anybody attach a partner to somebody else's shop.
    const link = await makeLink('merch-refuse');
    const stranger = `stranger-${TAG}`;
    const merchantId = await makeMerchantWithClaim('refuse', `somebody-else-${TAG}`);

    const result = await bindMerchantCandidate({
      merchantId,
      stateToken: mintReferralState({
        linkId: link.linkId,
        codeId: link.codeId,
        clickedAt: new Date(),
        lifetimeSeconds: 30 * 24 * 3_600,
      }).token,
      context: contextFor({ kind: 'oxy', oxyUserId: stranger }),
    });

    expect(result.reason).toBe('merchant_not_bindable');
    expect(await touchesForCode(link.codeId)).toHaveLength(0);
  });

  it('binds a held claim, and a later merge leaves ONE adjudicated attribution', async () => {
    const { programId } = await makeActiveProgram('merch', {
      family: 'merchant_referral',
      eligibleSubjectKinds: ['merchant'],
      qualifyingEventPolicy: 'merchant_activation',
      activationWindowDays: 90,
    });
    const partner = await makeApprovedPartner('merch');
    const code = await issueCode({
      partnerId: partner.id,
      programId,
      requestedCode: `merch-${TAG}`,
    });
    const link = await issueLink({ codeId: code.id, context: { destinationType: 'home' } });

    const claimant = `claimant-${TAG}`;
    const duplicateId = await makeMerchantWithClaim('dup', claimant);
    const survivorId = await makeMerchantWithClaim('survivor', claimant);

    const bound = await bindMerchantCandidate({
      merchantId: duplicateId,
      stateToken: mintReferralState({
        linkId: link.id,
        codeId: code.id,
        clickedAt: new Date(Date.now() - 30_000),
        lifetimeSeconds: 30 * 24 * 3_600,
      }).token,
      context: contextFor({ kind: 'oxy', oxyUserId: claimant }),
    });
    expect(bound.state).toBe('attributed');

    let active = await activeAttributionsFor(programId);
    expect(active).toHaveLength(1);
    expect(active[0]?.subjectKind).toBe('merchant');
    expect(active[0]?.subjectRef).toBe(duplicateId);

    // The canonical correction: the duplicate merchant is merged away. History
    // keeps the reference it was created with; reads and NEW attributions
    // resolve through the redirect, so one adjudicated attribution survives.
    trackedRedirectFroms.push(duplicateId);
    await recordSubjectMerge({
      subjectKind: 'merchant',
      fromRef: duplicateId,
      toRef: survivorId,
      actorOxyUserId: OPERATOR,
      reason: 'duplicate merchant candidate',
    });

    const rebound = await bindMerchantCandidate({
      merchantId: survivorId,
      stateToken: mintReferralState({
        linkId: link.id,
        codeId: code.id,
        clickedAt: new Date(),
        lifetimeSeconds: 30 * 24 * 3_600,
      }).token,
      context: contextFor({ kind: 'oxy', oxyUserId: claimant }),
    });
    expect(rebound.state).toBe('attributed');

    // The partner keeps credit, on the SURVIVING merchant, with the same
    // pinned partner — acceptance 7 for the flow that actually occurs, since a
    // merchant referral converts at ACTIVATION (ADR 0005 D11) and a claim on
    // the survivor is what produces the post-merge touch.
    active = await activeAttributionsFor(programId);
    const onSurvivor = active.filter((row) => row.subjectRef === survivorId);
    expect(onSurvivor).toHaveLength(1);
    expect(onSurvivor[0]?.partnerId).toBe(partner.id);

    // …and a touch naming the RETIRED reference resolves to the survivor too,
    // so nothing new can land on the dead identity.
    const reboundViaOldRef = await bindMerchantCandidate({
      merchantId: duplicateId,
      stateToken: mintReferralState({
        linkId: link.id,
        codeId: code.id,
        clickedAt: new Date(Date.now() + 1_000),
        lifetimeSeconds: 30 * 24 * 3_600,
      }).token,
      context: contextFor({ kind: 'oxy', oxyUserId: claimant }),
    });
    expect(reboundViaOldRef.state).toBe('attributed');
    expect(
      (await activeAttributionsFor(programId)).filter((row) => row.subjectRef === survivorId),
    ).toHaveLength(1);
  });

  it('leaves the PRE-MERGE attribution on its own reference — the stated residual', async () => {
    // #142's `recordSubjectMerge` is explicit that "history keeps its
    // references; reads and NEW attributions resolve through the redirect",
    // and its own realdb file pins that the pre-merge row is not rewritten.
    //
    // The consequence, asserted here rather than left to be discovered: a
    // merge does NOT rehome a standing attribution. With a post-merge touch —
    // the normal course for a merchant referral, which converts at activation
    // — the partner keeps credit on the survivor. WITHOUT one, the pre-merge
    // row stays `active` on the retired reference and is unreachable by
    // resolution, because `resolveSubjectRef` maps from→to and nothing maps
    // survivor→duplicate.
    //
    // Repairing one is an existing, audited operator act
    // (`correctAttribution`), not a sweep. Changing the merge to supersede
    // instead would redefine semantics #142 ships and tests, so it is named
    // here and in `docs/referral-attribution.md` rather than done in passing.
    const { programId } = await makeActiveProgram('residual', {
      family: 'merchant_referral',
      eligibleSubjectKinds: ['merchant'],
      qualifyingEventPolicy: 'merchant_activation',
      activationWindowDays: 90,
    });
    const partner = await makeApprovedPartner('residual');
    const code = await issueCode({
      partnerId: partner.id,
      programId,
      requestedCode: `resid-${TAG}`,
    });
    const link = await issueLink({ codeId: code.id, context: { destinationType: 'home' } });
    const claimant = `claimant-resid-${TAG}`;
    const duplicateId = await makeMerchantWithClaim('resid-dup', claimant);
    const survivorId = await makeMerchantWithClaim('resid-surv', claimant);

    await bindMerchantCandidate({
      merchantId: duplicateId,
      stateToken: mintReferralState({
        linkId: link.id,
        codeId: code.id,
        clickedAt: new Date(Date.now() - 30_000),
        lifetimeSeconds: 30 * 24 * 3_600,
      }).token,
      context: contextFor({ kind: 'oxy', oxyUserId: claimant }),
    });

    trackedRedirectFroms.push(duplicateId);
    await recordSubjectMerge({
      subjectKind: 'merchant',
      fromRef: duplicateId,
      toRef: survivorId,
      actorOxyUserId: OPERATOR,
      reason: 'duplicate merchant candidate',
    });

    // No post-merge touch. The row is still there, still `active`, still on
    // the reference it was created with — history, and the residual.
    const active = await activeAttributionsFor(programId);
    expect(active).toHaveLength(1);
    expect(active[0]?.subjectRef).toBe(duplicateId);
    expect(active[0]?.partnerId).toBe(partner.id);
  });
});

describe('acceptance 6: attribution grants no authorization', () => {
  it('the carrier names two row ids and an instant — nothing that could authorize', async () => {
    // ADR 0005 A1, as a property of the payload rather than a rule. There is no
    // user id, session id, order id or scope list in it, so there is nothing an
    // authorization check could read even if somebody wrote one.
    const link = await makeLink('authz');
    const { token } = mintReferralState({
      linkId: link.linkId,
      codeId: link.codeId,
      clickedAt: new Date(),
      lifetimeSeconds: 30 * 24 * 3_600,
    });
    const [payloadB64] = token.slice('mrf_'.length).split('.');
    const payload = JSON.parse(Buffer.from(payloadB64 ?? '', 'base64url').toString('utf8'));
    expect(Object.keys(payload).sort()).toEqual(['c', 'l', 'n', 't', 'x']);
    expect(payload.l).toBe(link.linkId);
    expect(payload.c).toBe(link.codeId);
  });

  it('no touch row carries an Oxy id for a guest actor, or the reverse', async () => {
    // The CHECK that holds it is #142's; this asserts the EDGE writes rows that
    // satisfy it, from both actor kinds.
    const link = await makeLink('actorshape');
    await bindEnteredCode({
      code: link.code,
      moment: 'in_app',
      context: contextFor({ kind: 'oxy', oxyUserId: `buyer-shape-${TAG}` }),
    });
    const [touch] = await touchesForCode(link.codeId);
    expect(touch?.actorKind).toBe('oxy_user');
    expect(touch?.guestSessionRef).toBeNull();
    expect(touch?.oxyUserId).toBe(`buyer-shape-${TAG}`);
  });
});
