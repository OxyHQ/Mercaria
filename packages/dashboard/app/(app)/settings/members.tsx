import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, Plus, Trash2, ShieldCheck } from "lucide-react-native";
import type { StoreMember, StoreRole } from "@mercaria/shared-types";
import {
  Text,
  useColorScheme,
  formatDate,
  toBloomIcon,
} from "@mercaria/ui";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Button } from "@oxy.so/bloom/button";
import { Dialog, useDialogControl, type DialogControlProps } from "@oxy.so/bloom/dialog";
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from "@oxy.so/bloom/segmented-control";
import { toast } from "@oxy.so/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useTranslation } from "@/lib/i18n";
import { useMembers, useInviteMember, useUpdateMember, useRemoveMember } from "@/lib/hooks/use-members";

const ROLES: StoreRole[] = ["owner", "admin", "staff"];

/**
 * Display label per role (#398).
 *
 * A KEY per role rather than the word itself: this map is evaluated at import,
 * before the locale store has rehydrated, and `StoreRole` is a wire identifier
 * that must keep reaching the API verbatim. Every reader calls `t()` on the key
 * and re-renders when the locale changes.
 */
const ROLE_LABEL_KEYS: Record<StoreRole, string> = {
  owner: "settings.members.roles.owner",
  admin: "settings.members.roles.admin",
  staff: "settings.members.roles.staff",
};

export default function MembersScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("settings.members.documentTitle")}</title>
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
  const { data, isPending, isError } = useMembers(storeId);
  const updateMember = useUpdateMember(storeId);
  const removeMember = useRemoveMember(storeId);
  const inviteControl = useDialogControl();

  const back = (
    <View className="flex-row items-center gap-2">
      <Pressable
        onPress={() => router.back()}
        className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
      >
        <ChevronLeft size={16} color={colors.foreground} />
        <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
      </Pressable>
      <Button
        tone="accent"
        leadingIcon={toBloomIcon(Plus)}
        onPress={() => inviteControl.open()}
      >
        {t("settings.members.invite")}
      </Button>
    </View>
  );

  return (
    <Screen
      title={t("settings.members.title")}
      subtitle={t("settings.members.subtitle")}
      action={back}
    >
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage
          title={t("settings.members.loadFailed")}
          body={t("common.pleaseTryAgain")}
        />
      ) : (
        <View className="gap-2">
          {data?.map((member) => (
            <MemberRow
              key={member.oxyUserId}
              member={member}
              onChangeRole={(role) =>
                updateMember.mutate(
                  { oxyUserId: member.oxyUserId, input: { role } },
                  {
                    onSuccess: () => toast.success(t("settings.members.roleUpdated")),
                    onError: () => toast.error(t("settings.members.roleUpdateFailed")),
                  },
                )
              }
              onRemove={() =>
                removeMember.mutate(member.oxyUserId, {
                  onSuccess: () => toast.success(t("settings.members.removed")),
                  onError: () => toast.error(t("settings.members.removeFailed")),
                })
              }
            />
          ))}
        </View>
      )}

      <InviteMemberDialog storeId={storeId} control={inviteControl} />
    </Screen>
  );
}

function MemberRow({
  member,
  onChangeRole,
  onRemove,
}: {
  member: StoreMember;
  onChangeRole: (role: StoreRole) => void;
  onRemove: () => void;
}) {
  const { colors } = useColorScheme();
  const { t, locale } = useTranslation();
  const joinedOn = formatDate(member.joinedAt, locale);
  const isOwner = member.role === "owner";

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <ShieldCheck size={18} color={colors.mutedForeground} />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {member.oxyUserId}
          </Text>
          {/* The sentence NAMES the date, so an unformattable one drops the
              whole line rather than interpolating a null — i18n-js renders a
              missing placeholder as the literal `[missing "%{date}" value]`
              (#529). The account id above already identifies the member. */}
          {joinedOn === null ? null : (
            <Text className="text-xs text-muted-foreground">
              {t("settings.members.joinedOn", { date: joinedOn })}
            </Text>
          )}
        </View>
        {!isOwner ? (
          <Pressable onPress={onRemove} className="p-2 active:opacity-70">
            <Trash2 size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
      <View className="mt-3">
        <SegmentedControl
          type="radio"
          label={t("settings.members.roleLabel")}
          value={member.role}
          onValueChange={(next) => {
            if (next !== member.role) onChangeRole(next);
          }}
        >
          {ROLES.map((role) => (
            <SegmentedControlItem key={role} value={role}>
              <SegmentedControlItemText>{t(ROLE_LABEL_KEYS[role])}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <Text className="mt-2 text-xs text-muted-foreground">
          {t("settings.members.explicitPermissions", { count: member.permissions.length })}
        </Text>
      </View>
    </View>
  );
}

function InviteMemberDialog({
  storeId,
  control,
}: {
  storeId: string;
  control: DialogControlProps;
}) {
  const inviteMember = useInviteMember(storeId);
  const { t } = useTranslation();
  const [oxyUserId, setOxyUserId] = useState("");
  const [role, setRole] = useState<StoreRole>("staff");

  const submit = () => {
    if (!oxyUserId.trim()) {
      toast.error(t("settings.members.oxyUserIdRequired"));
      return;
    }
    inviteMember.mutate(
      { oxyUserId: oxyUserId.trim(), role },
      {
        onSuccess: () => {
          toast.success(t("settings.members.added"));
          setOxyUserId("");
          setRole("staff");
          control.close();
        },
        onError: () => toast.error(t("settings.members.addFailed")),
      },
    );
  };

  return (
    <Dialog control={control} title={t("settings.members.inviteTitle")}>
      <View className="gap-4">
        <Field label={t("settings.members.oxyUserIdLabel")}>
          <TextFieldInput
            label={t("settings.members.oxyUserIdLabel")}
            value={oxyUserId}
            onValueChange={setOxyUserId}
            placeholder={t("settings.members.oxyUserIdPlaceholder")}
            autoCapitalize="none"
          />
        </Field>
        <Field label={t("settings.members.roleLabel")}>
          <SegmentedControl
            type="radio"
            value={role}
            onValueChange={setRole}
          >
            {(["admin", "staff"] as StoreRole[]).map((r) => (
              <SegmentedControlItem key={r} value={r}>
                <SegmentedControlItemText>{t(ROLE_LABEL_KEYS[r])}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Field>
        <Button tone="accent" onPress={submit} loading={inviteMember.isPending} className="mt-1">
          {t("settings.members.addMember")}
        </Button>
      </View>
    </Dialog>
  );
}
