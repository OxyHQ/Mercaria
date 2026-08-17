import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Head from "expo-router/head";
import { Users } from "lucide-react-native";
import { openAccountDialog, useOxy } from "@oxyhq/services";
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
  useSharedUiLocale,
} from "@mercaria/ui";
import {
  REFERRAL_PERFORMANCE_DIMENSIONS,
  type CurrencyCode,
  type ReferralEarningsByCurrency,
  type ReferralMetricDefinition,
  type ReferralPartnerOutstandingItem,
  type ReferralPerformanceDimension,
  type ReferralRewardState,
} from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import {
  useReferralDashboard,
  useReferralPerformance,
} from "@/lib/hooks/use-referral-partner";
import { useTranslation } from "@/lib/i18n";

/** Icon size for the empty-state badge. */
const EMPTY_ICON_SIZE = 28;

/**
 * The word each payout-readiness state reads as INSIDE the payouts sentence.
 *
 * A `Record` over the union rather than an array, so adding a state to
 * `ReferralPayoutReadiness` fails `tsc` here instead of silently rendering a
 * raw code. It holds KEYS and not sentences: a module-scope `const` is
 * evaluated at import, before the locale store has rehydrated, so a value here
 * would freeze whichever language loaded first.
 *
 * These are TERMS and are only ever interpolated into
 * `referral.payouts.summary` — never rendered as a control's own label — which
 * is the #442 separation. The English words are byte-identical to what this
 * screen rendered before extraction (the raw enum member), so English output
 * does not move; every other language stops reading an English code in the
 * middle of a translated sentence.
 */
const PAYOUT_READINESS_KEYS: Readonly<
  Record<
    NonNullable<ReturnType<typeof useReferralDashboard>["data"]>["payouts"]["identity"],
    string
  >
> = {
  unknown: "referral.payouts.readiness.unknown",
  pending: "referral.payouts.readiness.pending",
  ready: "referral.payouts.readiness.ready",
  blocked: "referral.payouts.readiness.blocked",
};
Object.freeze(PAYOUT_READINESS_KEYS);

/**
 * The referral partner dashboard (#147 acceptance 1).
 *
 * ## Everything on this page is the SERVER's answer about the signed-in account
 *
 * There is no partner id anywhere in this file — not in a route parameter, not
 * in a query key, not in a request. The server resolves the owner from the
 * credential the request already carries, so "a partner sees their own numbers
 * and nobody else's" is not a check this screen performs; it is a question this
 * screen cannot ask.
 *
 * ## Every figure renders its own definition (#147 acceptance 7)
 *
 * A conversion rate is deliberately absent — #37 acceptance 3 forbids dividing
 * clicks by conversions, and a conversion is revisable for weeks while a click
 * is not — and every percentage names its revenue base through
 * `describeRewardBasis`, whose percentage branch cannot render a bare rate.
 *
 * ## A suppressed breakdown says WHY (#147 accessibility rule 1)
 *
 * `describeWithheldRows` explains the suppression rather than reporting an
 * absence of activity, because a partner told the wrong one goes looking for a
 * bug in their promotion. Nothing on this page relies on colour to carry a
 * financial state: every badge is a word.
 *
 * ## Signed out, it offers rather than gates
 *
 * A partner record hangs off an Oxy account, so there is genuinely nothing to
 * show somebody who is not signed in — the `price-alerts` posture.
 */
