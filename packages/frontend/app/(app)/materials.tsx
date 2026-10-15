import { useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Head from 'expo-router/head';
import { Button } from '@oxy.so/bloom/button';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Loading } from '@oxy.so/bloom/loading';
import { openAccountDialog, useOxy } from '@oxy.so/services';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Text } from '@mercaria/ui';
import { MercariaError, type MaterialOffer, type MaterialReservation } from '@mercaria.co/sdk';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { useTranslation } from '@/lib/i18n';
import { materialRequestKey, useMaterialsClient } from '@/lib/hooks/use-materials';

const STATUS_KEYS = {
  requested: 'materials.requested',
  accepted: 'materials.accepted',
  cancelled: 'materials.cancelled',
  delivered: 'materials.delivered',
} as const;
const ERROR_KEYS = {
  conflict: 'materials.conflict',
  forbidden: 'materials.forbidden',
  unauthorized: 'materials.signIn',
} as const;

function ErrorMessage({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const code = error instanceof MercariaError ? error.code : null;
  return (
    <Text accessibilityRole="alert" className="text-sm text-foreground">
      {t(
        code && code in ERROR_KEYS
          ? ERROR_KEYS[code as keyof typeof ERROR_KEYS]
          : 'materials.error',
      )}
    </Text>
  );
}

export default function MaterialsScreen() {
  const { t } = useTranslation();
  const { user, canUsePrivateApi, activeSessionId } = useOxy();
  return (
    <ScreenShell>
      <Head>
        <title>{t('materials.heading')}</title>
      </Head>
      <View className="gap-space-16 px-space-16 py-space-20">
        <Text className="text-2xl font-bold text-foreground">{t('materials.heading')}</Text>
        <Text className="text-sm text-text-secondary">{t('materials.intro')}</Text>
        <Button onPress={() => openAccountDialog()}>
          {t(canUsePrivateApi ? 'materials.switchAccount' : 'materials.signIn')}
        </Button>
        {canUsePrivateApi && user ? (
          <Text>
            {t('materials.actingAs', {
              account: user.name?.displayName || user.username || user.id,
            })}
          </Text>
        ) : null}
        <MaterialsWorkspace
          key={`${activeSessionId}:${user?.id}:${canUsePrivateApi}`}
          accountId={canUsePrivateApi ? user?.id : undefined}
          sessionId={activeSessionId}
        />
      </View>
    </ScreenShell>
  );
}

function MaterialsWorkspace({
  accountId,
  sessionId,
}: {
  accountId?: string;
  sessionId: string | null;
}) {
  const { t } = useTranslation();
  const client = useMaterialsClient();
  const [tab, setTab] = useState<'offers' | 'mine'>('offers');
  const offers = useInfiniteQuery({
    queryKey: ['materials', 'offers'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => client.listOffers({ cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const reservations = useInfiniteQuery({
    queryKey: ['materials', 'reservations', accountId, sessionId],
    enabled: !!accountId,
    initialPageParam: undefined as string | undefined,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: 30_000,
    queryFn: ({ pageParam }) =>
      client.listReservations({ accountId: accountId!, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <>
      {accountId ? <OfferForm accountId={accountId} /> : null}
      <View className="flex-row flex-wrap gap-space-8">
        <Button onPress={() => setTab('offers')}>{t('materials.offers')}</Button>
        {accountId ? (
          <Button onPress={() => setTab('mine')}>{t('materials.reservations')}</Button>
        ) : null}
        <Button
          onPress={() => {
            void offers.refetch();
            if (accountId) void reservations.refetch();
          }}
        >
          {t('materials.refresh')}
        </Button>
      </View>
      {tab === 'offers' ? (
        <>
          {offers.isPending ? <Loading variant="inline" size="sm" /> : null}
          {offers.isError ? (
            <ErrorMessage error={offers.error} />
          ) : (
            offers.data?.pages
              .flatMap((page) => page.items)
              .map((offer) => <OfferCard key={offer.id} offer={offer} accountId={accountId} />)
          )}
          {offers.data?.pages[0]?.items.length === 0 ? <Text>{t('materials.empty')}</Text> : null}
          {offers.hasNextPage ? (
            <Button
              disabled={offers.isFetchingNextPage}
              onPress={() => void offers.fetchNextPage()}
            >
              {t('materials.more')}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          {reservations.isPending ? <Loading variant="inline" size="sm" /> : null}
          {reservations.isError ? (
            <ErrorMessage error={reservations.error} />
          ) : (
            reservations.data?.pages
              .flatMap((page) => page.items)
              .map((row) => <ReservationCard key={row.id} row={row} accountId={accountId!} />)
          )}
          {reservations.data?.pages[0]?.items.length === 0 ? (
            <Text>{t('materials.emptyReservations')}</Text>
          ) : null}
          {reservations.hasNextPage ? (
            <Button
              disabled={reservations.isFetchingNextPage}
              onPress={() => void reservations.fetchNextPage()}
            >
              {t('materials.more')}
            </Button>
          ) : null}
        </>
      )}
    </>
  );
}

function OfferForm({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const client = useMaterialsClient();
  const cache = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [publicArea, setArea] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState('');
  const [pickupInstructions, setPickup] = useState('');
  const payload = useMemo(
    () => ({
      ownerAccountId: accountId,
      title,
      description,
      publicArea,
      quantity: Number(quantity),
      unit,
      pickupInstructions,
    }),
    [accountId, title, description, publicArea, quantity, unit, pickupInstructions],
  );
  const keys = useRef(new Map<string, string>());
  const create = useMutation({
    mutationFn: async () => {
      const signature = JSON.stringify(payload);
      const key = keys.current.get(signature) ?? materialRequestKey();
      keys.current.set(signature, key);
      return client.createOffer({ ...payload, idempotencyKey: key });
    },
    onSuccess: async () => {
      keys.current.clear();
      setTitle('');
      setDescription('');
      setArea('');
      setQuantity('1');
      setUnit('');
      setPickup('');
      setExpanded(false);
      await cache.invalidateQueries({ queryKey: ['materials'] });
    },
  });
  return (
    <View className="gap-space-12 rounded-radius-lg border border-border-secondary p-space-16">
      <Button onPress={() => setExpanded(!expanded)}>{t('materials.offer')}</Button>
      {expanded ? (
        <>
          <TextFieldInput
            label={t('materials.title')}
            placeholder={t('materials.title')}
            value={title}
            onChangeText={setTitle}
            maxLength={160}
          />
          <TextFieldInput
            label={t('materials.description')}
            placeholder={t('materials.description')}
            value={description}
            onChangeText={setDescription}
            multiline
            maxLength={4000}
          />
          <TextFieldInput
            label={t('materials.area')}
            placeholder={t('materials.area')}
            value={publicArea}
            onChangeText={setArea}
            maxLength={160}
          />
          <TextFieldInput
            label={t('materials.quantity')}
            placeholder={t('materials.quantity')}
            value={quantity}
            onChangeText={setQuantity}
            keyboardType="number-pad"
          />
          <TextFieldInput
            label={t('materials.unit')}
            placeholder={t('materials.unit')}
            value={unit}
            onChangeText={setUnit}
            maxLength={40}
          />
          <TextFieldInput
            label={t('materials.pickup')}
            placeholder={t('materials.pickup')}
            value={pickupInstructions}
            onChangeText={setPickup}
            multiline
            maxLength={2000}
          />
          <Text className="text-sm text-text-secondary">{t('materials.pickupPrivacy')}</Text>
          {create.isError ? <ErrorMessage error={create.error} /> : null}
          <Button
            tone="accent"
            loading={create.isPending}
            disabled={
              !title.trim() ||
              !publicArea.trim() ||
              !unit.trim() ||
              !pickupInstructions.trim() ||
              !Number.isInteger(Number(quantity)) ||
              Number(quantity) < 1 ||
              Number(quantity) > 1_000_000 ||
              create.isPending
            }
            onPress={() => create.mutate()}
          >
            {t('materials.publish')}
          </Button>
        </>
      ) : null}
    </View>
  );
}

function OfferCard({ offer, accountId }: { offer: MaterialOffer; accountId?: string }) {
  const { t } = useTranslation();
  const client = useMaterialsClient();
  const cache = useQueryClient();
  const [quantity, setQuantity] = useState('1');
  const keys = useRef(new Map<string, string>());
  const request = useMutation({
    mutationFn: async () => {
      const key = keys.current.get(quantity) ?? materialRequestKey();
      keys.current.set(quantity, key);
      return client.request(offer.id, {
        requesterAccountId: accountId!,
        quantity: Number(quantity),
        idempotencyKey: key,
      });
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['materials'] });
    },
  });
  const close = useMutation({
    mutationFn: () =>
      client.closeOffer(offer.id, {
        actingAccountId: accountId!,
        idempotencyKey: materialRequestKey(),
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['materials'] }),
  });
  return (
    <View className="gap-space-12 rounded-radius-lg border border-border-secondary p-space-16">
      <Text className="text-lg font-semibold text-foreground">{offer.title}</Text>
      <Text>{offer.description}</Text>
      <Text>{offer.publicArea}</Text>
      <Text>
        {t('materials.counts', {
          available: offer.availableQuantity,
          committed: offer.committedQuantity,
          received: offer.receivedQuantity,
          unit: offer.unit,
        })}
      </Text>
      {accountId === offer.ownerAccountId ? (
        <Button disabled={close.isPending} onPress={() => close.mutate()}>
          {t('materials.close')}
        </Button>
      ) : accountId ? (
        <>
          <TextFieldInput
            label={t('materials.quantity')}
            value={quantity}
            onChangeText={setQuantity}
            keyboardType="number-pad"
          />
          <Button
            loading={request.isPending}
            disabled={
              request.isPending ||
              request.isSuccess ||
              !Number.isInteger(Number(quantity)) ||
              Number(quantity) < 1 ||
              Number(quantity) > offer.availableQuantity
            }
            onPress={() => request.mutate()}
          >
            {t('materials.request')}
          </Button>
          {request.isSuccess ? (
            <Text accessibilityRole="alert">{t('materials.requestSent')}</Text>
          ) : null}
        </>
      ) : null}
      {request.isError || close.isError ? (
        <ErrorMessage error={request.error || close.error} />
      ) : null}
    </View>
  );
}

function ReservationCard({ row, accountId }: { row: MaterialReservation; accountId: string }) {
  const { t } = useTranslation();
  const client = useMaterialsClient();
  const cache = useQueryClient();
  const offer = useQuery({
    queryKey: ['materials', 'offer', row.offerId],
    queryFn: () => client.getOffer(row.offerId),
  });
  const action = useMutation({
    mutationFn: (operation: 'accept' | 'cancel' | 'confirmDelivery') =>
      client[operation](row.id, {
        actingAccountId: accountId,
        idempotencyKey: `${row.id}_${operation}`,
      }),
    onSettled: () => cache.invalidateQueries({ queryKey: ['materials'] }),
  });
  const donor = accountId === row.donorAccountId;
  return (
    <View className="gap-space-12 rounded-radius-lg border border-border-secondary p-space-16">
      <Text className="text-lg font-semibold text-foreground">
        {offer.data?.title ?? t('materials.reservation')}
      </Text>
      <Text>{t(STATUS_KEYS[row.status])}</Text>
      <Text>
        {t('materials.reservationQuantity', {
          quantity: row.quantity,
          unit: offer.data?.unit ?? '',
        })}
      </Text>
      <Text>
        {t(donor ? 'materials.requester' : 'materials.donor', {
          account: donor ? row.requesterAccountId : row.donorAccountId,
        })}
      </Text>
      {row.pickupInstructions ? (
        <>
          <Text className="font-semibold">{t('materials.pickup')}</Text>
          <Text>{row.pickupInstructions}</Text>
        </>
      ) : null}
      <View className="flex-row flex-wrap gap-space-8">
        {donor && row.status === 'requested' ? (
          <Button disabled={action.isPending} onPress={() => action.mutate('accept')}>
            {t('materials.accept')}
          </Button>
        ) : null}
        {!donor && row.status === 'accepted' ? (
          <Button disabled={action.isPending} onPress={() => action.mutate('confirmDelivery')}>
            {t('materials.confirm')}
          </Button>
        ) : null}
        {row.status === 'accepted' || row.status === 'requested' ? (
          <Button disabled={action.isPending} onPress={() => action.mutate('cancel')}>
            {t('materials.cancel')}
          </Button>
        ) : null}
      </View>
      {action.isError ? <ErrorMessage error={action.error} /> : null}
    </View>
  );
}
