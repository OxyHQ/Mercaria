/**
 * The operator program list REPORTS its truncation instead of hiding it (#392).
 *
 * The partner surface got a predicate; this one cannot have the same fix,
 * because an operator legitimately wants every program — including the drafts
 * nobody has published, which is the one reader who must see them. So what was
 * wrong here is not the bound but the SILENCE: the read is ordered by
 * `program_id`, a string, so a truncation hides an arbitrary subset and nothing
 * in the response says a subset is missing.
 *
 * Mocked rather than realdb, deliberately. The property is pure arithmetic over
 * a row count — read one more than you report, report whether the extra came
 * back — with no CHECK, unique index or transaction in it. Driving it against a
 * real server would mean seeding two hundred and one programs into a database
 * every other referral file is reading at the same time, which is the
 * contention hazard this repo documents, in exchange for measuring nothing the
 * mock cannot.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import type { ReferralProgramRow } from '../../db/referrals/programRepository.js';

const listProgramIdentities = vi.fn();

vi.mock('../../db/postgres.js', () => ({ getDb: () => ({}) }));

vi.mock('../../db/referrals/programRepository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/referrals/programRepository.js')>()),
  listProgramIdentities: (...args: unknown[]) => listProgramIdentities(...args),
}));

const { listReferralProgramsHandler } = await import('../referral-program-operator.controller.js');

/** Only the fields the operator projection reads. */
function programRow(index: number): ReferralProgramRow {
  return {
    id: `id-${index}`,
    programId: `prog-${String(index).padStart(4, '0')}`,
    version: 1,
    name: `Program ${index}`,
    description: 'Fixture',
    publicTermsSummary: 'Summary',
    family: 'buyer_referral',
    status: 'draft',
    effectiveStartAt: null,
    effectiveEndAt: null,
    eligiblePartnerTypes: ['user'],
    eligibleSubjectKinds: ['oxy_user'],
    markets: [],
    currencies: [],
    channels: [],
    commercialModes: [],
    attributionPolicy: 'last_touch',
    attributionWindowDays: 30,
    activationWindowDays: null,
    qualifyingEventPolicy: 'first_qualifying_paid_order',
    commissionRuleRef: 'rule:1',
    holdDays: 60,
    capPolicyRef: null,
    payoutPolicyRef: 'payout',
    termsVersion: 'terms-2026-08-01',
    disclosureVersion: 'disclosure-2026-08-01',
    featureFlagKey: null,
    cohortKeys: [],
    createdByOxyUserId: 'oxy-op',
    approvedByOxyUserId: null,
    publishedAt: null,
    pausedAt: null,
    endedAt: null,
    retiredAt: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  };
}

interface Captured {
  status: number;
  body: { success: boolean; data: { programs: unknown[]; truncated: boolean } };
}

function captureResponse(): { res: Response; seen: Captured[] } {
  const seen: Captured[] = [];
  let status = 200;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(body: Captured['body']) {
      seen.push({ status, body });
      return this;
    },
  } as unknown as Response;
  return { res, seen };
}

beforeEach(() => {
  listProgramIdentities.mockReset();
});

describe('the operator program list makes truncation visible', () => {
  it('asks for one MORE row than it will report', async () => {
    listProgramIdentities.mockResolvedValue([]);
    const { res } = captureResponse();

    await listReferralProgramsHandler({} as never, res);

    // The overflow row is the whole mechanism: without it, "did more exist" is
    // a question a full page cannot answer, because a page that is exactly full
    // and a page that was cut look identical.
    const [, input] = listProgramIdentities.mock.calls[0] as [unknown, { limit: number }];
    expect(input.limit).toBe(201);
  });

  it('reports truncated and hands back only the page when the extra row comes back', async () => {
    listProgramIdentities.mockResolvedValue(
      Array.from({ length: 201 }, (_unused, index) => programRow(index)),
    );
    const { res, seen } = captureResponse();

    await listReferralProgramsHandler({} as never, res);

    expect(seen[0]?.body.data.truncated).toBe(true);
    // The overflow row is a PROBE and is never served: a client rendering it
    // would show a program the next page also shows.
    expect(seen[0]?.body.data.programs).toHaveLength(200);
  });

  it('reports NOT truncated on an exactly-full page', async () => {
    // The boundary the `+ 1` exists for. Reading exactly the limit and flagging
    // a full page would cry wolf on every deployment that happens to have two
    // hundred programs.
    listProgramIdentities.mockResolvedValue(
      Array.from({ length: 200 }, (_unused, index) => programRow(index)),
    );
    const { res, seen } = captureResponse();

    await listReferralProgramsHandler({} as never, res);

    expect(seen[0]?.body.data.truncated).toBe(false);
    expect(seen[0]?.body.data.programs).toHaveLength(200);
  });
});
