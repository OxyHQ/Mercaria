import React, { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { ChevronLeft, Building2, Plus, ShieldCheck, Trash2 } from 'lucide-react-native';
import type { AccountRole } from '@oxy.so/core';
import {
  STORE_PERMISSIONS,
  type Store,
  type StorePermission,
  type StorePermissionOverride,
} from '@mercaria/shared-types';
import { Text, useColorScheme, toBloomIcon } from '@mercaria/ui';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Button } from '@oxy.so/bloom/button';
import { Dialog, useDialogControl, type DialogControlProps } from '@oxy.so/bloom/dialog';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { toast } from '@oxy.so/bloom/toast';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { RequireStore } from '@/components/shell/RequireStore';
import { useTranslation } from '@/lib/i18n';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import {
  useConvertToOrganization,
  useOwnerAccount,
  useOwnerAccountMembers,
  usePermissionOverrides,
  useSetPermissionOverride,
  useUsernames,
  type ConvertInvitee,
} from '@/lib/hooks/use-store-people';

/**
 * People & permissions (ADR 0012).
 *
 * A store is owned by an Oxy account. WHO can act for it is that account's
 * membership, read from Oxy with the signed-in session; this screen shows it
 * and edits the one thing Mercaria keeps — a per-person exception to the role
 * map. A store still owned by a PERSONAL account has nobody else in it, so the
 * screen offers to convert it to an organization instead.
 */

/**
 * Display label per Oxy role. KEYS, not words: this map is evaluated at import,
 * before the locale store has rehydrated.
 */
const ROLE_LABEL_KEYS: Record<AccountRole, string> = {
  owner: 'settings.members.roles.owner',
  admin: 'settings.members.roles.admin',
  editor: 'settings.members.roles.editor',
  developer: 'settings.members.roles.developer',
  billing: 'settings.members.roles.billing',
  viewer: 'settings.members.roles.viewer',
};

/** The roles an invitation may carry — Oxy never invites an `owner`. */
const INVITE_ROLES: ConvertInvitee['role'][] = [
  'admin',
  'editor',
  'developer',
  'billing',
  'viewer',
];

/** Display label per permission, as keys. */
const PERMISSION_LABEL_KEYS: Record<StorePermission, string> = {
  'store:manage': 'settings.members.permissionLabels.storeManage',
  'members:manage': 'settings.members.permissionLabels.membersManage',
  'products:read': 'settings.members.permissionLabels.productsRead',
  'products:write': 'settings.members.permissionLabels.productsWrite',
  'inventory:write': 'settings.members.permissionLabels.inventoryWrite',
  'locations:write': 'settings.members.permissionLabels.locationsWrite',
  'collections:write': 'settings.members.permissionLabels.collectionsWrite',
  'discounts:write': 'settings.members.permissionLabels.discountsWrite',
  'settings:write': 'settings.members.permissionLabels.settingsWrite',
  'orders:read': 'settings.members.permissionLabels.ordersRead',
  'orders:fulfill': 'settings.members.permissionLabels.ordersFulfill',
  'stats:read': 'settings.members.permissionLabels.statsRead',
  'customers:read': 'settings.members.permissionLabels.customersRead',
  'customers:write': 'settings.members.permissionLabels.customersWrite',
  'draft_orders:write': 'settings.members.permissionLabels.draftOrdersWrite',
  'refunds:write': 'settings.members.permissionLabels.refundsWrite',
  'channels:write': 'settings.members.permissionLabels.channelsWrite',
  'analytics:read': 'settings.members.permissionLabels.analyticsRead',
};

/** One permission's place in an override. */
type OverrideChoice = 'default' | 'grant' | 'revoke';

const OVERRIDE_CHOICE_KEYS: Record<OverrideChoice, string> = {
  default: 'settings.members.override.default',
  grant: 'settings.members.override.grant',
  revoke: 'settings.members.override.revoke',
};

