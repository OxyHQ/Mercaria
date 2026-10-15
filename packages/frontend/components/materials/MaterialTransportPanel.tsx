import { useMemo, useRef, useState } from 'react';
import { Linking, Share, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatTransportPrice,
  MoovoApiError,
  type TransportEndpoint,
  type TransportView,
} from '@moovo.now/sdk';
import type { MaterialReservation } from '@mercaria.co/sdk';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import { useMoovo } from '@/lib/hooks/use-moovo';
import { materialRequestKey, useMaterialsClient } from '@/lib/hooks/use-materials';

const endpointLabelKeys = {
  line1: 'transport.line1',
  city: 'transport.city',
  postalCode: 'transport.postalCode',
  country: 'transport.country',
  contactName: 'transport.contactName',
  contactPhone: 'transport.contactPhone',
  latitude: 'transport.latitude',
  longitude: 'transport.longitude',
  notes: 'transport.notes',
} as const;
const legLabelKeys = { pickup: 'transport.pickup', dropoff: 'transport.dropoff' } as const;
const sizeLabelKeys = {
  small: 'transport.small',
  medium: 'transport.medium',
  large: 'transport.large',
} as const;
const transportStatusLabelKeys = {
  quoting: 'transport.status.quoting',
  quoted: 'transport.status.quoted',
  authorized: 'transport.status.authorized',
  booking: 'transport.status.booking',
  booking_unknown: 'transport.status.booking_unknown',
  booked: 'transport.status.booked',
  cancelled: 'transport.status.cancelled',
} as const;
const jobStatusLabelKeys = {
  requested: 'transport.jobStatus.requested',
  offered: 'transport.jobStatus.offered',
  accepted: 'transport.jobStatus.accepted',
  picked_up: 'transport.jobStatus.picked_up',
  in_transit: 'transport.jobStatus.in_transit',
  delivered: 'transport.jobStatus.delivered',
  cancelled: 'transport.jobStatus.cancelled',
} as const;
const emptyAddress = { line1: '', city: '', postalCode: '', country: '' };
const emptyEndpoint = {
  ...emptyAddress,
  contactName: '',
  contactPhone: '',
  latitude: '',
  longitude: '',
  notes: '',
};
type EndpointFormValue = typeof emptyEndpoint;
function endpoint(value: EndpointFormValue): TransportEndpoint {
  if (!value.latitude.trim() || !value.longitude.trim()) throw new Error('Missing coordinates');
  return {
    address: {
      line1: value.line1,
      city: value.city,
      postalCode: value.postalCode,
      country: value.country.toUpperCase(),
    },
    contactName: value.contactName,
    contactPhone: value.contactPhone,
    latitude: Number(value.latitude),
    longitude: Number(value.longitude),
    notes: value.notes,
  };
}
function EndpointForm({
  value,
  onChange,
  leg,
}: {
  value: EndpointFormValue;
  onChange: (next: EndpointFormValue) => void;
  leg: 'pickup' | 'dropoff';
}) {
  const { t } = useTranslation();
  return (
    <View className="gap-space-8">
      <Text className="font-semibold">{t(legLabelKeys[leg])}</Text>
      {Object.keys(emptyEndpoint).map((field) => (
        <TextFieldInput
          key={field}
          label={`${t(legLabelKeys[leg])} ${t(endpointLabelKeys[field as keyof typeof endpointLabelKeys])}`}
          placeholder={t(endpointLabelKeys[field as keyof typeof endpointLabelKeys])}
          value={value[field as keyof EndpointFormValue]}
          onChangeText={(text) => onChange({ ...value, [field]: text })}
        />
      ))}
    </View>
  );
}
export function MaterialTransportPanel({
  reservation,
  accountId,
  title,
}: {
  reservation: MaterialReservation;
  accountId: string;
  title: string;
}) {
  const { t } = useTranslation();
  const moovo = useMoovo();
  const materials = useMaterialsClient();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pickup, setPickup] = useState({
    ...emptyEndpoint,
    notes: reservation.pickupInstructions ?? '',
  });
  const [dropoff, setDropoff] = useState(emptyEndpoint);
  const [weight, setWeight] = useState('');
  const [pieces, setPieces] = useState('');
  const [size, setSize] = useState<'small' | 'medium' | 'large'>('small');
  const [payer, setPayer] = useState(reservation.requesterAccountId);
  const [sponsor, setSponsor] = useState(false);
  const key = ['material-transport', reservation.id, accountId];
  const current = useQuery({
    queryKey: key,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: 15000,
    queryFn: async () => {
      try {
        return await moovo.byReservation(reservation.id, accountId);
      } catch (err) {
        if (err instanceof MoovoApiError && err.code === 'not_found') return null;
        throw err;
      }
    },
  });
  const draft = useMemo(
    () => ({ pickup, dropoff, weight, pieces, size, payer }),
    [pickup, dropoff, weight, pieces, size, payer],
  );
  const operation = useRef({ draft, id: materialRequestKey() });
  if (operation.current.draft !== draft) operation.current = { draft, id: materialRequestKey() };
  const link = async (transport: TransportView) => {
    await materials.linkTransport(reservation.id, {
      actingAccountId: accountId,
      transportId: transport.id,
    });
    await cache.invalidateQueries({ queryKey: ['materials'] });
  };
  const create = useMutation({
    mutationFn: async () => {
      const transport = await moovo.create({
        reservationId: reservation.id,
        actingAccountId: accountId,
        payerAccountId: payer,
        operationId: operation.current.id,
        pickup: endpoint(pickup),
        dropoff: endpoint(dropoff),
        parcel: { weightKg: Number(weight), pieces: Number(pieces), sizeClass: size },
        itemDescription: `${title} (${reservation.quantity})`,
      });
      cache.setQueryData(key, transport);
      await link(transport);
      setOpen(false);
    },
    onSettled: () => cache.invalidateQueries({ queryKey: key }),
  });
  const attach = useMutation({
    mutationFn: async () => {
      if (current.data) await link(current.data);
    },
  });
  return (
    <View className="gap-space-12">
      <Text className="font-semibold">{t('transport.heading')}</Text>
      <Text>{t('transport.pickupAlways')}</Text>
      {current.isError ? (
        <Text accessibilityRole="alert">{t('transport.unavailable')}</Text>
      ) : current.data ? (
        <>
          <TransportReview
            transport={current.data}
            accountId={accountId}
            participant={true}
            onChange={() => void current.refetch()}
          />
          {reservation.moovoTransportId !== current.data.id ? (
            <Button onPress={() => attach.mutate()} disabled={attach.isPending}>
              {t('transport.attach')}
            </Button>
          ) : null}
          {current.data.status === 'cancelled' && reservation.status === 'accepted' ? (
            <Button
              onPress={() => {
                operation.current = { draft, id: materialRequestKey() };
                setOpen(true);
              }}
            >
              {t('transport.newRequest')}
            </Button>
          ) : null}
        </>
      ) : reservation.status === 'accepted' && !current.isPending ? (
        <Button onPress={() => setOpen(true)}>{t('transport.request')}</Button>
      ) : null}
      {open ? (
        <>
          <Text>{t('transport.missingFacts')}</Text>
          <EndpointForm leg="pickup" value={pickup} onChange={setPickup} />
          <EndpointForm leg="dropoff" value={dropoff} onChange={setDropoff} />
          <TextFieldInput
            label={t('transport.weight')}
            placeholder={t('transport.weight')}
            value={weight}
            onChangeText={setWeight}
            keyboardType="decimal-pad"
          />
          <TextFieldInput
            label={t('transport.pieces')}
            placeholder={t('transport.pieces')}
            value={pieces}
            onChangeText={setPieces}
            keyboardType="number-pad"
          />
          <View className="flex-row flex-wrap gap-space-8">
            {(['small', 'medium', 'large'] as const).map((value) => (
              <Button
                key={value}
                onPress={() => setSize(value)}
              >{`${size === value ? '✓ ' : ''}${t(sizeLabelKeys[value])}`}</Button>
            ))}
          </View>
          <Text>{t('transport.payer')}</Text>
          <View className="flex-row flex-wrap gap-space-8">
            <Button
              onPress={() => {
                setSponsor(false);
                setPayer(reservation.donorAccountId);
              }}
            >
              {t('transport.donor')}
            </Button>
            <Button
              onPress={() => {
                setSponsor(false);
                setPayer(reservation.requesterAccountId);
              }}
            >
              {t('transport.recipient')}
            </Button>
            <Button
              onPress={() => {
                setSponsor(true);
                setPayer('');
              }}
            >
              {t('transport.sponsor')}
            </Button>
          </View>
          {sponsor ? (
            <TextFieldInput
              label={t('transport.organization')}
              placeholder={t('transport.organization')}
              value={payer}
              onChangeText={setPayer}
            />
          ) : null}
          <Text>{t('transport.selectedPayer', { account: payer })}</Text>
          <Text>{t('transport.payerMustConfirm')}</Text>
          <Button
            onPress={() => create.mutate()}
            disabled={create.isPending || !payer || !weight || !pieces}
          >
            {t('transport.getQuote')}
          </Button>
          <Button onPress={() => setOpen(false)} disabled={create.isPending}>
            {t('transport.keepPickup')}
          </Button>
        </>
      ) : null}
      {create.isError || attach.isError ? (
        <Text accessibilityRole="alert">{t('transport.unknown')}</Text>
      ) : null}
    </View>
  );
}
export function TransportReview({
  transport,
  accountId,
  participant,
  onChange,
}: {
  transport: TransportView;
  accountId: string;
  participant: boolean;
  onChange: () => void;
}) {
  const { t, locale } = useTranslation();
  const moovo = useMoovo();
  const [confirmedQuote, setConfirmedQuote] = useState<string | null>(null);
  const approvalUrl = new URL(
    `/materials-transport/${encodeURIComponent(transport.id)}`,
    'https://mercaria.co',
  ).href;
  const quote = transport.quotes[0];
  const quoteKey = `${quote?.id}:${quote?.amountMinor}:${transport.payerAccountId}:${accountId}`;
  const confirm = confirmedQuote === quoteKey;
  const action = useMutation({
    mutationFn: async (kind: 'authorize' | 'book' | 'cancel' | 'quote') => {
      if (kind === 'authorize') {
        if (!quote || !confirm) throw new Error('Confirmation required');
        await moovo.authorize(transport.id, {
          actingAccountId: accountId,
          quoteId: quote.id,
          amountMinor: quote.amountMinor,
          currency: quote.currency,
          confirmed: true,
        });
        setConfirmedQuote(null);
      } else await moovo[kind](transport.id, { actingAccountId: accountId });
    },
    onSettled: onChange,
  });
  return (
    <View className="gap-space-8">
      <Text>{transport.itemDescription}</Text>
      <Text>{t('transport.selectedPayer', { account: transport.payerAccountId })}</Text>
      <Text>
        {t('transport.route', {
          pickup: `${transport.pickup.address.line1}, ${transport.pickup.address.city}`,
          dropoff: `${transport.dropoff.address.line1}, ${transport.dropoff.address.city}`,
        })}
      </Text>
      <Text>{t(transportStatusLabelKeys[transport.status])}</Text>
      {transport.jobStatus ? (
        <Text>
          {t(
            jobStatusLabelKeys[transport.jobStatus as keyof typeof jobStatusLabelKeys] ??
              'transport.unavailable',
          )}
        </Text>
      ) : null}
      {quote ? (
        <Text>
          {t('transport.price', {
            price: formatTransportPrice(quote, locale),
            expiry: new Date(quote.expiresAt).toLocaleString(locale),
          })}
        </Text>
      ) : null}
      <Text>{t('transport.pendingPayment')}</Text>
      <Text>{t('transport.cancellationWarning')}</Text>
      {transport.status === 'quoted' && quote && transport.payerAccountId === accountId ? (
        <>
          <Button
            disabled={action.isPending}
            onPress={() => setConfirmedQuote(confirm ? null : quoteKey)}
          >
            {t(confirm ? 'transport.unconfirm' : 'transport.confirmPayer', { account: accountId })}
          </Button>
          <Button
            disabled={!confirm || action.isPending || Date.parse(quote.expiresAt) <= Date.now()}
            onPress={() => action.mutate('authorize')}
          >
            {t('transport.authorize')}
          </Button>
        </>
      ) : null}
      {['authorized', 'booking', 'booking_unknown'].includes(transport.status) && participant ? (
        <Button disabled={action.isPending} onPress={() => action.mutate('book')}>
          {t(transport.status === 'authorized' ? 'transport.book' : 'transport.retryBooking')}
        </Button>
      ) : null}
      {transport.status === 'authorized' && !participant ? (
        <Text>{t('transport.participantBooks')}</Text>
      ) : null}
      {transport.status === 'quoted' && transport.payerAccountId !== accountId ? (
        <Button
          onPress={() =>
            void Share.share({
              message: approvalUrl,
            })
          }
        >
          {t('transport.shareApproval')}
        </Button>
      ) : null}
      {participant && ['quoting', 'quoted', 'authorized'].includes(transport.status) && !quote ? (
        <Button onPress={() => action.mutate('quote')} disabled={action.isPending}>
          {t('transport.retryQuote')}
        </Button>
      ) : null}
      {['quoting', 'quoted', 'authorized'].includes(transport.status) ? (
        <Button onPress={() => action.mutate('cancel')} disabled={action.isPending}>
          {t('transport.cancelProposal')}
        </Button>
      ) : null}
      {transport.jobId ? (
        <Button
          onPress={() =>
            void Linking.openURL(
              `https://moovo.now/jobs/${encodeURIComponent(transport.jobId ?? '')}`,
            )
          }
        >
          {t('transport.openMoovo')}
        </Button>
      ) : null}
      {action.isError ? (
        <Text accessibilityRole="alert">
          {action.error instanceof MoovoApiError && action.error.code === 'forbidden'
            ? t('transport.forbidden')
            : t('transport.unknown')}
        </Text>
      ) : null}
    </View>
  );
}
