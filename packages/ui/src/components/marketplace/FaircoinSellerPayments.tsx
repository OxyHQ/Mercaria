import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import type {
  FaircoinSellerState,
  FaircoinUnavailableReason,
  SellerFaircoinStatus,
} from '@mercaria/shared-types';
import { Text } from '../ui/text';
import { formatDate } from '../../lib/date';
import { useSharedUiLocale, useSharedUiTranslation } from '../../i18n/ui-translation';

/**
 * Who receives a seller's FairCoin (ADR 0019 D2): the Oxy account that OWNS a
 * store (often an organization, never the member reading the screen), or a
 * private seller themself. The two read differently because the person who must
 * confirm is different — a store's member confirms as, or acting as, the owning
 * account.
 */
export type FaircoinSellerAudience = 'store' | 'self';

export interface FaircoinSellerPaymentsProps {
  faircoin: SellerFaircoinStatus;
  audience: FaircoinSellerAudience;
  /**
   * The receiving Oxy account in words (a display name or handle), resolved by
   * the app. Absent while it loads; the row then shows the account id the
   * settings carry, and nothing when there is none yet.
   */
  receivingAccountName?: string;
  /**
   * Whether a confirmation link can be minted on this deployment at all
   * (`SellerPaymentSettings.onboardingAvailable`). The rail itself being off is
   * `rail_disabled`, which the reason line already says in words.
   */
  onboardingAvailable: boolean;
  /** Mint Peable's confirmation link and open it — the app's own card-onboarding pattern. */
  onConfirm: () => void;
  busy: boolean;
}

/**
 * Each state in words. A `Record`, so a new state fails `tsc` here rather than
 * rendering nothing.
 */
const STATE_COPY: Record<FaircoinSellerState, string> = {
  not_connected: 'ui.faircoinSeller.state.notConnected',
  pending: 'ui.faircoinSeller.state.pending',
  active: 'ui.faircoinSeller.state.active',
};

/**
 * Why FairCoin cannot be paid, in words — per audience where the remedy names
 * the account that must act. KEYS, each a full literal, for the reason
 * `FeeScheduleTerms` gives: `validate:i18n-strings` resolves literals, and a
 * key composed at runtime could go missing from a bundle unnoticed.
 */
const REASON_COPY: Record<FaircoinUnavailableReason, Record<FaircoinSellerAudience, string>> = {
  faircoin_wallet_missing: {
    store: 'ui.faircoinSeller.reason.walletMissingStore',
    self: 'ui.faircoinSeller.reason.walletMissingSelf',
  },
  faircoin_network_closed: {
    store: 'ui.faircoinSeller.reason.networkClosed',
    self: 'ui.faircoinSeller.reason.networkClosed',
  },
  price_unavailable: {
    store: 'ui.faircoinSeller.reason.priceUnavailable',
    self: 'ui.faircoinSeller.reason.priceUnavailable',
  },
  temporarily_unavailable: {
    store: 'ui.faircoinSeller.reason.temporarilyUnavailable',
    self: 'ui.faircoinSeller.reason.temporarilyUnavailable',
  },
  seller_not_connected: {
    store: 'ui.faircoinSeller.reason.notConnected',
    self: 'ui.faircoinSeller.reason.notConnected',
  },
  seller_not_confirmed: {
    store: 'ui.faircoinSeller.reason.notConfirmed',
    self: 'ui.faircoinSeller.reason.notConfirmed',
  },
  rail_disabled: {
    store: 'ui.faircoinSeller.reason.railDisabled',
    self: 'ui.faircoinSeller.reason.railDisabled',
  },
};

const EXPLANATION_COPY: Record<FaircoinSellerAudience, string> = {
  store: 'ui.faircoinSeller.explanationStore',
  self: 'ui.faircoinSeller.explanationSelf',
};

const CONFIRM_AS_COPY: Record<FaircoinSellerAudience, string> = {
  store: 'ui.faircoinSeller.confirmAsStore',
  self: 'ui.faircoinSeller.confirmAsSelf',
};

/**
 * A seller's FairCoin half (ADR 0019, Peable ADR 0021) — the ONE rendering of
 * it, for a store on the dashboard's Settings → Payments & payouts and a private
 * seller on the storefront's Settings → Payments.
 *
 * It says, in words: the state, whether buyers can pay in FairCoin now and why
 * not, the receiving Oxy account and when it was confirmed; that the coins go
 * straight to that account's Peable wallet, which neither Peable nor Mercaria
 * holds; and that FairCoin sales carry no marketplace fee. Until the half is
 * active it offers the action that opens Peable's confirmation page, and says
 * which account must confirm there.
 *
 * Renders the content only; the caller supplies the card around it and the
 * action's behaviour (minting the link, opening it, re-reading on return).
 */
export function FaircoinSellerPayments({
  faircoin,
  audience,
  receivingAccountName,
  onboardingAvailable,
  onConfirm,
  busy,
}: FaircoinSellerPaymentsProps) {
  const t = useSharedUiTranslation();
  const locale = useSharedUiLocale();
  const confirmedOn =
    faircoin.confirmedAt === undefined ? null : formatDate(faircoin.confirmedAt, locale);
  const receiver = receivingAccountName ?? faircoin.receivingOxyAccountId;
  const canAct =
    faircoin.state !== 'active' &&
    onboardingAvailable &&
    faircoin.unavailableReason !== 'rail_disabled';
  const actionLabel = t(
    faircoin.state === 'pending'
      ? 'ui.faircoinSeller.action.confirm'
      : 'ui.faircoinSeller.action.start',
  );

  return (
    <View testID="faircoin-seller-payments">
      <Text className="text-sm font-semibold text-foreground">{t('ui.faircoinSeller.title')}</Text>
      <Text className="mt-1 text-xs text-muted-foreground">{t(EXPLANATION_COPY[audience])}</Text>

      <View className="mt-3">
        <Row label={t('ui.faircoinSeller.stateLabel')} value={t(STATE_COPY[faircoin.state])} />
        <Row
          label={t('ui.faircoinSeller.payableLabel')}
          value={t(
            faircoin.payable ? 'ui.faircoinSeller.payableYes' : 'ui.faircoinSeller.payableNo',
          )}
        />
        {receiver === undefined || receiver === '' ? null : (
          <Row label={t('ui.faircoinSeller.receiverLabel')} value={receiver} />
        )}
        {confirmedOn === null ? null : (
          <Row label={t('ui.faircoinSeller.confirmedLabel')} value={confirmedOn} />
        )}
      </View>

      {faircoin.payable || faircoin.unavailableReason === undefined ? null : (
        <Text className="mt-2 text-xs text-foreground" testID="faircoin-unavailable-reason">
          {t(REASON_COPY[faircoin.unavailableReason][audience])}
        </Text>
      )}

      {canAct ? (
        <>
          <Text className="mt-3 text-xs text-muted-foreground">{t(CONFIRM_AS_COPY[audience])}</Text>
          <Button
            tone="accent"
            onPress={onConfirm}
            loading={busy}
            disabled={busy}
            accessibilityLabel={actionLabel}
            className="mt-3 self-start"
          >
            {actionLabel}
          </Button>
        </>
      ) : null}

      {faircoin.state !== 'active' &&
      !onboardingAvailable &&
      faircoin.unavailableReason !== 'rail_disabled' ? (
        <Text className="mt-3 text-xs text-muted-foreground">
          {t('ui.faircoinSeller.setupUnavailable')}
        </Text>
      ) : null}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3 py-1.5">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      <Text className="shrink text-sm text-foreground">{value}</Text>
    </View>
  );
}