export default function MembersScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('settings.members.documentTitle')}</title>
      </Head>
      <RequireStore permission="members:manage">
        {(storeId) => <MembersBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function MembersBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { store } = useActiveStoreContext();
  const owner = useOwnerAccount(store?.oxyAccountId);
  const overrides = usePermissionOverrides(storeId);
  const isPersonal = owner.data?.kind === 'personal';
  const members = useOwnerAccountMembers(
    store?.oxyAccountId,
    owner.data !== undefined && !isPersonal,
  );

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">{t('common.back')}</Text>
    </Pressable>
  );

  const loading =
    !store || owner.isPending || overrides.isPending || (!isPersonal && members.isPending);
  const failed = owner.isError || overrides.isError || members.isError;

  return (
    <Screen
      title={t('settings.members.title')}
      subtitle={t('settings.members.subtitle')}
      action={back}
    >
      {loading ? (
        failed ? (
          <ScreenMessage
            title={t('settings.members.loadFailed')}
            body={t('common.pleaseTryAgain')}
          />
        ) : (
          <ScreenLoading />
        )
      ) : failed || !store ? (
        <ScreenMessage title={t('settings.members.loadFailed')} body={t('common.pleaseTryAgain')} />
      ) : (
        <View className="gap-4">
          <OwnerCard
            storeId={storeId}
            store={store}
            ownerName={owner.data?.account.name?.displayName ?? owner.data?.account.username ?? ''}
            isPersonal={isPersonal}
            overrides={overrides.data ?? []}
          />
          {isPersonal ? null : (
            <PeopleList
              storeId={storeId}
              store={store}
              members={(members.data ?? []).map((member) => ({
                oxyUserId: member.memberUserId,
                role: member.role,
              }))}
              overrides={overrides.data ?? []}
            />
          )}
        </View>
      )}
    </Screen>
  );
}

/** Who owns the store, and — for a personal account — the way out of it. */
function OwnerCard({
  storeId,
  store,
  ownerName,
  isPersonal,
  overrides,
}: {
  storeId: string;
  store: Store;
  ownerName: string;
  isPersonal: boolean;
  overrides: StorePermissionOverride[];
}) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const convertControl = useDialogControl();
  const canConvert = store.access.permissions.includes('store:manage');

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Building2 size={18} color={colors.mutedForeground} />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {t('settings.members.ownedBy', { name: ownerName })}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {isPersonal
              ? t('settings.members.personalBody')
              : t('settings.members.organizationBody')}
          </Text>
        </View>
      </View>
      {isPersonal && canConvert ? (
        <>
          <Button tone="accent" className="mt-3 self-start" onPress={() => convertControl.open()}>
            {t('settings.members.convert.open')}
          </Button>
          <ConvertDialog storeId={storeId} control={convertControl} overrides={overrides} />
        </>
      ) : null}
    </View>
  );
}

interface Person {
  oxyUserId: string;
  role: AccountRole;
}

/** The owning organization's members, each with their store exception. */
function PeopleList({
  storeId,
  store,
  members,
  overrides,
}: {
  storeId: string;
  store: Store;
  members: Person[];
  overrides: StorePermissionOverride[];
}) {
  const { t } = useTranslation();
  const byUser = useMemo(() => new Map(overrides.map((o) => [o.oxyUserId, o])), [overrides]);
  const memberIds = new Set(members.map((m) => m.oxyUserId));
  // Exceptions recorded for people who are NOT in the organization grant
  // nothing — Oxy decides who gets in. Shown so they can be cleaned up.
  const outsiders = overrides.filter((o) => !memberIds.has(o.oxyUserId));
  const names = useUsernames([...memberIds, ...outsiders.map((o) => o.oxyUserId)]);

  return (
    <View className="gap-2">
      {members.map((member) => (
        <PersonRow
          key={member.oxyUserId}
          storeId={storeId}
          store={store}
          name={names.data?.get(member.oxyUserId) ?? member.oxyUserId}
          oxyUserId={member.oxyUserId}
          roleLabel={t(ROLE_LABEL_KEYS[member.role])}
          override={byUser.get(member.oxyUserId)}
        />
      ))}
      {outsiders.length > 0 ? (
        <Text className="mt-2 text-xs text-muted-foreground">
          {t('settings.members.outsidersNote')}
        </Text>
      ) : null}
      {outsiders.map((override) => (
        <PersonRow
          key={override.oxyUserId}
          storeId={storeId}
          store={store}
          name={names.data?.get(override.oxyUserId) ?? override.oxyUserId}
          oxyUserId={override.oxyUserId}
          roleLabel={t('settings.members.noAccess')}
          override={override}
        />
      ))}
    </View>
  );
}

