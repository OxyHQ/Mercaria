import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft, Plus, Trash2, ShieldCheck } from "lucide-react-native";
import type { StoreMember, StoreRole } from "@mercaria/shared-types";
import {
  Text,
  Button,
  Input,
  Label,
  ToggleGroup,
  ToggleGroupItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useMembers, useInviteMember, useUpdateMember, useRemoveMember } from "@/lib/hooks/use-members";

const ROLES: StoreRole[] = ["owner", "admin", "staff"];

export default function MembersScreen() {
  return (
    <>
      <Head>
        <title>Members | Mercaria Dashboard</title>
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
  const { data, isPending, isError } = useMembers(storeId);
  const updateMember = useUpdateMember(storeId);
  const removeMember = useRemoveMember(storeId);
  const [inviteOpen, setInviteOpen] = useState(false);

  const back = (
    <View className="flex-row items-center gap-2">
      <Pressable
        onPress={() => router.back()}
        className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
      >
        <ChevronLeft size={16} color={colors.foreground} />
        <Text className="text-sm font-medium text-foreground">Back</Text>
      </Pressable>
      <Button onPress={() => setInviteOpen(true)}>
        <View className="flex-row items-center gap-2">
          <Plus size={16} color={colors.primaryForeground} />
          <Text className="font-semibold text-primary-foreground">Invite</Text>
        </View>
      </Button>
    </View>
  );

  return (
    <Screen title="Members & roles" subtitle="Who can manage this store" action={back}>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load members" body="Please try again." />
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
                    onSuccess: () => toast.success("Role updated"),
                    onError: () => toast.error("Couldn't update the member"),
                  },
                )
              }
              onRemove={() =>
                removeMember.mutate(member.oxyUserId, {
                  onSuccess: () => toast.success("Member removed"),
                  onError: () => toast.error("Couldn't remove the member"),
                })
              }
            />
          ))}
        </View>
      )}

      <InviteMemberDialog storeId={storeId} open={inviteOpen} onOpenChange={setInviteOpen} />
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
          <Text className="text-xs text-muted-foreground">
            Joined {new Date(member.joinedAt).toLocaleDateString()}
          </Text>
        </View>
        {!isOwner ? (
          <Pressable onPress={onRemove} className="p-2 active:opacity-70">
            <Trash2 size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
      <View className="mt-3">
        <ToggleGroup
          type="single"
          value={member.role}
          onValueChange={(v) => {
            if (typeof v === "string" && v && v !== member.role) {
              onChangeRole(v as StoreRole);
            }
          }}
        >
          {ROLES.map((role) => (
            <ToggleGroupItem key={role} value={role}>
              <Text className="text-sm capitalize text-foreground">{role}</Text>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Text className="mt-2 text-xs text-muted-foreground">
          {member.permissions.length} explicit permission{member.permissions.length === 1 ? "" : "s"} granted
        </Text>
      </View>
    </View>
  );
}

function InviteMemberDialog({
  storeId,
  open,
  onOpenChange,
}: {
  storeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const inviteMember = useInviteMember(storeId);
  const [oxyUserId, setOxyUserId] = useState("");
  const [role, setRole] = useState<StoreRole>("staff");

  const submit = () => {
    if (!oxyUserId.trim()) {
      toast.error("Enter the member's Oxy user id");
      return;
    }
    inviteMember.mutate(
      { oxyUserId: oxyUserId.trim(), role },
      {
        onSuccess: () => {
          toast.success("Member added");
          setOxyUserId("");
          setRole("staff");
          onOpenChange(false);
        },
        onError: () => toast.error("Couldn't add the member"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>Oxy user id</Label>
            <Input value={oxyUserId} onChangeText={setOxyUserId} placeholder="oxy user id" autoCapitalize="none" />
          </View>
          <View className="gap-1.5">
            <Label>Role</Label>
            <ToggleGroup
              type="single"
              value={role}
              onValueChange={(v) => typeof v === "string" && v && setRole(v as StoreRole)}
            >
              {(["admin", "staff"] as StoreRole[]).map((r) => (
                <ToggleGroupItem key={r} value={r}>
                  <Text className="text-sm capitalize text-foreground">{r}</Text>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </View>
          <Button onPress={submit} isLoading={inviteMember.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">Add member</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