export default function ReferralPartnerScreen() {
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const dashboard = useReferralDashboard();
  const [dimension, setDimension] = useState<ReferralPerformanceDimension>("date");

  const window = dashboard.data?.performance;
  const breakdown = useReferralPerformance({
    dimension,
    from: window?.from,
    through: window?.through,
  });

  // The dashboard's own trailing-30-day breakdown paints first, so the picker
  // never leaves the section blank while a second request is in flight.
  const performance = dimension === "date" && window ? window : breakdown.data;

  const outstanding = useMemo(
    () => (dashboard.data?.enrollment.outstanding ?? []) as ReferralPartnerOutstandingItem[],
    [dashboard.data],
  );

  return (
    <ScreenShell>
      <Head>
        <title>{t("referral.documentTitle")}</title>
      </Head>

      {/* NO inner `ScrollView`, which is `ScreenShell`'s own contract rather
          than a preference: on web the BODY scrolls and an inner scroller would
          break `ContentPanel`'s sticky overlays, and on NATIVE the shell has
          already put the body in a full-height `ScrollView` — so a second one
          is two nested scrollers. This file shipped with one and it was
          measured out rather than reasoned out: an A/B in a real browser tab
          found the document scroll height, the viewport and the last card's
          position IDENTICAL either way, because RN-Web renders a height-less
          `ScrollView` as a plain flex container. So the web half is a
          convention followed and not a bug fixed; the NATIVE half is the real
          hazard and is UNVERIFIED here — no native build was run. */}
      <View className="gap-space-16 px-space-16 py-space-20">
        <Text className="text-2xl font-bold text-foreground">{t("referral.title")}</Text>

        {!isAuthenticated ? (
          <SignedOutInvitation />
        ) : dashboard.isPending ? (
          <View className="items-center py-space-32">
            <ActivityIndicator />
          </View>
        ) : dashboard.isError ? (
          <Text className="text-sm text-destructive">{t("referral.loadError")}</Text>
        ) : !dashboard.data ? null : (
          <>
            {/* `agreementStanding` is deliberately NOT passed: `outstanding`
                already carries it as a sentence a partner can act on ("accept
                the new version"), and a second rendering of one fact is two
                things that can disagree. */}
            <EnrollmentCard
              earningStarted={dashboard.data.enrollment.earningStarted}
              outstanding={outstanding}
            />

            <ProgramsCard programs={dashboard.data.programs} />

            <EarningsCard earnings={dashboard.data.earnings} />

            <PayoutCard payouts={dashboard.data.payouts} />

            <PerformanceCard
              dimension={dimension}
              onDimension={setDimension}
              loading={breakdown.isPending && dimension !== "date"}
              performance={performance}
            />

            <InstrumentsCard instruments={dashboard.data.instruments} />

            <SupportCard support={dashboard.data.support} />
          </>
        )}
      </View>
    </ScreenShell>
  );
}

function SignedOutInvitation() {
  const { t } = useTranslation();
  return (
    <View className="items-center gap-space-12 rounded-2xl border border-border bg-surface px-space-16 py-space-32">
      <Users size={EMPTY_ICON_SIZE} className="text-muted-foreground" />
      <Text className="text-center text-base font-semibold text-foreground">
        {t("referral.signedOut.title")}
      </Text>
      <Text className="text-center text-sm text-muted-foreground">
        {t("referral.signedOut.body")}
      </Text>
      <Pressable
        accessibilityRole="button"
        className="rounded-full bg-primary px-space-16 py-space-8"
        onPress={() => openAccountDialog()}
      >
        <Text className="text-sm font-semibold text-primary-foreground">
          {t("referral.signedOut.action")}
        </Text>
      </Pressable>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-space-8 rounded-2xl border border-border bg-surface p-space-16">
      <Text className="text-base font-semibold text-foreground">{title}</Text>
      {children}
    </View>
  );
}

function EnrollmentCard(props: {
  earningStarted: boolean;
  outstanding: readonly ReferralPartnerOutstandingItem[];
}) {
  const { t } = useTranslation();
  return (
    <Section title={t("referral.standing.title")}>
      {/* Earning and WITHDRAWAL are two different answers with two different
          inputs; collapsing them into one progress bar is what makes a partner
          think their accrued balance is at risk because a form is unfinished,
          which it is not. */}
      <Text className="text-sm text-muted-foreground">
        {props.earningStarted
          ? t("referral.standing.earning")
          : t("referral.standing.notEarning")}
      </Text>
      {props.outstanding.length === 0 ? (
        <Text className="text-sm text-muted-foreground">
          {t("referral.standing.nothingOutstanding")}
        </Text>
      ) : (
        <View className="gap-space-4">
          <Text className="text-sm text-foreground">{t("referral.standing.beforePaid")}</Text>
          {props.outstanding.map((item) => (
            <Text key={item} className="text-sm text-muted-foreground">
              • {REFERRAL_OUTSTANDING_KEYS[item] ? t(REFERRAL_OUTSTANDING_KEYS[item]) : item}
            </Text>
          ))}
          {/* Stated explicitly, because it is the thing a partner assumes
              wrongly: nothing is lost and nothing expires while a form is
              unfinished. Payout is gated; accrual is not. */}
          <Text className="text-xs text-muted-foreground">
            {t("referral.standing.accrualContinues")}
          </Text>
        </View>
      )}
    </Section>
  );
}

