import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { Image as ShapeImage } from '@oxy.so/bloom/shapes';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import {
  PeableSheetCheckout,
  SheetPreparationError,
  sessionSource,
  type SheetCheckoutPreparation,
} from '@peable.to/sdk/checkout/ui';
import {
  isIsoAlpha2Country,
  type CheckoutResult,
  type PaymentStatus,
} from '@mercaria/shared-types';
import { Text, CommercialDisclosure, commercialSellerLabel } from '@mercaria/ui';
import { DigitalSupplyConsent } from '@/components/checkout/CheckoutDestinationForm';
import { fetchAddresses } from '@/lib/api/addresses';
import { postCheckout } from '@/lib/api/checkout';
import { apiErrorDetails } from '@/lib/api/client';
import { PEABLE_CHECKOUT_URL, PEABLE_GATEWAY_URL } from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import {
  checkoutAddress,
  checkoutInput,
  checkoutPreflight,
  profileAddressCandidates,
  type CheckoutSelection,
} from '@/lib/payments/checkout-preparation';
import { checkoutReturnUrl, sheetOutcome } from '@/lib/payments/peable-payer';
import { openInApp, PeablePaymentSheet } from './PeablePaymentSheet';

/** Mounted once per account/cart attempt. Orders never exist merely because this opens. */
export function PrepareCartPayment({
  selection,
  attemptId,
  open,
  status,
  onCreated,
  onSettled,
  onClose,
  onRefused,
  onSubmitting,
  onRejectedBeforeCreation,
}: {
  selection: CheckoutSelection;
  attemptId: string;
  open: boolean;
  status: PaymentStatus | undefined;
  onCreated: (result: CheckoutResult) => void;
  onSettled: () => void;
  onClose: () => void;
  onRefused: (error: unknown) => string;
  onSubmitting: () => void;
  onRejectedBeforeCreation: () => void;
}) {
  const { t, locale } = useTranslation();
  const { user, isAuthenticated, canUsePrivateApi, oxyServices } = useOxy();
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const actor = isAuthenticated ? user?.id : undefined;
  const addresses = useQuery({
    queryKey: ['checkout', 'oxy-addresses', actor],
    queryFn: () => oxyServices.addresses.list(),
    enabled: Boolean(actor) && canUsePrivateApi,
  });
  const legacy = useQuery({
    queryKey: ['checkout', 'mercaria-addresses', actor],
    queryFn: fetchAddresses,
    enabled: Boolean(actor) && canUsePrivateApi,
  });
  const profile = useQuery({
    queryKey: ['checkout', 'own-profile', actor],
    queryFn: () => oxyServices.users.me({ cache: false }),
    enabled: Boolean(actor) && canUsePrivateApi,
  });
  const saved = useMemo(
    () =>
      actor
        ? [
            ...(addresses.data ?? []).map((address) => checkoutAddress(address, 'oxy')),
            ...(legacy.data ?? []).map((address) => checkoutAddress(address, 'mercaria')),
          ]
        : [],
    [actor, addresses.data, legacy.data],
  );
  const preferred =
    saved.find(
      (address) => address.id === `oxy:${addresses.data?.find((entry) => entry.isDefault)?.id}`,
    ) ??
    saved.find(
      (address) => address.id === `mercaria:${legacy.data?.find((entry) => entry.isDefault)?.id}`,
    );
  const [discount, setDiscount] = useState('');
  const [supplyCountry, setSupplyCountry] = useState('');
  const [digitalConsent, setDigitalConsent] = useState(false);
  const [usePickup, setUsePickup] = useState(true);
  const [pickupEmail, setPickupEmail] = useState('');
  const [pickupPhone, setPickupPhone] = useState('');
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(new Set());
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [unavailable, setUnavailable] = useState<string>();
  const attempt = useRef<ReturnType<typeof checkoutInput> | null>(null);
  const resultRef = useRef<CheckoutResult | null>(null);
  const submissions = useRef(0);
  const [groupId, setGroupId] = useState<string>();
  const lines = selection.groups.flatMap((group) => group.items);
  const ships = lines.some((line) => line.delivery !== 'digital');
  const digital = lines.some((line) => line.delivery === 'digital');
  const pickup = ships && usePickup && Boolean(selection.pickupLocationId);
  const email = actor ? (profile.data?.email ?? user?.email) : undefined;
  const preparation: SheetCheckoutPreparation = {
    key: `${actor ?? 'guest'}:${attemptId}`,
    amountLabel: t('checkout.account.quoteLabel'),
    request: {
      merchant: 'Mercaria',
      currency: selection.currency,
      dueTodayMinorUnits: selection.groups.reduce((sum, group) => sum + group.subtotal.amount, 0),
      items: lines.map((line) => ({
        id: `${line.listingId}:${line.variantId}`,
        name: line.title,
        detail: line.variantTitle,
        quantity: line.quantity,
        amountMinorUnits: line.lineTotal.amount,
        ...(line.imageUrl
          ? {
              artwork: (
                <ShapeImage
                  shape="squircle"
                  size={40}
                  source={{ uri: line.imageUrl }}
                  alt={line.title}
                />
              ),
            }
          : {}),
      })),
      requiresShipping: ships && !pickup,
      requiresContact: !actor,
      paymentMethods: selection.currency === 'FAIR' ? ['faircoin'] : ['card', 'faircoin'],
    },
    addresses: [...saved, ...(actor ? profileAddressCandidates(profile.data) : [])],
    initialDetails: {
      ...(email ? { email } : {}),
      ...(preferred ? { selectedAddressId: preferred.id, shipping: preferred.address } : {}),
    },
    ...(actor
      ? {
          accountSummary: {
            name:
              profile.data?.name?.displayName ?? user?.name?.displayName ?? user?.username ?? 'Oxy',
            ...(email ? { detail: email } : {}),
          },
        }
      : {}),
    canContinue:
      (!digital || digitalConsent) &&
      (ships || isIsoAlpha2Country(supplyCountry.trim().toUpperCase())) &&
      (!pickup || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pickupEmail.trim())),
    renderAdditionalDetails: ({ disabled, details }) => (
      <View className="gap-4">
        {selection.groups.map((group) => (
          <View key={group.sellerKey} className="gap-2">
            <Text className="font-semibold">{commercialSellerLabel(t, group.commercial)}</Text>
            <CommercialDisclosure presentation={group.commercial} showExplanations />
          </View>
        ))}
        {actor && (addresses.isError || legacy.isError || profile.isError) ? (
          <View className="gap-2">
            <Text accessibilityRole="alert">{t('checkout.account.loadFailed')}</Text>
            <Button
              appearance="outline"
              disabled={disabled}
              onPress={() => {
                void addresses.refetch();
                void legacy.refetch();
                void profile.refetch();
              }}
            >
              {t('common.tryAgain')}
            </Button>
          </View>
        ) : null}
        {ships && selection.pickupLocationId ? (
          <View className="gap-2">
            <Button
              disabled={disabled}
              appearance={pickup ? 'outline' : 'solid'}
              onPress={() => setUsePickup(false)}
            >
              {t('checkout.form.deliverToAddress')}
            </Button>
            <Button
              disabled={disabled}
              appearance={pickup ? 'solid' : 'outline'}
              onPress={() => setUsePickup(true)}
            >
              {t('checkout.destination.collectInPerson')}
            </Button>
          </View>
        ) : null}
        {pickup ? (
          <>
            <Field
              label={t('checkout.form.emailLabel')}
              description={t('checkout.destination.guestPickupHint')}
            >
              <TextFieldInput
                label={t('checkout.form.emailA11y')}
                value={pickupEmail}
                onValueChange={setPickupEmail}
                disabled={disabled}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </Field>
            <Field label={t('checkout.form.pickupPhoneLabel')}>
              <TextFieldInput
                label={t('checkout.form.pickupPhoneA11y')}
                value={pickupPhone}
                onValueChange={setPickupPhone}
                disabled={disabled}
                keyboardType="phone-pad"
              />
            </Field>
          </>
        ) : null}
        {!ships ? (
          <Field
            label={t('checkout.form.supplyCountryLabel')}
            description={t('checkout.form.supplyCountryHelp')}
          >
            <TextFieldInput
              label={t('checkout.form.supplyCountryA11y')}
              value={supplyCountry}
              onValueChange={setSupplyCountry}
              disabled={disabled}
              maxLength={2}
              autoCapitalize="characters"
            />
          </Field>
        ) : null}
        {digital ? (
          <DigitalSupplyConsent
            consent={digitalConsent}
            onChange={setDigitalConsent}
            disabled={disabled}
          />
        ) : null}
        <Field label={t('checkout.discount.label')}>
          <TextFieldInput
            label={t('checkout.discount.accessibilityLabel')}
            value={discount}
            onValueChange={setDiscount}
            disabled={disabled}
            autoCapitalize="characters"
          />
        </Field>
        {actor &&
        ships &&
        !pickup &&
        !details.selectedAddressId?.startsWith('oxy:') &&
        details.shipping.name.trim() &&
        details.shipping.line1.trim() &&
        details.shipping.country.trim() ? (
          <Button
            appearance="outline"
            disabled={disabled || savePending || savedIds.has(JSON.stringify(details.shipping))}
            onPress={async () => {
              const shipping = details.shipping;
              setSavePending(true);
              setSaveError(undefined);
              try {
                // Explicit opt-in only. Never retry an uncertain private-address write automatically.
                await oxyServices.addresses.create({
                  recipientName: shipping.name,
                  line1: shipping.line1,
                  city: shipping.city,
                  postalCode: shipping.postalCode,
                  country: shipping.country,
                  ...(shipping.line2 ? { line2: shipping.line2 } : {}),
                  ...(shipping.state ? { region: shipping.state } : {}),
                  ...(shipping.phone ? { phone: shipping.phone } : {}),
                });
                if (!mounted.current) return;
                setSavedIds((previous) => new Set([...previous, JSON.stringify(shipping)]));
                await addresses.refetch();
              } catch {
                if (mounted.current) setSaveError(t('checkout.account.saveFailed'));
              } finally {
                if (mounted.current) setSavePending(false);
              }
            }}
          >
            {t('checkout.account.saveToOxy', { name: details.shipping.name })}
          </Button>
        ) : null}
        {saveError ? <Text accessibilityRole="alert">{saveError}</Text> : null}
      </View>
    ),
    createSession: async (details, { signal }) => {
      // Retain ALL submitted fields and the key across uncertain failures. No retry changes consent or prices.
      if (!attempt.current) {
        const input = checkoutInput(
          { ...details, email: actor ? '' : details.email },
          { ...selection, pickupLocationId: pickup ? selection.pickupLocationId : undefined },
          {
            discount,
            supplyCountry,
            digitalConsent,
            pickupEmail,
            pickupPhone,
          },
        );
        const failure = checkoutPreflight(input);
        if (failure) throw new SheetPreparationError(failure, 'not_created');
        attempt.current = input;
      }
      onSubmitting();
      submissions.current += 1;
      let result: CheckoutResult;
      try {
        result =
          resultRef.current ?? (await postCheckout(attempt.current, attemptId, selection.currency));
      } catch (error) {
        if (signal.aborted) throw error;
        const message = onRefused(error);
        const reason = apiErrorDetails(error)?.reason;
        // Both named gates precede order writes. A later retry after an unknown
        // response cannot prove the earlier request did not create an order.
        if (
          submissions.current === 1 &&
          (reason === 'seller_not_activated' || reason === 'seller_not_payment_ready')
        ) {
          attempt.current = null;
          onRejectedBeforeCreation();
          throw new SheetPreparationError(message, 'not_created');
        }
        throw new SheetPreparationError(message, 'unknown');
      }
      resultRef.current = result;
      if (signal.aborted) throw new Error(t('payment.sheet.unreadable'));
      if (!result.payment) {
        onCreated(result);
        throw new SheetPreparationError(t('payment.sheet.unreadable'), 'unknown');
      }
      const source = sessionSource(result.payment.clientSecret);
      if (!source || !result.payment) throw new Error(t('payment.sheet.unreadable'));
      setGroupId(result.checkoutGroupId);
      onCreated(result);
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
      void queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
      return {
        source,
        expected: {
          amount: String(result.payment.amount.amount),
          currency: result.payment.amount.currency,
        },
      };
    },
  };
  if (unavailable && resultRef.current?.payment) {
    const result = resultRef.current;
    return (
      <>
        <Text accessibilityRole="alert">{unavailable}</Text>
        {open && result.payment ? (
          <PeablePaymentSheet
            payment={result.payment}
            checkoutGroupId={result.checkoutGroupId}
            orderNumbers={result.orders.map((order) => order.orderNumber)}
            status={status}
            onSettled={onSettled}
            onUnavailable={(message) => {
              setUnavailable(message);
              onClose();
            }}
            onClose={onClose}
          />
        ) : null}
      </>
    );
  }
  return (
    <PeableSheetCheckout
      open={open}
      preparation={preparation}
      locale={locale}
      checkoutUrl={PEABLE_CHECKOUT_URL}
      {...(PEABLE_GATEWAY_URL ? { gatewayUrl: PEABLE_GATEWAY_URL } : {})}
      {...(groupId && Platform.OS === 'web' && typeof window !== 'undefined'
        ? { returnUrl: checkoutReturnUrl(window.location.origin, groupId) }
        : {})}
      openUrl={openInApp}
      outcome={sheetOutcome(status)}
      onSettled={onSettled}
      onUnavailable={(reason) => {
        setUnavailable(
          t(reason === 'mismatch' ? 'payment.sheet.mismatch' : 'payment.sheet.unreadable'),
        );
        onClose();
      }}
      onClose={onClose}
    />
  );
}
