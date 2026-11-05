import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import type { UpdateMerchandisingRuleInput } from '@mercaria/shared-types';
import { toast } from '@oxy.so/bloom/toast';
import { RequireStore } from '@/components/shell/RequireStore';
import { Screen, ScreenLoading, ScreenMessage } from '@/components/shell/Screen';
import { PlanToolGate } from '@/components/plan-tools/PlanToolGate';
import { RuleEditor } from '@/components/merchandising/RuleEditor';
import { useActiveStoreContext } from '@/lib/hooks/use-stores';
import { useMerchandisingRule, useUpdateMerchandisingRule } from '@/lib/hooks/use-merchandising';
import { useTranslation } from '@/lib/i18n';
import { BackLink } from '@/components/merchandising/BackLink';

/** One merchandising rule: edit its order, pins, schedule or spotlight. */
export default function MerchandisingRuleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('merchandising.documentTitle')}</title>
      </Head>
      <RequireStore permission="products:read">
        {(storeId) => <RuleDetail key={`${storeId}:${id}`} storeId={storeId} id={String(id)} />}
      </RequireStore>
    </>
  );
}

function RuleDetail({ storeId, id }: { storeId: string; id: string }) {
  const { t } = useTranslation();
  const { can } = useActiveStoreContext();
  const query = useMerchandisingRule(storeId, id);
  const update = useUpdateMerchandisingRule(storeId, id);
  return (
    <Screen title={query.data?.title ?? t('merchandising.title')} action={<BackLink />}>
      <PlanToolGate storeId={storeId} capability="advanced_merchandising_rules">
        {() =>
          query.isPending ? (
            <ScreenLoading />
          ) : query.isError ? (
            <ScreenMessage title={t('merchandising.loadError')} body={t('common.pleaseTryAgain')} />
          ) : (
            <RuleEditor
              key={query.data.updatedAt}
              storeId={storeId}
              rule={query.data}
              canWrite={can('collections:write')}
              saving={update.isPending}
              saveError={update.error}
              onSave={(input) =>
                update.mutate(input as UpdateMerchandisingRuleInput, {
                  onSuccess: () => toast.success(t('merchandising.saved')),
                })
              }
            />
          )
        }
      </PlanToolGate>
    </Screen>
  );
}