function ProgramsCard({
  programs,
}: {
  programs: NonNullable<ReturnType<typeof useReferralDashboard>["data"]>["programs"];
}) {
  const { t, locale } = useTranslation();
  if (programs.length === 0) {
    return (
      <Section title={t("referral.programs.title")}>
        <Text className="text-sm text-muted-foreground">{t("referral.programs.empty")}</Text>
      </Section>
    );
  }
  return (
    <Section title={t("referral.programs.title")}>
      {programs.map((offer) => (
        <View key={`${offer.program.programId}:${offer.program.version}`} className="gap-space-4">
          <Text className="text-sm font-semibold text-foreground">{offer.program.name}</Text>
          {/* The revenue base, always, and never an abbreviation of it. */}
          <Text className="text-sm text-muted-foreground">
            {describeRewardBasis(t, locale, offer.rewardBasis)}
          </Text>
          <Text className="text-xs text-muted-foreground">{offer.program.publicTermsSummary}</Text>
          <Text className="text-xs text-muted-foreground">
            {t("referral.programs.attributionWindow", {
              days: offer.program.attributionWindowDays,
            })}{" "}
            {offer.termsAccepted
              ? t("referral.programs.termsAccepted")
              : t("referral.programs.termsNotAccepted")}
          </Text>
          {/* No earnings projection, no "typical partner earns" figure: there is
              no field on the projection that could carry one, which is #147
              programme rule 7 as a shape rather than a copy review. */}
        </View>
      ))}
    </Section>
  );
}

function money(amountMinor: number, currency: CurrencyCode, locale: string): string {
  return formatMoney({ amount: amountMinor, currency }, locale);
}

function EarningsCard({
  earnings,
}: {
  earnings: NonNullable<ReturnType<typeof useReferralDashboard>["data"]>["earnings"];
}) {
  const { t } = useTranslation();
  const locale = useSharedUiLocale();
  return (
    <Section title={t("referral.earnings.title")}>
      {earnings.byCurrency.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t("referral.earnings.empty")}</Text>
      ) : (
        earnings.byCurrency.map((row: ReferralEarningsByCurrency) => (
          <View key={row.currency} className="gap-space-4">
            <StateRow state="held" amount={money(row.heldMinor, row.currency, locale)} />
            <StateRow state="vested" amount={money(row.vestedMinor, row.currency, locale)} />
            <StateRow state="paid" amount={money(row.paidMinor, row.currency, locale)} />
            <StateRow state="voided" amount={money(row.reversedMinor, row.currency, locale)} />
            {/* Two WHOLE sentences rather than one plus an appended
                parenthetical: where the minimum sits in the sentence, and
                whether it is parenthesised at all, is a per-language decision a
                concatenation takes away from the translator. */}
            <Text className="text-sm text-foreground">
              {row.payoutMinimumMinor !== undefined
                ? t("referral.earnings.availableNowWithMinimum", {
                    amount: money(row.payableNowMinor, row.currency, locale),
                    minimum: money(row.payoutMinimumMinor, row.currency, locale),
                  })
                : t("referral.earnings.availableNow", {
                    amount: money(row.payableNowMinor, row.currency, locale),
                  })}
            </Text>
            {/* The `countsAgree` device, surfaced. Two stores that must agree
                without something comparing them is a discrepancy nobody
                notices, and a partner asking about their balance is exactly who
                must not be shown two numbers that disagree in silence. */}
            {!row.ledgerAgrees ? (
              <Text className="text-xs text-destructive">
                {t("referral.earnings.reconciling")}
              </Text>
            ) : null}
          </View>
        ))
      )}
      <Text className="text-xs text-muted-foreground">
        {t("referral.earnings.pendingConversions", { count: earnings.pendingConversions })}
      </Text>
      <MetricDefinitions definitions={earnings.metrics} />
    </Section>
  );
}

