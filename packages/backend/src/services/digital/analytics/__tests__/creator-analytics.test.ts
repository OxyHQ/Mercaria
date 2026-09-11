/**
 * The creator's own summary (#1015 W6) and the launch metrics (#1015 W13).
 *
 * Both are pure over facts, so what is driven here is the POPULATION: an empty
 * window, a denominator of zero, a view cohort either side of the floor, a verdict
 * nobody has produced, a refunded line that is also disputed, two currencies.
 * Every one of those is a place an aggregate quietly means the wrong thing.
 */

import { describe, expect, it } from 'vitest';
import {
  CREATOR_VIEW_MIN_COHORT,
  summariseCreatorDigitalSales,
} from '../creator-analytics.js';
import {
  ASSET_PROCESSING_FAILURE_VERDICTS,
  computeLaunchMetrics,
} from '../launch-metrics.js';
import { DIGITAL_METRICS, digitalMetricByKey } from '../metrics.js';
import { NO_DIGITAL_ANALYTICS_FACTS } from '../facts.js';
import {
  download,
  facts,
  processing,
  publication,
  repeat,
  right,
  sale,
  view,
} from './fact-builders.js';
import { assertEachOf } from '../../../../__tests__/assert-each-of.js';

const WINDOW = { storeId: 'store-1', from: '2026-08-01', to: '2026-08-31' };

describe("#1015 W6 — a creator's own commercial record is not suppressed", () => {
  it('three sales are reported as three, not hidden behind a cohort floor', () => {
    const summary = summariseCreatorDigitalSales({
      ...WINDOW,
      facts: facts({ sales: repeat(3, () => sale()) }),
    });
    // Their order list shows these line by line already. Suppressing them protects
    // nobody and breaks the dashboard for exactly the creators a launch has.
    expect(summary.paidSaleCount).toBe(3);
    expect(summary.amounts).toEqual([
      { currency: 'EUR', grossAmount: 7_500, realizedFeeAmount: 750, creatorEarningsAmount: 6_750 },
    ]);
  });

  it('money is per currency and is never summed across them', () => {
    const summary = summariseCreatorDigitalSales({
      ...WINDOW,
      facts: facts({
        sales: [sale({ currency: 'EUR', grossAmount: 100 }), sale({ currency: 'USD', grossAmount: 100 })],
      }),
    });
    expect(summary.amounts.map((amount) => amount.currency)).toEqual(['EUR', 'USD']);
    expect(summary.amounts.every((amount) => amount.grossAmount === 100)).toBe(true);
  });

  it('a refunded line stays in gross and is counted separately', () => {
    const summary = summariseCreatorDigitalSales({
      ...WINDOW,
      facts: facts({ sales: [sale({ refunded: true, grossAmount: 400 })] }),
    });
    // Netting a later refund into the window the SALE fell in would make a
    // historical figure change, which nothing in this codebase is allowed to do.
    expect(summary.amounts[0].grossAmount).toBe(400);
    expect(summary.refundedSaleCount).toBe(1);
  });

  it('a line that is both disputed and refunded is counted in both, never once', () => {
    const summary = summariseCreatorDigitalSales({
      ...WINDOW,
      facts: facts({ sales: [sale({ refunded: true, disputed: true })] }),
    });
    expect(summary.refundedSaleCount).toBe(1);
    expect(summary.disputedSaleCount).toBe(1);
  });

  it('free claims and paid sales are side by side, never added', () => {
    const summary = summariseCreatorDigitalSales({
      ...WINDOW,
      facts: facts({
        sales: [...repeat(2, () => sale({ priceClass: 'free', grossAmount: 0 })), sale()],
        downloads: [download({ priceClass: 'free' }), download({ priceClass: 'paid' })],
      }),
    });
    expect(summary.freeClaimCount).toBe(2);
    expect(summary.paidSaleCount).toBe(1);
    expect(summary.completedDownloads).toEqual({ free: 1, paid: 1 });
  });

  it('the licence mix is reported by policy and by version', () => {
    const summary = summariseCreatorDigitalSales({
      ...WINDOW,
      facts: facts({
        sales: [
          sale({ updatePolicy: 'all_future_versions', licenceVersionId: 'lv-commercial' }),
          sale({ updatePolicy: 'purchased_version_only', licenceVersionId: 'lv-personal' }),
          sale({ updatePolicy: 'purchased_version_only', licenceVersionId: 'lv-personal' }),
        ],
      }),
    });
    expect(summary.licenceMix.byUpdatePolicy).toEqual([
      { policy: 'all_future_versions', saleCount: 1 },
      { policy: 'purchased_version_only', saleCount: 2 },
    ]);
    expect(summary.licenceMix.byLicenceVersion).toEqual([
      { licenceVersionId: 'lv-commercial', saleCount: 1 },
      { licenceVersionId: 'lv-personal', saleCount: 2 },
    ]);
  });

  it('an asset is counted once however many versions or packages it has', () => {
    const summary = summariseCreatorDigitalSales({
      ...WINDOW,
      facts: facts({
        publications: [
          publication({ assetId: 'a-1' }),
          publication({ assetId: 'a-1' }),
          publication({ assetId: 'a-2' }),
          publication({ assetId: 'a-3', vertical: 'font' }),
        ],
      }),
    });
    expect(summary.publishedAssets).toEqual([
      { vertical: 'font', count: 1 },
      { vertical: 'three_d', count: 2 },
    ]);
  });
});