function PersonRow({
  storeId,
  store,
  name,
  oxyUserId,
  roleLabel,
  override,
}: {
  storeId: string;
  store: Store;
  name: string;
  oxyUserId: string;
  roleLabel: string;
  override: StorePermissionOverride | undefined;
}) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const editControl = useDialogControl();
  const isOwningAccount = oxyUserId === store.oxyAccountId;

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <ShieldCheck size={18} color={colors.mutedForeground} />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text className="text-xs text-muted-foreground">{roleLabel}</Text>
          {override ? (
            <Text className="text-xs text-muted-foreground">
              {t('settings.members.overrideSummary', {
                granted: override.granted.length,
                revoked: override.revoked.length,
              })}
            </Text>
          ) : null}
        </View>
        {isOwningAccount ? null : (
          <Button tone="neutral" onPress={() => editControl.open()}>
            {t('settings.members.override.edit')}
          </Button>
        )}
      </View>
      {isOwningAccount ? null : (
        <OverrideDialog
          storeId={storeId}
          store={store}
          oxyUserId={oxyUserId}
          name={name}
          override={override}
          control={editControl}
        />
      )}
    </View>
  );
}

/** Edit one person's exception, limited to permissions the editor holds. */
function OverrideDialog({
  storeId,
  store,
  oxyUserId,
  name,
  override,
  control,
}: {
  storeId: string;
  store: Store;
  oxyUserId: string;
  name: string;
  override: StorePermissionOverride | undefined;
  control: DialogControlProps;
}) {
  const { t } = useTranslation();
  const save = useSetPermissionOverride(storeId);
  const initial = useMemo(() => {
    const choices = new Map<StorePermission, OverrideChoice>();
    for (const p of override?.granted ?? []) choices.set(p, 'grant');
    for (const p of override?.revoked ?? []) choices.set(p, 'revoke');
    return choices;
  }, [override]);
  const [choices, setChoices] = useState(initial);
  // Granting or revoking what you do not hold is refused by the API, so it is
  // not offered. A permission already in the override stays visible either way.
  const editable = STORE_PERMISSIONS.filter(
    (p) => store.access.permissions.includes(p) || initial.has(p),
  );

  const submit = () => {
    const granted = editable.filter((p) => choices.get(p) === 'grant');
    const revoked = editable.filter((p) => choices.get(p) === 'revoke');
    save.mutate(
      { oxyUserId, input: { granted, revoked } },
      {
        onSuccess: () => {
          toast.success(t('settings.members.override.saved'));
          control.close();
        },
        onError: () => toast.error(t('settings.members.override.saveFailed')),
      },
    );
  };

  return (
    <Dialog control={control} title={t('settings.members.override.title', { name })}>
      <View className="gap-3">
        <Text className="text-xs text-muted-foreground">{t('settings.members.override.body')}</Text>
        {editable.map((permission) => (
          <View key={permission} className="gap-1">
            <Text className="text-sm text-foreground">{t(PERMISSION_LABEL_KEYS[permission])}</Text>
            <SegmentedControl
              type="radio"
              value={choices.get(permission) ?? 'default'}
              onValueChange={(next: OverrideChoice) => {
                setChoices((prev) => {
                  const updated = new Map(prev);
                  if (next === 'default') updated.delete(permission);
                  else updated.set(permission, next);
                  return updated;
                });
              }}
            >
              {(['default', 'grant', 'revoke'] as OverrideChoice[]).map((choice) => (
                <SegmentedControlItem key={choice} value={choice}>
                  <SegmentedControlItemText>
                    {t(OVERRIDE_CHOICE_KEYS[choice])}
                  </SegmentedControlItemText>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </View>
        ))}
        <Button tone="accent" onPress={submit} loading={save.isPending} className="mt-1">
          {t('settings.members.override.save')}
        </Button>
      </View>
    </Dialog>
  );
}

/**
 * Convert a personally owned store to an organization: create it in Oxy,
 * invite people, then move the store. Prefilled with everyone who holds an
 * exception on this store — the people Mercaria still knows worked here.
 */
function ConvertDialog({
  storeId,
  control,
  overrides,
}: {
  storeId: string;
  control: DialogControlProps;
  overrides: StorePermissionOverride[];
}) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const convert = useConvertToOrganization(storeId);
  const known = useUsernames(overrides.map((o) => o.oxyUserId));
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [added, setAdded] = useState<ConvertInvitee[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [draftRole, setDraftRole] = useState<ConvertInvitee['role']>('editor');

  const prefilled: ConvertInvitee[] = [...(known.data?.values() ?? [])].map((name) => ({
    usernameOrEmail: name,
    role: 'editor',
  }));
  const invitees = [...prefilled, ...added].filter((i) => !removed.has(i.usernameOrEmail));

  const addDraft = () => {
    const value = draft.trim();
    if (!value) return;
    setAdded((prev) => [...prev, { usernameOrEmail: value, role: draftRole }]);
    setDraft('');
  };

  const submit = () => {
    if (!displayName.trim() || !username.trim()) {
      toast.error(t('settings.members.convert.nameRequired'));
      return;
    }
    convert.mutate(
      { displayName: displayName.trim(), username: username.trim(), invitees },
      {
        onSuccess: (result) => {
          if (result.failedInvitees.length > 0) {
            toast.error(
              t('settings.members.convert.someInvitesFailed', {
                names: result.failedInvitees.join(', '),
              }),
            );
          } else {
            toast.success(t('settings.members.convert.done'));
          }
          control.close();
        },
        onError: () => toast.error(t('settings.members.convert.failed')),
      },
    );
  };

  return (
    <Dialog control={control} title={t('settings.members.convert.title')}>
      <View className="gap-4">
        <Text className="text-xs text-muted-foreground">{t('settings.members.convert.body')}</Text>
        <Field label={t('settings.members.convert.displayNameLabel')}>
          <TextFieldInput
            label={t('settings.members.convert.displayNameLabel')}
            value={displayName}
            onValueChange={setDisplayName}
          />
        </Field>
        <Field label={t('settings.members.convert.usernameLabel')}>
          <TextFieldInput
            label={t('settings.members.convert.usernameLabel')}
            value={username}
            onValueChange={setUsername}
            autoCapitalize="none"
          />
        </Field>
        <Text className="text-sm font-semibold text-foreground">
          {t('settings.members.convert.inviteesTitle')}
        </Text>
        {invitees.map((invitee) => (
          <View key={invitee.usernameOrEmail} className="flex-row items-center gap-2">
            <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
              {invitee.usernameOrEmail}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {t(ROLE_LABEL_KEYS[invitee.role])}
            </Text>
            <Pressable
              onPress={() => setRemoved((prev) => new Set(prev).add(invitee.usernameOrEmail))}
              className="p-2 active:opacity-70"
            >
              <Trash2 size={16} color={colors.mutedForeground} />
            </Pressable>
          </View>
        ))}
        <Field label={t('settings.members.convert.inviteLabel')}>
          <TextFieldInput
            label={t('settings.members.convert.inviteLabel')}
            value={draft}
            onValueChange={setDraft}
            placeholder={t('settings.members.convert.invitePlaceholder')}
            autoCapitalize="none"
          />
        </Field>
        <SegmentedControl type="radio" value={draftRole} onValueChange={setDraftRole}>
          {INVITE_ROLES.map((role) => (
            <SegmentedControlItem key={role} value={role}>
              <SegmentedControlItemText>{t(ROLE_LABEL_KEYS[role])}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <Button
          tone="neutral"
          leadingIcon={toBloomIcon(Plus)}
          onPress={addDraft}
          className="self-start"
        >
          {t('settings.members.convert.addInvitee')}
        </Button>
        <Text className="text-xs text-muted-foreground">
          {t('settings.members.convert.warning')}
        </Text>
        <Button tone="accent" onPress={submit} loading={convert.isPending} className="mt-1">
          {t('settings.members.convert.submit')}
        </Button>
      </View>
    </Dialog>
  );
}