/** One state, its amount and the sentence saying what is true of that money. */
function StateRow({ state, amount }: { state: ReferralRewardState; amount: string }) {
  const { t } = useTranslation();
  return (
    <View className="gap-space-2">
      <Text className="text-sm text-foreground">
        {t(REFERRAL_REWARD_STATE_LABEL_KEYS[state])}: {amount}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {t(REFERRAL_REWARD_STATE_EXPLANATION_KEYS[state])}
      </Text>
    </View>
  );
}

function PayoutCard({
  payouts,
}: {
  payouts: NonNullable<ReturnType<typeof useReferralDashboard>["data"]>["payouts"];
}) {
  const { t } = useTranslation();
  const locale = useSharedUiLocale();
  return (
    <Section title={t("referral.payouts.title")}>
      <Text className="text-sm text-muted-foreground">
        {t("referral.payouts.summary", {
          identity: t(PAYOUT_READINESS_KEYS[payouts.identity]),
          tax: t(PAYOUT_READINESS_KEYS[payouts.tax]),
          payout: t(PAYOUT_READINESS_KEYS[payouts.payout]),
        })}
      </Text>
      {payouts.beneficiaryLast4 ? (
        <Text className="text-sm text-muted-foreground">
          {t("referral.payouts.destinationEnding", { last4: payouts.beneficiaryLast4 })}
        </Text>
      ) : (
        <Text className="text-sm text-muted-foreground">
          {t("referral.payouts.noDestination")}
        </Text>
      )}
      {payouts.recentPayouts.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t("referral.payouts.none")}</Text>
      ) : (
        payouts.recentPayouts.map((batch, index) => (
          <Text key={`${batch.date}:${index}`} className="text-sm text-foreground">
            {batch.date} — {money(batch.netPayoutMinor, batch.currency, locale)} —{" "}
            {REFERRAL_PAYOUT_STATUS_KEYS[batch.status] ? t(REFERRAL_PAYOUT_STATUS_KEYS[batch.status]) : batch.status}
          </Text>
        ))
      )}
    </Section>
  );
}

function PerformanceCard(props: {
  dimension: ReferralPerformanceDimension;
  onDimension: (next: ReferralPerformanceDimension) => void;
  loading: boolean;
  performance:
    | NonNullable<ReturnType<typeof useReferralDashboard>["data"]>["performance"]
    | undefined;
}) {
  const { t } = useTranslation();
  const { performance } = props;
  return (
    <Section title={t("referral.performance.title")}>
      <View className="flex-row flex-wrap gap-space-8">
        {REFERRAL_PERFORMANCE_DIMENSIONS.map((option) => (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: option === props.dimension }}
            className={
              option === props.dimension
                ? "rounded-full bg-primary px-space-12 py-space-4"
                : "rounded-full border border-border px-space-12 py-space-4"
            }
            onPress={() => props.onDimension(option)}
          >
            <Text
              className={
                option === props.dimension
                  ? "text-xs font-semibold text-primary-foreground"
                  : "text-xs text-foreground"
              }
            >
              {option.replace(/_/gu, " ")}
            </Text>
          </Pressable>
        ))}
      </View>

      {props.loading || !performance ? (
        <ActivityIndicator />
      ) : (
        <>
          <Text className="text-sm text-foreground">
            {t("referral.performance.totals", {
              clicks: performance.totals.humanClicks,
              referrals: performance.totals.qualifiedConversions,
              from: performance.from,
              through: performance.through,
            })}
          </Text>
          {/* Deliberately NO rate between those two numbers — see the file
              docblock. They sit beside each other so anybody who wants the
              ratio takes it knowingly. */}
          {performance.rows.length === 0 && performance.withheldRowCount === 0 ? (
            <Text className="text-sm text-muted-foreground">
              {t("referral.performance.empty")}
            </Text>
          ) : (
            performance.rows.map((row) => (
              <Text key={row.key} className="text-sm text-foreground">
                {t("referral.performance.row", {
                  label: row.label,
                  clicks: row.humanClicks,
                  referrals: row.qualifiedConversions,
                })}
              </Text>
            ))
          )}
          {performance.withheldRowCount > 0 ? (
            <Text className="text-xs text-muted-foreground">
              {describeWithheldRows(t, {
                withheldRowCount: performance.withheldRowCount,
                floor: performance.disclosureFloor ?? 0,
                everythingWithheld: performance.rows.length === 0,
              })}
            </Text>
          ) : null}
          <MetricDefinitions definitions={performance.metrics} />
        </>
      )}
    </Section>
  );
}