describe('#1015 W6 — views ARE suppressed, because they are somebody else\'s behaviour', () => {
  it('below the floor they are `null`, not zero', () => {
    const summary = summariseCreatorDigitalSales({
      ...WINDOW,
      facts: facts({ views: repeat(CREATOR_VIEW_MIN_COHORT - 1, () => view('paid')) }),
    });
    // `null` rather than 0: a creator reading 0 cannot tell "nobody looked" from
    // "we are not telling you", and only the first is actionable.
    expect(summary.views).toBeNull();
    expect(summary.viewsAboveCohortFloor).toBe(false);
  });

  it('at the floor they are reported — the control', () => {
    const summary = summariseCreatorDigitalSales({
      ...WINDOW,
      facts: facts({ views: repeat(CREATOR_VIEW_MIN_COHORT, () => view('paid')) }),
    });
    expect(summary.viewsAboveCohortFloor).toBe(true);
    expect(summary.views).toEqual({ free: 0, paid: CREATOR_VIEW_MIN_COHORT });
  });

  it('the floor is applied to the LARGER of free and paid, not to each', () => {
    const summary = summariseCreatorDigitalSales({
      ...WINDOW,
      facts: facts({
        views: [...repeat(CREATOR_VIEW_MIN_COHORT, () => view('paid')), view('free')],
      }),
    });
    // Suppressing per field would publish `paid: 10` and suppress `free: 1`, from
    // which `free` is bounded — the differencing attack the floor exists to stop.
    expect(summary.views).toEqual({ free: 1, paid: CREATOR_VIEW_MIN_COHORT });
  });

  it('the floor is the sibling domain\'s number, so two surfaces cannot be differenced', () => {
    expect(CREATOR_VIEW_MIN_COHORT).toBe(10);
  });
});

