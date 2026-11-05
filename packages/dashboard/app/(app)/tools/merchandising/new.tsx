import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import type { CreateMerchandisingRuleInput } from '@mercaria/shared-types';
import { toast } from '@oxy.so/bloom/toast';
import { RequireStore } from '@/components/shell/RequireStore';
import { Screen } from '@/components/shell/Screen';
import { PlanToolGate } from '@/components/plan-tools/PlanToolGate';
import { RuleEditor } from '@/components/merchandising/RuleEditor';
import { BackLink } from '@/components/merchandising/BackLink';
import { useCreateMerchandisingRule } from '@/lib/hooks/use-merchandising';
import { useTranslation } from '@/lib/i18n';

/** A new merchandising rule. Creating one takes one unit of the plan's allowance. */
export default function NewMerchandisingRuleScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('merchandising.documentTitle')}</title>
      </Head>
      <RequireStore permission="collections:write">
        {(storeId) => <NewRule storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function NewRule({ storeId }: { storeId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const create = useCreateMerchandisingRule(storeId);
  return (
    <Screen title={t('merchandising.newRule')} action={<BackLink />}>
      <PlanToolGate storeId={storeId} capability="advanced_merchandising_rules">
        {() => (
          <RuleEditor
            storeId={storeId}
            canWrite
            saving={create.isPending}
            saveError={create.error}
            onSave={(input) =>
              create.mutate(input as CreateMerchandisingRuleInput, {
                onSuccess: (rule) => {
                  toast.success(t('merchandising.created'));
                  router.replace({
                    pathname: '/tools/merchandising/[id]',
                    params: { id: rule.id },
                  });
                },
              })
            }
          />
        )}
      </PlanToolGate>
    </Screen>
  );
}