function InstrumentsCard({
  instruments,
}: {
  instruments: NonNullable<ReturnType<typeof useReferralDashboard>["data"]>["instruments"];
}) {
  const { t } = useTranslation();
  return (
    <Section title={t("referral.instruments.title")}>
      {instruments.codes.length === 0 ? (
        <Text className="text-sm text-muted-foreground">{t("referral.instruments.empty")}</Text>
      ) : (
        instruments.codes.map((code) => (
          <View key={code.id} className="gap-space-2">
            <Text className="text-sm font-semibold text-foreground">{code.code}</Text>
            <Text className="text-xs text-muted-foreground">
              {code.status}
              {code.market ? ` · ${code.market}` : ""}
              {code.campaignRef ? ` · ${code.campaignRef}` : ""}
            </Text>
          </View>
        ))
      )}
      {/* The disclosure a partner must publish, rendered VERBATIM and never
          summarised: it is Mercaria's published consumer-law statement, and a
          paraphrase is a different statement. */}
      <Text className="text-sm text-foreground">{t("referral.instruments.disclosureIntro")}</Text>
      <Text className="text-sm text-muted-foreground">“{instruments.disclosureText}”</Text>
    </Section>
  );
}

function SupportCard({
  support,
}: {
  support: NonNullable<ReturnType<typeof useReferralDashboard>["data"]>["support"];
}) {
  const { t } = useTranslation();
  return (
    <Section title={t("referral.support.title")}>
      {support.appealAvailable ? (
        <Text className="text-sm text-foreground">{t("referral.support.appeal")}</Text>
      ) : null}
      {/* Named seams, so the page promises nothing it cannot do. A support
          entry point that leads nowhere is worse than one that says the channel
          does not exist yet. */}
      {support.unavailable.includes("dispute_thread_not_built") ? (
        <Text className="text-sm text-muted-foreground">{t("referral.support.disputes")}</Text>
      ) : null}
      {support.unavailable.includes("outbound_notification_transport_not_configured") ? (
        <Text className="text-xs text-muted-foreground">{t("referral.support.noEmails")}</Text>
      ) : null}
    </Section>
  );
}

/**
 * Every figure's definition, rendered as text.
 *
 * #77's rule applied to a surface somebody is paid against: a number whose
 * definition is unstated cannot be checked, and the ATTRIBUTION LIMIT — what
 * the figure cannot see — is the half that matters when a partner is
 * reconciling their own earnings.
 */
function MetricDefinitions({ definitions }: { definitions: readonly ReferralMetricDefinition[] }) {
  const { t } = useTranslation();
  if (definitions.length === 0) return null;
  return (
    <View className="gap-space-4 pt-space-8">
      {definitions.map((definition) => (
        <View key={definition.key} className="gap-space-2">
          <Text className="text-xs font-semibold text-foreground">{definition.label}</Text>
          <Text className="text-xs text-muted-foreground">{describeMetric(t, definition)}</Text>
        </View>
      ))}
    </View>
  );
}
