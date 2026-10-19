import { useMemo, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import {
  REFERRAL_OUTSTANDING_KEYS,
  REFERRAL_PAYOUT_STATUS_KEYS,
  REFERRAL_REWARD_STATE_EXPLANATION_KEYS,
  REFERRAL_REWARD_STATE_LABEL_KEYS,
  Text,
  describeMetric,
  describeRewardBasis,
  describeWithheldRows,
  formatMoney,
  useSettingsDialog,
  useSharedUiLocale,
} from '@mercaria/ui';
import { SettingsSelect } from '@mercaria/ui/settings';
import {
  REFERRAL_PERFORMANCE_DIMENSIONS,
  type CurrencyCode,
  type ReferralInstrumentStatus,
  type ReferralLinkPartnerView,
  type ReferralMetricDefinition,
  type ReferralPartnerDashboard,
  type ReferralPartnerOutstandingItem,
  type ReferralPerformanceDimension,
  type ReferralRewardState,
} from '@mercaria/shared-types';
import config from '@/lib/config';
import {
  useCreateReferralCode,
  useCreateReferralLink,
  useReferralDashboard,
  useReferralPerformance,
} from '@/lib/hooks/use-referral-partner';
import { useEnterReferralCode } from '@/lib/hooks/use-referral-binding';
import { useTranslation } from '@/lib/i18n';

/**
 * Payout readiness, as translation KEYS. A `Record` over the union, so a state
 * added to the readiness type fails `tsc` here instead of rendering a raw code;
 * KEYS rather than sentences, because a module-scope value is evaluated before
 * the locale store rehydrates. These are TERMS, only ever interpolated into
 * `referral.payouts.summary` (#442).
 */
const PAYOUT_READINESS_KEYS: Readonly<
  Record<ReferralPartnerDashboard['payouts']['identity'], string>
> = {
  unknown: 'referral.payouts.readiness.unknown',
  pending: 'referral.payouts.readiness.pending',
  ready: 'referral.payouts.readiness.ready',
  blocked: 'referral.payouts.readiness.blocked',
};

/**
 * An instrument's lifecycle, as KEYS (#560). `code.status` is a wire enum with
 * a localized form; `code.code` is an identifier a partner publishes and types,
 * so it is shown verbatim by design.
 */
const INSTRUMENT_STATUS_KEYS: Readonly<Record<ReferralInstrumentStatus, string>> = {
  active: 'referral.instruments.status.active',
  paused: 'referral.instruments.status.paused',
  expired: 'referral.instruments.status.expired',
  revoked: 'referral.instruments.status.revoked',
  retired: 'referral.instruments.status.retired',
};

/** The breakdown dimensions, as KEYS — never the raw enum member. */
const DIMENSION_KEYS: Readonly<Record<ReferralPerformanceDimension, string>> = {
  program: 'referral.performance.dimension.program',
  campaign: 'referral.performance.dimension.campaign',
  instrument: 'referral.performance.dimension.instrument',
  market: 'referral.performance.dimension.market',
  client_surface: 'referral.performance.dimension.clientSurface',
  date: 'referral.performance.dimension.date',
};

/**
 * What a partner pastes: `mercaria.co/r/<token>`, ADR 0005 D3's shape. The
 * storefront worker hands `/r/*` to the API's `GET /r/:token` with a redirect,
 * so the click's carrier is set on the API host that later binds it. A dev
 * server runs no worker, so a dev build points straight at its API.
 */
function shareUrl(link: ReferralLinkPartnerView): string {
  const origin = __DEV__
    ? config.apiUrl
    : Platform.OS === 'web' && typeof window !== 'undefined'
      ? window.location.origin
      : 'https://mercaria.co';
  return `${origin}/r/${link.token}`;
}

/** The URL as a person reads it, without the scheme. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//u, '');
}

function money(amountMinor: number, currency: CurrencyCode, locale: string): string {
  return formatMoney({ amount: amountMinor, currency }, locale);
}

/**
 * Referrals, as a Settings page (#147): the partner's own links first — the
 * thing they came for — then what those links earned and when it is paid.
 *
 * ## Everything here is the SERVER's answer about the signed-in account
 *
 * No partner id appears anywhere: the server resolves the owner from the
 * credential the request carries, so "a partner sees only their own numbers"
 * is a question this page cannot ask, not a check it performs.
 *
 * ## What simplifying it did NOT remove (#147 acceptance)
 *
 * Every figure still renders its definition, including what it cannot see
 * (`describeMetric`); a percentage always names its base
 * (`describeRewardBasis`); there is no conversion rate, the two counts sit side
 * by side; a suppressed breakdown says WHY (`describeWithheldRows`); the
 * disclosure a partner must publish is verbatim; and no financial state relies
 * on colour — every state is a word. Only the layout changed: Bloom's settings
 * rows instead of free text, and no section for a programme the owner is not in.
 */
export function ReferralsSettingsPage() {
  const { t } = useTranslation();
  const { isAuthenticated, openAccountDialog } = useOxy();
  const { afterClose } = useSettingsDialog();
  const dashboard = useReferralDashboard();

  if (!isAuthenticated) {
    return (
      <Page>
        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              label={t('referral.signedOut.title')}
              description={t('referral.signedOut.body')}
            >
              <Button
                size="sm"
                appearance="subtle"
                tone="neutral"
                onPress={() => afterClose(() => openAccountDialog())}
              >
                {t('referral.signedOut.action')}
              </Button>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </Page>
    );
  }
  if (dashboard.isPending) {
    return (
      <View className="items-center py-8">
        <Loading variant="inline" size="sm" />
      </View>
    );
  }
  if (dashboard.isError || !dashboard.data) {
    return (
      <Page>
        <Text className="px-3 text-sm text-destructive">{t('referral.loadError')}</Text>
      </Page>
    );
  }
  const data = dashboard.data;
  return (
    <Page>
      <LinksSection data={data} />
      <CodeEntrySection />
      <StandingSection
        earningStarted={data.enrollment.earningStarted}
        outstanding={data.enrollment.outstanding as ReferralPartnerOutstandingItem[]}
      />
      {data.partner ? (
        <>
          <EarningsSection earnings={data.earnings} />
          <PayoutsSection payouts={data.payouts} />
          <PerformanceSection window={data.performance} />
        </>
      ) : null}
      <ProgramsSection programs={data.programs} />
      {data.instruments.codes.length > 0 ? <CodesSection codes={data.instruments.codes} /> : null}
      <HelpSection support={data.support} />
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return <View className="gap-6">{children}</View>;
}

/**
 * A code somebody was given, typed here — ADR 0005 D4's `in_app` code entry.
 * Checkout stays referral-free on purpose (`commercial-presentation-isolation`):
 * a referral is acquisition history, and the purchase must never depend on it.
 *
 * Every refusal reads the same, so a stranger cannot learn which codes exist
 * (#143 code rule 6).
 */
function CodeEntrySection() {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const enter = useEnterReferralCode();
  const trimmed = code.trim();
  const terms = enter.data?.publicTermsSummary;

  const onApply = async () => {
    try {
      const result = await enter.mutateAsync(trimmed);
      if (result.state === 'attributed' || result.state === 'recorded_not_attributed') {
        setCode('');
        toast.success(t('referral.code.applied'));
      } else {
        toast.error(t('referral.code.invalid'));
      }
    } catch {
      toast.error(t('referral.code.failed'));
    }
  };

  return (
    <SettingsSection label={t('referral.code.title')} description={t('referral.code.description')}>
      <SettingsCard>
        <View className="flex-row items-center gap-3 p-3">
          <View className="flex-1">
            <TextFieldInput
              label={t('referral.code.label')}
              value={code}
              onValueChange={setCode}
              placeholder={t('referral.code.placeholder')}
              autoCapitalize="characters"
              autoCorrect={false}
              onSubmitEditing={trimmed ? () => void onApply() : undefined}
            />
          </View>
          <Button
            size="sm"
            appearance="subtle"
            tone="neutral"
            loading={enter.isPending}
            disabled={!trimmed || enter.isPending}
            onPress={() => void onApply()}
          >
            {t('referral.code.apply')}
          </Button>
        </View>
        {/* The program's own buyer-facing terms, verbatim, once they apply. */}
        {terms ? <SettingsRow label={terms} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

/** The page's reason to exist: a link to share, copied in one press. */
function LinksSection({ data }: { data: ReferralPartnerDashboard }) {
  const { t } = useTranslation();
  const createCode = useCreateReferralCode();
  const createLink = useCreateReferralLink();
  const links = data.instruments.links.filter((link) => link.status === 'active');
  const activeCode = data.instruments.codes.find((code) => code.status === 'active');
  // A code is issued under a programme whose current terms this owner has
  // accepted; the server re-checks every condition, this only hides a control
  // that would certainly be refused.
  const program = data.programs.find((offer) => offer.eligible && offer.termsAccepted);
  const canCreate = Boolean(data.partner) && Boolean(activeCode ?? program);
  const creating = createCode.isPending || createLink.isPending;

  const copy = async (url: string) => {
    await Clipboard.setStringAsync(url);
    toast.success(t('referral.links.copied'));
  };

  const onCreate = async () => {
    try {
      const code =
        activeCode ??
        (program
          ? await createCode.mutateAsync({ programId: program.program.programId })
          : undefined);
      if (!code) return;
      const link = await createLink.mutateAsync({ codeId: code.id });
      await copy(shareUrl(link));
    } catch {
      toast.error(t('referral.links.createFailed'));
    }
  };

  return (
    <SettingsSection
      label={t('referral.links.title')}
      action={
        canCreate ? (
          <Button
            size="sm"
            appearance="subtle"
            tone="neutral"
            loading={creating}
            disabled={creating}
            onPress={onCreate}
          >
            {t('referral.links.create')}
          </Button>
        ) : undefined
      }
    >
      <SettingsCard>
        {links.length === 0 ? (
          <SettingsRow
            label={canCreate ? t('referral.links.empty') : t('referral.links.notPartner')}
          />
        ) : (
          links.map((link) => {
            const url = shareUrl(link);
            return (
              <SettingsRow key={link.id} label={displayUrl(url)} description={link.campaignRef}>
                <Button
                  size="sm"
                  appearance="subtle"
                  tone="neutral"
                  accessibilityLabel={t('referral.links.copyLink', { url: displayUrl(url) })}
                  onPress={() => void copy(url)}
                >
                  {t('referral.links.copy')}
                </Button>
              </SettingsRow>
            );
          })
        )}
        {/* The disclosure a partner must publish, VERBATIM and never
            summarised: it is Mercaria's published consumer-law statement, and a
            paraphrase is a different statement. */}
        <SettingsRow
          label={t('referral.instruments.disclosureIntro')}
          description={`“${data.instruments.disclosureText}”`}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function StandingSection(props: {
  earningStarted: boolean;
  outstanding: readonly ReferralPartnerOutstandingItem[];
}) {
  const { t } = useTranslation();
  // Earning and being PAID are two answers with two inputs: an unfinished form
  // gates payout, never accrual, and the page says so rather than letting a
  // checklist read as money at risk.
  return (
    <SettingsSection
      label={t('referral.standing.title')}
      description={
        props.outstanding.length > 0 ? t('referral.standing.accrualContinues') : undefined
      }
    >
      <SettingsCard>
        <SettingsRow
          label={
            props.earningStarted
              ? t('referral.standing.earning')
              : t('referral.standing.notEarning')
          }
        />
        {props.outstanding.length === 0 ? (
          <SettingsRow label={t('referral.standing.nothingOutstanding')} />
        ) : (
          props.outstanding.map((item) => (
            <SettingsRow
              key={item}
              label={t(REFERRAL_OUTSTANDING_KEYS[item])}
              description={t('referral.standing.beforePaid')}
            />
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function AmountText({ children }: { children: string }) {
  return <Text className="text-sm font-semibold text-foreground">{children}</Text>;
}

function EarningsSection({ earnings }: { earnings: ReferralPartnerDashboard['earnings'] }) {
  const { t } = useTranslation();
  const locale = useSharedUiLocale();
  const states: readonly [
    ReferralRewardState,
    'heldMinor' | 'vestedMinor' | 'paidMinor' | 'reversedMinor',
  ][] = [
    ['held', 'heldMinor'],
    ['vested', 'vestedMinor'],
    ['paid', 'paidMinor'],
    ['voided', 'reversedMinor'],
  ];
  // The `countsAgree` device, surfaced: a partner asking about their balance
  // must not be shown two stores that disagree in silence.
  const reconciling = earnings.byCurrency.some((row) => !row.ledgerAgrees);
  return (
    <SettingsSection
      label={t('referral.earnings.title')}
      description={reconciling ? t('referral.earnings.reconciling') : undefined}
    >
      <SettingsCard>
        {earnings.byCurrency.length === 0 ? (
          <SettingsRow label={t('referral.earnings.empty')} />
        ) : (
          earnings.byCurrency.flatMap((row) => [
            ...states.map(([state, field]) => (
              <SettingsRow
                key={`${row.currency}:${state}`}
                label={t(REFERRAL_REWARD_STATE_LABEL_KEYS[state])}
                description={t(REFERRAL_REWARD_STATE_EXPLANATION_KEYS[state])}
              >
                <AmountText>{money(row[field], row.currency, locale)}</AmountText>
              </SettingsRow>
            )),
            // Two WHOLE sentences, not one plus an appended parenthetical:
            // where the minimum sits is the translator's decision.
            <SettingsRow
              key={`${row.currency}:payable`}
              label={
                row.payoutMinimumMinor !== undefined
                  ? t('referral.earnings.availableNowWithMinimum', {
                      amount: money(row.payableNowMinor, row.currency, locale),
                      minimum: money(row.payoutMinimumMinor, row.currency, locale),
                    })
                  : t('referral.earnings.availableNow', {
                      amount: money(row.payableNowMinor, row.currency, locale),
                    })
              }
            />,
          ])
        )}
        <SettingsRow
          label={t('referral.earnings.pendingConversions', { count: earnings.pendingConversions })}
        />
        {metricRows(t, earnings.metrics)}
      </SettingsCard>
    </SettingsSection>
  );
}

function PayoutsSection({ payouts }: { payouts: ReferralPartnerDashboard['payouts'] }) {
  const { t } = useTranslation();
  const locale = useSharedUiLocale();
  return (
    <SettingsSection label={t('referral.payouts.title')}>
      <SettingsCard>
        <SettingsRow
          label={t('referral.payouts.summary', {
            identity: t(PAYOUT_READINESS_KEYS[payouts.identity]),
            tax: t(PAYOUT_READINESS_KEYS[payouts.tax]),
            payout: t(PAYOUT_READINESS_KEYS[payouts.payout]),
          })}
        />
        <SettingsRow
          label={
            payouts.beneficiaryLast4
              ? t('referral.payouts.destinationEnding', { last4: payouts.beneficiaryLast4 })
              : t('referral.payouts.noDestination')
          }
        />
        {payouts.recentPayouts.length === 0 ? (
          <SettingsRow label={t('referral.payouts.none')} />
        ) : (
          payouts.recentPayouts.map((batch, index) => (
            <SettingsRow
              // biome-ignore lint/suspicious/noArrayIndexKey: a batch carries no id by design (A5), and two can settle on one day; the list is never reordered.
              key={`${batch.date}:${index}`}
              label={batch.date}
              description={t(REFERRAL_PAYOUT_STATUS_KEYS[batch.status])}
            >
              <AmountText>{money(batch.netPayoutMinor, batch.currency, locale)}</AmountText>
            </SettingsRow>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function PerformanceSection({ window }: { window: ReferralPartnerDashboard['performance'] }) {
  const { t } = useTranslation();
  const [dimension, setDimension] = useState<ReferralPerformanceDimension>('date');
  const breakdown = useReferralPerformance({
    dimension,
    from: window.from,
    through: window.through,
  });
  // The dashboard's own trailing-30-day breakdown paints first, so changing
  // the dimension never blanks the section while a request is in flight.
  const performance = dimension === 'date' ? window : breakdown.data;
  const items = useMemo(
    () =>
      REFERRAL_PERFORMANCE_DIMENSIONS.map((value) => ({ value, label: t(DIMENSION_KEYS[value]) })),
    [t],
  );
  return (
    <SettingsSection
      label={t('referral.performance.title')}
      description={
        performance && performance.withheldRowCount > 0
          ? describeWithheldRows(t, {
              withheldRowCount: performance.withheldRowCount,
              floor: performance.disclosureFloor ?? 0,
              everythingWithheld: performance.rows.length === 0,
            })
          : undefined
      }
      action={
        <SettingsSelect
          label={t('referral.performance.breakdownBy')}
          value={dimension}
          onChange={setDimension}
          items={items}
        />
      }
    >
      <SettingsCard>
        {!performance ? (
          <View className="items-center py-4">
            <Loading variant="inline" size="sm" />
          </View>
        ) : (
          [
            // Clicks and referrals side by side and deliberately NO rate
            // between them: a conversion is revisable for weeks while a click
            // is not, so the ratio moves with neither input wrong.
            <SettingsRow
              key="totals"
              label={t('referral.performance.totals', {
                clicks: performance.totals.humanClicks,
                referrals: performance.totals.qualifiedConversions,
                from: performance.from,
                through: performance.through,
              })}
            />,
            ...(performance.rows.length === 0 && performance.withheldRowCount === 0
              ? [<SettingsRow key="empty" label={t('referral.performance.empty')} />]
              : performance.rows.map((row) => (
                  <SettingsRow
                    key={row.key}
                    label={t('referral.performance.row', {
                      label: row.label,
                      clicks: row.humanClicks,
                      referrals: row.qualifiedConversions,
                    })}
                  />
                ))),
            ...metricRows(t, performance.metrics),
          ]
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function ProgramsSection({ programs }: { programs: ReferralPartnerDashboard['programs'] }) {
  const { t, locale } = useTranslation();
  return (
    <SettingsSection label={t('referral.programs.title')}>
      <SettingsCard>
        {programs.length === 0 ? (
          <SettingsRow label={t('referral.programs.empty')} />
        ) : (
          programs.map((offer) => (
            <SettingsRow
              key={`${offer.program.programId}:${offer.program.version}`}
              label={offer.program.name}
              // The revenue base, always, and never an abbreviation of it. No
              // earnings projection: the projection has no field to carry one.
              description={[
                describeRewardBasis(t, locale, offer.rewardBasis),
                offer.program.publicTermsSummary,
                t('referral.programs.attributionWindow', {
                  days: offer.program.attributionWindowDays,
                }),
                offer.termsAccepted
                  ? t('referral.programs.termsAccepted')
                  : t('referral.programs.termsNotAccepted'),
              ].join(' ')}
            />
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function CodesSection({ codes }: { codes: ReferralPartnerDashboard['instruments']['codes'] }) {
  const { t } = useTranslation();
  return (
    <SettingsSection label={t('referral.instruments.title')}>
      <SettingsCard>
        {codes.map((code) => (
          <SettingsRow
            key={code.id}
            label={code.code}
            description={[t(INSTRUMENT_STATUS_KEYS[code.status]), code.market, code.campaignRef]
              .filter(Boolean)
              .join(' · ')}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function HelpSection({ support }: { support: ReferralPartnerDashboard['support'] }) {
  const { t } = useTranslation();
  // Named seams, so the page promises nothing it cannot do.
  const rows = [
    support.appealAvailable ? t('referral.support.appeal') : null,
    support.unavailable.includes('dispute_thread_not_built')
      ? t('referral.support.disputes')
      : null,
    support.unavailable.includes('outbound_notification_transport_not_configured')
      ? t('referral.support.noEmails')
      : null,
  ].filter((row): row is string => row !== null);
  if (rows.length === 0) return null;
  return (
    <SettingsSection label={t('referral.support.title')}>
      <SettingsCard>
        {rows.map((row) => (
          <SettingsRow key={row} label={row} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * Every figure's definition, as rows (#77): a number whose definition is
 * unstated cannot be checked, and the ATTRIBUTION LIMIT — what it cannot see —
 * is the half a partner reconciling their earnings needs.
 */
function metricRows(
  t: ReturnType<typeof useTranslation>['t'],
  definitions: readonly ReferralMetricDefinition[],
) {
  return definitions.map((definition) => (
    <SettingsRow
      key={`metric:${definition.key}`}
      label={definition.label}
      description={describeMetric(t, definition)}
    />
  ));
}