describe('#1015 W6 — the projection is the enforcement', () => {
  it('the summary has no field for a buyer, an order, a place or a device', () => {
    const summary = summariseCreatorDigitalSales({ ...WINDOW, facts: NO_DIGITAL_ANALYTICS_FACTS });
    assertEachOf(
      [
        'buyerKey',
        'oxyUserId',
        'guestSessionId',
        'orderId',
        'orderItemId',
        'pseudonymousSessionId',
        'ipAddress',
        'deviceFingerprint',
        'postalCode',
        'city',
      ],
      10,
      (field) => {
        expect(Object.keys(summary)).not.toContain(field);
      },
    );
  });

  it('every number travels with its definition', () => {
    const summary = summariseCreatorDigitalSales({ ...WINDOW, facts: NO_DIGITAL_ANALYTICS_FACTS });
    expect(summary.definitions.length).toBeGreaterThanOrEqual(6);
    for (const definition of summary.definitions) {
      expect(definition.denominator.length, `${definition.key} has no denominator`).toBeGreaterThan(
        10,
      );
      expect(
        definition.attributionLimit.length,
        `${definition.key} states no attribution limit`,
      ).toBeGreaterThan(20);
      expect(definition.scope).toContain('store');
    }
  });

  it('an empty window is an empty summary rather than a crash', () => {
    const summary = summariseCreatorDigitalSales({ ...WINDOW, facts: NO_DIGITAL_ANALYTICS_FACTS });
    expect(summary.paidSaleCount).toBe(0);
    expect(summary.amounts).toEqual([]);
    expect(summary.perAsset).toEqual([]);
    expect(summary.geography.countries).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('#1015 W13 — the launch metrics', () => {
  const LAUNCH_WINDOW = { from: '2026-08-01', to: '2026-08-31' };

  it('paid conversion divides by views of PAID options only', () => {
    const summary = computeLaunchMetrics({
      ...LAUNCH_WINDOW,
      facts: facts({
        sales: repeat(2, () => sale()),
        views: [...repeat(8, () => view('paid')), ...repeat(92, () => view('free'))],
      }),
    });
    // 2/8, not 2/100. Dividing by every view mixes the free catalogue into the rate
    // and flatters a creator for giving things away.
    expect(summary.paidConversionRate).toBeCloseTo(0.25, 10);
  });

  it('a zero denominator is `null`, never zero and never a division', () => {
    const summary = computeLaunchMetrics({ ...LAUNCH_WINDOW, facts: NO_DIGITAL_ANALYTICS_FACTS });
    expect(summary.paidConversionRate).toBeNull();
    expect(summary.refundRate).toBeNull();
    expect(summary.disputeRate).toBeNull();
    expect(summary.processing.successRate).toBeNull();
    expect(summary.processing.latencyMsP50).toBeNull();
    expect(summary.processing.latencyMsP95).toBeNull();
  });

  it('`unsupported` is in NEITHER half of the processing success rate', () => {
    const summary = computeLaunchMetrics({
      ...LAUNCH_WINDOW,
      facts: facts({
        processing: [
          ...repeat(8, () => processing({ verdict: 'measured' })),
          ...repeat(2, () => processing({ verdict: 'failed' })),
          // Ninety `.blend` files, which cannot be measured. None of them is a
          // failure, and folding them in either direction would be a claim the
          // pipeline never made.
          ...repeat(90, () => processing({ verdict: 'unsupported', latencyMs: null })),
        ],
      }),
    });
    expect(summary.processing.measuredCount).toBe(8);
    expect(summary.processing.failedCount).toBe(2);
    expect(summary.processing.unsupportedCount).toBe(90);
    expect(summary.processing.successRate).toBeCloseTo(0.8, 10);
  });

  it('the failure verdicts are a closed list and do not include the honest absences', () => {
    assertEachOf(['pending', 'measured', 'unsupported'] as const, 3, (verdict) => {
      expect(ASSET_PROCESSING_FAILURE_VERDICTS).not.toContain(verdict);
    });
    assertEachOf(['corrupt', 'missing_resources', 'failed', 'refused_too_large'] as const, 4, (verdict) => {
      expect(ASSET_PROCESSING_FAILURE_VERDICTS).toContain(verdict);
    });
  });

  it('a lost timing is excluded from latency rather than counted as zero', () => {
    const summary = computeLaunchMetrics({
      ...LAUNCH_WINDOW,
      facts: facts({
        processing: [
          processing({ latencyMs: 100 }),
          processing({ latencyMs: 200 }),
          processing({ latencyMs: 300 }),
          // Four runs whose duration was never recorded. A mean that treated these
          // as 0 would report the pipeline as faster the more often timing is lost.
          ...repeat(4, () => processing({ latencyMs: null })),
        ],
      }),
    });
    expect(summary.processing.measuredLatencyCount).toBe(3);
    expect(summary.processing.latencyMsP50).toBe(200);
    expect(summary.processing.latencyMsP95).toBe(300);
  });

  it('download refusals are reported by reason and never summed into one rate', () => {
    const summary = computeLaunchMetrics({
      ...LAUNCH_WINDOW,
      facts: facts({
        downloads: [
          ...repeat(40, () => download({ kind: 'refused', refusalReason: 'no_right' })),
          download({ kind: 'refused', refusalReason: 'grant_expired' }),
          download({ kind: 'completed' }),
        ],
      }),
    });
    const byReason = new Map(
      summary.downloadAuthorization.byReason.map((entry) => [entry.reason, entry.count]),
    );
    expect(byReason.get('no_right')).toBe(40);
    expect(byReason.get('grant_expired')).toBe(1);
    // Every reason in the tuple appears, zeros included, so a reason that stops
    // occurring does not silently vanish from a chart.
    expect(summary.downloadAuthorization.byReason).toHaveLength(9);
    expect(byReason.get('downloads_disabled')).toBe(0);
    // And there is no field that adds them up: `no_right` is an unauthenticated
    // probe's normal answer, not an operational error.
    expect(Object.keys(summary.downloadAuthorization)).not.toContain('errorRate');
  });

  it('refunds and disputes are two rates over one denominator', () => {
    const summary = computeLaunchMetrics({
      ...LAUNCH_WINDOW,
      facts: facts({
        sales: [
          ...repeat(8, () => sale()),
          sale({ refunded: true, disputed: true }),
          sale({ disputed: true }),
        ],
      }),
    });
    expect(summary.refundRate).toBeCloseTo(0.1, 10);
    expect(summary.disputeRate).toBeCloseTo(0.2, 10);
    // Adding them would double-count the line that is both, which is the worst case.
    expect(Object.keys(summary)).not.toContain('refundAndDisputeRate');
  });

  it('what buyers HOLD is reported by right status, zeros included', () => {
    const summary = computeLaunchMetrics({
      ...LAUNCH_WINDOW,
      facts: facts({
        rights: [
          ...repeat(5, () => right()),
          right({ status: 'refunded' }),
          right({ status: 'revoked_for_policy' }),
        ],
      }),
    });
    expect(summary.rights.activeCount).toBe(5);
    const byStatus = new Map(summary.rights.byStatus.map((entry) => [entry.status, entry.count]));
    expect(byStatus.get('refunded')).toBe(1);
    // A takedown going from 0 to 1 is the thing somebody is watching for, so the
    // status must be present at 0 rather than absent.
    expect(byStatus.get('revoked_for_policy')).toBe(1);
    expect(byStatus.get('disputed_hold')).toBe(0);
    expect(summary.rights.byStatus).toHaveLength(5);
  });

  it('GMV, realized fee and creator earnings are per currency', () => {
    const summary = computeLaunchMetrics({
      ...LAUNCH_WINDOW,
      facts: facts({
        sales: [
          sale({ currency: 'EUR', grossAmount: 1_000, realizedFeeAmount: 100, creatorEarningsAmount: 900 }),
          sale({ currency: 'GBP', grossAmount: 2_000, realizedFeeAmount: 200, creatorEarningsAmount: 1_800 }),
        ],
      }),
    });
    expect(summary.money).toEqual([
      { currency: 'EUR', gmvAmount: 1_000, realizedFeeAmount: 100, creatorEarningsAmount: 900 },
      { currency: 'GBP', gmvAmount: 2_000, realizedFeeAmount: 200, creatorEarningsAmount: 1_800 },
    ]);
  });

  it('the catalogue covers every metric W13 lists, and each is defined', () => {
    assertEachOf(
      [
        'digital_published_assets',
        'digital_views',
        'digital_downloads',
        'digital_paid_conversion',
        'digital_gmv',
        'digital_realized_fee',
        'digital_creator_earnings',
        'digital_processing_outcomes',
        'digital_download_authorization_errors',
        'digital_refund_dispute_rate',
        'digital_licence_option_mix',
        'digital_geographic_revenue',
      ],
      12,
      (key) => {
        const definition = digitalMetricByKey(key);
        expect(definition, `${key} has no definition`).toBeDefined();
        expect(definition?.scope.length).toBeGreaterThan(0);
      },
    );
    expect(DIGITAL_METRICS).toHaveLength(12);
    expect(digitalMetricByKey('not_a_metric')).toBeUndefined();
  });
});
