import React, { useState } from 'react';
import { View } from 'react-native';
import type { PlaceClaim, PlaceClaimRole } from '@goway.to/sdk';
import { Text } from '@mercaria/ui';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { toast } from '@oxy.so/bloom/toast';
import { useClaimGoWayPlace } from '@/lib/goway/hooks';
import { goWayErrorKey } from '@/lib/goway/errors';
import { CLAIM_STATE_KEYS, canFileClaim } from '@/lib/goway/place-link';
import { useTranslation } from '@/lib/i18n';
import { EditorSection } from './EditorSection';

/** The roles a store files under, as KEYS. A chain claiming each branch is `brand`. */
const CLAIM_ROLE_KEYS: Record<PlaceClaimRole, string> = {
  owner: 'settings.locations.editor.claim.role.owner',
  operator: 'settings.locations.editor.claim.role.operator',
  manager: 'settings.locations.editor.claim.role.manager',
  brand: 'settings.locations.editor.claim.role.brand',
};

const CLAIM_ROLES: PlaceClaimRole[] = ['owner', 'operator', 'manager', 'brand'];

/**
 * The store's claim on its GoWay place, filed FOR the store's owning Oxy
 * account (ADR 0012) — usually its organization — with the merchant's session.
 *
 * An approved claim is what lets the store edit the place and assert its
 * capabilities at `business_asserted`; GoWay's moderators approve it, so a new
 * claim sits `pending` and the screen says so rather than implying a fault.
 * Filing in an organization's name needs its owner or admin; GoWay refuses
 * anybody else, and the error says so.
 */
export function PlaceClaimCard({
  placeId,
  oxyAccountId,
  claim,
  claimsUnreadable,
}: {
  placeId: string;
  oxyAccountId: string;
  claim: PlaceClaim | undefined;
  claimsUnreadable: boolean;
}) {
  const { t } = useTranslation();
  const file = useClaimGoWayPlace(placeId);
  const [role, setRole] = useState<PlaceClaimRole>('owner');

  return (
    <EditorSection
      title={t('settings.locations.editor.claim.title')}
      description={t('settings.locations.editor.claim.description')}
    >
      {claimsUnreadable ? (
        <Text className="text-sm text-muted-foreground">
          {t('settings.locations.editor.claim.unreadable')}
        </Text>
      ) : null}
      {claim ? (
        <View className="flex-row items-center gap-2">
          <Badge
            size="label-small"
            variant="subtle"
            color={
              claim.state === 'approved'
                ? 'success'
                : claim.state === 'pending'
                  ? 'warning'
                  : 'error'
            }
            content={t(CLAIM_STATE_KEYS[claim.state])}
          />
          <Text className="text-xs text-muted-foreground">{t(CLAIM_ROLE_KEYS[claim.role])}</Text>
        </View>
      ) : null}
      {claim?.state === 'pending' ? (
        <Text className="text-xs text-muted-foreground">
          {t('settings.locations.editor.claim.pendingNote')}
        </Text>
      ) : null}
      {canFileClaim(claim) ? (
        <View className="gap-2">
          <SegmentedControl type="radio" value={role} onValueChange={setRole}>
            {CLAIM_ROLES.map((option) => (
              <SegmentedControlItem key={option} value={option}>
                <SegmentedControlItemText>{t(CLAIM_ROLE_KEYS[option])}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <Button
            tone="accent"
            loading={file.isPending}
            onPress={() =>
              file.mutate(
                { oxyAccountId, role },
                {
                  onSuccess: () => toast.success(t('settings.locations.editor.claim.filed')),
                  onError: (error) => toast.error(t(goWayErrorKey(error))),
                },
              )
            }
          >
            {t('settings.locations.editor.claim.file')}
          </Button>
        </View>
      ) : null}
    </EditorSection>
  );
}
