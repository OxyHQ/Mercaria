import { useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useOxy } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { Dialog, type DialogControlProps } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { RadioGroup } from '@oxy.so/bloom/radio';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import type {
  MerchantClaim,
  MerchantClaimChallengeInstructions,
  MerchantClaimMethodOption,
} from '@mercaria/shared-types';
import { ShopDetailIcon, Text, formatDateTime } from '@mercaria/ui';
import { bindMerchantReferral } from '@/lib/api/referrals';
import { REFERRAL_CLIENT_SURFACE } from '@/lib/hooks/use-referral-binding';
import { merchantClaimErrorStatus } from '@/lib/api/merchant-claims';
import {
  currentClaimFor,
  endedClaimFor,
  useContestMerchantClaim,
  useIssueMerchantClaimChallenge,
  useMerchantClaimChallenge,
  useMyMerchantClaims,
  useStartMerchantClaim,
  useSubmitMerchantClaim,
  useVerifyMerchantClaim,
} from '@/lib/hooks/use-merchant-claims';
import { useTranslation } from '@/lib/i18n';

/**
 * The claim flow (#83, #85): proving you operate a merchant, from the merchant
 * page's `Claim this merchant` button — and contesting a verified operator
 * from the same page when the merchant is already claimed.
 *
 * ## One Bloom dialog, not a stack of screens
 *
 * The flow is short (pick a proof, publish a value, check it) and is always
 * entered from one merchant page, so it is a dialog over that page the way an
 * abuse report is. A route would add a deep link nobody needs, and the
 * challenge token — which must never be in a URL — would have to travel
 * between screens some other way.
 *
 * ## The server's state is the step
 *
 * The step shown is DERIVED from the caller's own claim on this merchant
 * (`GET /merchant-claims`), never kept beside it: closing the dialog and coming
 * back, or reloading, resumes wherever the server says the claim is. The one
 * thing the server cannot give back is the challenge token, so a
 * `challenge_pending` claim without instructions in this session offers a new
 * code (which supersedes the old one) rather than pretending to remember it.
 *
 * ## What the storefront offers
 *
 * The domain proofs and document review. The platform proofs
 * (`platform_oauth`, `channel_key`) take a connection id the claimant can only
 * see in a store's dashboard, so they are not offered here; `role_email` is
 * never in the server's list at all (no outbound email transport).
 *
 * ## After a claim opens
 *
 * The referral binding is posted (`bindMerchantReferral`) so a carried
 * merchant-referral click attaches to the claim — fire and forget: it never
 * blocks, delays or fails the claim, and a 404 (the edge unmounted) is nothing
 * to do. It lives here and in a module named for referrals because the
 * merchant-page isolation gate rightly keeps commercial inputs out of every
 * merchant-page module.
 */

/** The proofs a claimant can complete from the storefront. */
type StorefrontMethod = 'dns_txt' | 'well_known_file' | 'meta_tag' | 'business_document';

/** The order they are offered in — strongest first, review last. */
const STOREFRONT_METHODS: readonly StorefrontMethod[] = [
  'dns_txt',
  'well_known_file',
  'meta_tag',
  'business_document',
];

/**
 * KEYS rather than sentences: module scope, so a `t()` here would resolve
 * before the locale store rehydrates. Each key is a literal so the i18n guard
 * can see it is referenced.
 */
const METHOD_LABEL_KEYS: Readonly<Record<StorefrontMethod, string>> = {
  dns_txt: 'merchantClaim.method.dnsTxt.label',
  well_known_file: 'merchantClaim.method.wellKnownFile.label',
  meta_tag: 'merchantClaim.method.metaTag.label',
  business_document: 'merchantClaim.method.businessDocument.label',
};
Object.freeze(METHOD_LABEL_KEYS);

const METHOD_DESCRIPTION_KEYS: Readonly<Record<StorefrontMethod, string>> = {
  dns_txt: 'merchantClaim.method.dnsTxt.description',
  well_known_file: 'merchantClaim.method.wellKnownFile.description',
  meta_tag: 'merchantClaim.method.metaTag.description',
  business_document: 'merchantClaim.method.businessDocument.description',
};
Object.freeze(METHOD_DESCRIPTION_KEYS);

/** Matches the server's `contest` reason bounds. */
const CONTEST_REASON_MIN = 20;
const CONTEST_REASON_MAX = 4000;
/** Matches the server's evidence note bound. */
const NOTE_MAX = 4000;

type ClaimFailureContext = 'open' | 'challenge' | 'verify' | 'submit' | 'contest';

/** The translated sentence for a refused call, by where it happened and how. */
function failureKey(context: ClaimFailureContext, error: unknown): string {
  const status = merchantClaimErrorStatus(error);
  if (status === 429) return 'merchantClaim.errors.tooMany';
  if (context === 'verify' && status === 400) return 'merchantClaim.errors.notFoundYet';
  if (context === 'verify' && status === 409) return 'merchantClaim.errors.codeUnusable';
  if (context === 'challenge' && status === 409) return 'merchantClaim.errors.tooMany';
  if (context === 'open' && status === 409) return 'merchantClaim.errors.cannotOpen';
  if (context === 'contest' && status === 409) return 'merchantClaim.errors.cannotContest';
  if (status === 400) return 'merchantClaim.errors.invalid';
  return 'merchantClaim.errors.generic';
}

/** The domain a domain-proof claim is about — it is the claim's `domain` scope. */
function claimDomain(claim: MerchantClaim): string | undefined {
  return claim.requestedScope.find((scope) => scope.kind === 'domain')?.ref;
}

/** A trimmed value as one optional evidence entry, or nothing. */
function evidenceFrom(input: { url: string; note: string }): { url?: string; note?: string }[] {
  const url = input.url.trim();
  const note = input.note.trim();
  if (!url && !note) return [];
  return [{ ...(url ? { url } : {}), ...(note ? { note } : {}) }];
}

export function MerchantClaimDialog({
  merchantId,
  merchantName,
  mode,
  availableMethods,
  control,
}: {
  merchantId: string;
  merchantName: string;
  mode: 'claim' | 'contest';
  availableMethods: readonly MerchantClaimMethodOption[];
  control: DialogControlProps;
}) {
  const { t } = useTranslation();
  const heading =
    mode === 'contest'
      ? t('merchantClaim.contest.title', { merchant: merchantName })
      : t('merchantClaim.title', { merchant: merchantName });
  return (
    <Dialog control={control} label={heading} title={heading} testID="merchant-claim-dialog">
      <ClaimFlow
        merchantId={merchantId}
        merchantName={merchantName}
        mode={mode}
        availableMethods={availableMethods}
        onDone={() => control.close()}
      />
    </Dialog>
  );
}

function ClaimFlow({
  merchantId,
  merchantName,
  mode,
  availableMethods,
  onDone,
}: {
  merchantId: string;
  merchantName: string;
  mode: 'claim' | 'contest';
  availableMethods: readonly MerchantClaimMethodOption[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { isAuthenticated, openAccountDialog } = useOxy();
  const claims = useMyMerchantClaims(isAuthenticated);

  if (!isAuthenticated) {
    // The merchant page asks for a session before opening this, so this is the
    // session lapsing mid-flow: the honest affordance is the one that gets one.
    return (
      <View className="gap-4 pb-4">
        <Text className="text-sm text-muted-foreground">{t('merchantClaim.signInPrompt')}</Text>
        <Button onPress={() => openAccountDialog()}>{t('merchantClaim.signIn')}</Button>
      </View>
    );
  }

  if (claims.isError) {
    return (
      <View className="gap-4 pb-4">
        <Text accessibilityRole="alert" className="text-sm text-muted-foreground">
          {t('merchantClaim.loadFailed')}
        </Text>
        <Button
          appearance="outline"
          loading={claims.isFetching}
          onPress={() => void claims.refetch()}
        >
          {t('common.tryAgain')}
        </Button>
      </View>
    );
  }

  if (!claims.data) {
    return (
      <View className="pb-4">
        <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </Text>
      </View>
    );
  }

  const current = currentClaimFor(claims.data, merchantId);
  if (current) {
    return <CurrentClaim claim={current} merchantName={merchantName} onDone={onDone} />;
  }

  const ended = endedClaimFor(claims.data, merchantId);
  return (
    <View className="gap-4 pb-4">
      {ended ? <EndedClaimNotice claim={ended} /> : null}
      {mode === 'contest' ? (
        <ContestForm merchantId={merchantId} />
      ) : (
        <StartClaimForm merchantId={merchantId} availableMethods={availableMethods} />
      )}
    </View>
  );
}

/** Why the previous claim on this merchant is over, so starting again makes sense. */
function EndedClaimNotice({ claim }: { claim: MerchantClaim }) {
  const { t } = useTranslation();
  const key =
    claim.state === 'rejected'
      ? 'merchantClaim.previous.rejected'
      : claim.state === 'revoked'
        ? 'merchantClaim.previous.revoked'
        : 'merchantClaim.previous.expired';
  return (
    <View className="gap-1 rounded-2xl bg-muted p-3">
      <Text className="text-sm text-foreground">{t(key)}</Text>
      {claim.state === 'rejected' && claim.decisionReason ? (
        <Text className="text-xs text-muted-foreground">
          {t('merchantClaim.previous.reason', { reason: claim.decisionReason })}
        </Text>
      ) : null}
    </View>
  );
}

function StartClaimForm({
  merchantId,
  availableMethods,
}: {
  merchantId: string;
  availableMethods: readonly MerchantClaimMethodOption[];
}) {
  const { t } = useTranslation();
  // The server's list decides what is OFFERED; this one decides what the
  // storefront can complete. Only their intersection is shown.
  const options = STOREFRONT_METHODS.flatMap((method) => {
    const offered = availableMethods.find((option) => option.method === method);
    // `subjectKind` is the server's answer to "what does this proof name" — a
    // `domain` method needs the claimant's domain before the challenge opens.
    return offered
      ? [{ method, autoVerifies: offered.autoVerifies, subjectKind: offered.subjectKind }]
      : [];
  });
  const [method, setMethod] = useState<StorefrontMethod | undefined>(options[0]?.method);
  const [domain, setDomain] = useState('');
  // Fire and forget — see the header. Never awaited, never surfaced.
  const start = useStartMerchantClaim(
    (claim) =>
      void bindMerchantReferral({ merchantId: claim.merchantId, surface: REFERRAL_CLIENT_SURFACE }),
  );

  if (options.length === 0) {
    return <Text className="text-sm text-muted-foreground">{t('merchantClaim.noMethods')}</Text>;
  }

  const needsDomain = options.find((option) => option.method === method)?.subjectKind === 'domain';
  const trimmedDomain = domain.trim();
  const canStart =
    method !== undefined && (!needsDomain || trimmedDomain.length >= 3) && !start.isPending;

  return (
    <View className="gap-4">
      <Text className="text-sm text-muted-foreground">{t('merchantClaim.intro')}</Text>
      <RadioGroup
        label={t('merchantClaim.method.title')}
        value={method}
        onValueChange={(value) => setMethod(value as StorefrontMethod)}
        variant="card"
        // A card's description is one line, so it carries the one fact that
        // differs in KIND between methods — who decides — and the selected
        // method's instructions sit under the group where they can wrap.
        options={options.map((option) => ({
          value: option.method,
          label: t(METHOD_LABEL_KEYS[option.method]),
          description: t(
            option.autoVerifies
              ? 'merchantClaim.method.checkedAutomatically'
              : 'merchantClaim.method.reviewedByPerson',
          ),
        }))}
      />
      {method !== undefined ? (
        <Text className="text-sm text-foreground">{t(METHOD_DESCRIPTION_KEYS[method])}</Text>
      ) : null}
      {needsDomain ? (
        <Field label={t('merchantClaim.domain.label')} description={t('merchantClaim.domain.help')}>
          <TextFieldInput
            label={t('merchantClaim.domain.label')}
            value={domain}
            onValueChange={setDomain}
            placeholder={t('merchantClaim.domain.placeholder')}
            keyboardType="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={253}
          />
        </Field>
      ) : null}
      {start.isError ? <FailureText context="open" error={start.error} /> : null}
      <Button
        disabled={!canStart}
        loading={start.isPending}
        onPress={() => {
          if (method === undefined) return;
          start.mutate({
            merchantId,
            method,
            ...(needsDomain ? { domain: trimmedDomain } : {}),
            withChallenge: needsDomain,
          });
        }}
      >
        {start.isPending ? t('merchantClaim.starting') : t('merchantClaim.start')}
      </Button>
    </View>
  );
}

function FailureText({ context, error }: { context: ClaimFailureContext; error: unknown }) {
  const { t } = useTranslation();
  return (
    <Text accessibilityRole="alert" className="text-sm text-destructive">
      {t(failureKey(context, error))}
    </Text>
  );
}

/** Whatever the caller's live (or verified) claim on this merchant needs next. */
function CurrentClaim({
  claim,
  merchantName,
  onDone,
}: {
  claim: MerchantClaim;
  merchantName: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  switch (claim.state) {
    case 'draft':
    case 'challenge_pending':
      return claim.method === 'business_document' ? (
        <EvidenceForm claim={claim} />
      ) : (
        <ChallengeStep claim={claim} />
      );
    case 'verified':
      return (
        <StatusPanel
          title={t('merchantClaim.status.verified.title')}
          body={t('merchantClaim.status.verified.body', { merchant: merchantName })}
          onDone={onDone}
        />
      );
    case 'review_pending':
      return (
        <StatusPanel
          title={t('merchantClaim.status.reviewPending.title')}
          body={t('merchantClaim.status.reviewPending.body')}
          onDone={onDone}
        />
      );
    case 'disputed':
      return (
        <StatusPanel
          title={t('merchantClaim.status.disputed.title')}
          body={t('merchantClaim.status.disputed.body')}
          onDone={onDone}
        />
      );
    default:
      // Ended claims are filtered out before this; nothing to show.
      return null;
  }
}

function StatusPanel({ title, body, onDone }: { title: string; body: string; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="gap-3 pb-4" accessibilityLiveRegion="polite">
      <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
        {title}
      </Text>
      <Text className="text-sm text-muted-foreground">{body}</Text>
      <Button appearance="outline" onPress={onDone}>
        {t('merchantClaim.close')}
      </Button>
    </View>
  );
}

/**
 * The domain proofs: get a code, publish it, ask the server to look.
 *
 * The instructions come from this session's cache. When there are none — a
 * draft whose code was never issued, a code issued in another session, or one
 * that has expired — the only way forward is a new code.
 */
function ChallengeStep({ claim }: { claim: MerchantClaim }) {
  const { t } = useTranslation();
  const challenge = useMerchantClaimChallenge(claim.id);
  const issue = useIssueMerchantClaimChallenge();
  const verify = useVerifyMerchantClaim();
  const domain = claimDomain(claim) ?? '';
  const instructions = challenge.data ?? undefined;
  const usable =
    instructions !== undefined &&
    claim.state === 'challenge_pending' &&
    new Date(instructions.expiresAt).getTime() > Date.now();

  if (!usable) {
    return (
      <View className="gap-4 pb-4">
        <Text className="text-sm text-muted-foreground">
          {claim.state === 'draft'
            ? t('merchantClaim.challenge.draftIntro', { domain })
            : t('merchantClaim.challenge.lost')}
        </Text>
        {issue.isError ? <FailureText context="challenge" error={issue.error} /> : null}
        <Button loading={issue.isPending} onPress={() => issue.mutate(claim)}>
          {issue.isPending
            ? t('merchantClaim.challenge.gettingCode')
            : t('merchantClaim.challenge.getCode')}
        </Button>
      </View>
    );
  }

  return (
    <View className="gap-4 pb-4">
      <ChallengeInstructions instructions={instructions} />
      {verify.isError ? <FailureText context="verify" error={verify.error} /> : null}
      {issue.isError ? <FailureText context="challenge" error={issue.error} /> : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          loading={verify.isPending}
          disabled={issue.isPending}
          onPress={() => {
            issue.reset();
            verify.mutate({ claimId: claim.id, token: instructions.token ?? '' });
          }}
        >
          {verify.isPending
            ? t('merchantClaim.challenge.verifying')
            : t('merchantClaim.challenge.verify')}
        </Button>
        <Button
          appearance="outline"
          loading={issue.isPending}
          disabled={verify.isPending}
          onPress={() => {
            verify.reset();
            issue.mutate(claim);
          }}
        >
          {t('merchantClaim.challenge.newCode')}
        </Button>
      </View>
    </View>
  );
}

/** Where to put the proof, per method, with each value copyable. */
function ChallengeInstructions({
  instructions,
}: {
  instructions: MerchantClaimChallengeInstructions;
}) {
  const { t, locale } = useTranslation();
  const until = formatDateTime(instructions.expiresAt, locale);
  return (
    <View className="gap-3">
      {instructions.method === 'dns_txt' ? (
        <>
          <Text className="text-sm text-foreground">
            {t('merchantClaim.challenge.dnsTxt.step', { domain: instructions.subject })}
          </Text>
          <CopyValue
            label={t('merchantClaim.challenge.dnsTxt.nameLabel')}
            value={instructions.dnsRecordName ?? ''}
          />
          <CopyValue
            label={t('merchantClaim.challenge.dnsTxt.valueLabel')}
            value={instructions.dnsRecordValue ?? ''}
          />
          <Text className="text-xs text-muted-foreground">
            {t('merchantClaim.challenge.dnsTxt.note')}
          </Text>
        </>
      ) : null}
      {instructions.method === 'well_known_file' ? (
        <>
          <Text className="text-sm text-foreground">
            {t('merchantClaim.challenge.wellKnownFile.step')}
          </Text>
          <CopyValue
            label={t('merchantClaim.challenge.wellKnownFile.urlLabel')}
            value={`https://${instructions.subject}${instructions.filePath ?? ''}`}
          />
          <CopyValue
            label={t('merchantClaim.challenge.wellKnownFile.contentsLabel')}
            value={instructions.fileContents ?? ''}
          />
        </>
      ) : null}
      {instructions.method === 'meta_tag' ? (
        <>
          <Text className="text-sm text-foreground">
            {t('merchantClaim.challenge.metaTag.step', {
              url: `https://${instructions.subject}/`,
            })}
          </Text>
          <CopyValue
            label={t('merchantClaim.challenge.metaTag.tagLabel')}
            value={`<meta name="${instructions.metaTagName ?? ''}" content="${instructions.metaTagContent ?? ''}">`}
          />
        </>
      ) : null}
      {until ? (
        <Text className="text-xs text-muted-foreground">
          {t('merchantClaim.challenge.expires', { time: until })}
        </Text>
      ) : null}
    </View>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  async function copy() {
    setStatus('pending');
    try {
      if (!(await Clipboard.setStringAsync(value))) throw new Error('Clipboard unavailable');
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }
  return (
    <View className="gap-1">
      <Text className="text-xs font-semibold text-muted-foreground">{label}</Text>
      <View className="min-w-0 flex-row items-center gap-2 rounded-xl border border-border px-3 py-2">
        <Text selectable className="min-w-0 flex-1 font-mono text-sm text-foreground">
          {value}
        </Text>
        <Button
          iconOnly
          appearance="plain"
          material="flat"
          accessibilityLabel={t('merchantClaim.copy', { label })}
          loading={status === 'pending'}
          onPress={() => void copy()}
          icon={<ShopDetailIcon name="copy" size={20} className="text-foreground" />}
        />
      </View>
      {status === 'copied' || status === 'failed' ? (
        <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
          {t(status === 'copied' ? 'merchantClaim.copied' : 'merchantClaim.copyFailed')}
        </Text>
      ) : null}
    </View>
  );
}

/** A document claim's evidence: a link and/or a note, then a person decides. */
function EvidenceForm({ claim }: { claim: MerchantClaim }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const submit = useSubmitMerchantClaim();
  const evidence = evidenceFrom({ url, note });

  return (
    <View className="gap-4 pb-4">
      <Text className="text-sm text-muted-foreground">{t('merchantClaim.evidence.intro')}</Text>
      <Field label={t('merchantClaim.evidence.urlLabel')}>
        <TextFieldInput
          label={t('merchantClaim.evidence.urlLabel')}
          value={url}
          onValueChange={setUrl}
          placeholder={t('merchantClaim.evidence.urlPlaceholder')}
          keyboardType="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={2048}
        />
      </Field>
      <Field label={t('merchantClaim.evidence.noteLabel')}>
        <Textarea value={note} onValueChange={setNote} maxLength={NOTE_MAX} rows={4} autoResize />
      </Field>
      {submit.isError ? <FailureText context="submit" error={submit.error} /> : null}
      <Button
        disabled={evidence.length === 0 || submit.isPending}
        loading={submit.isPending}
        onPress={() => submit.mutate({ claimId: claim.id, evidence })}
      >
        {submit.isPending
          ? t('merchantClaim.evidence.submitting')
          : t('merchantClaim.evidence.submit')}
      </Button>
    </View>
  );
}

/** Contesting a verified operator: a reason a person can act on, optionally a link. */
function ContestForm({ merchantId }: { merchantId: string }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [url, setUrl] = useState('');
  const contest = useContestMerchantClaim();
  const trimmed = reason.trim();
  const evidence = evidenceFrom({ url, note: '' });

  return (
    <View className="gap-4">
      <Text className="text-sm text-muted-foreground">{t('merchantClaim.contest.intro')}</Text>
      <Field
        label={t('merchantClaim.contest.reasonLabel')}
        description={t('merchantClaim.contest.reasonHelp')}
      >
        <Textarea
          value={reason}
          onValueChange={setReason}
          maxLength={CONTEST_REASON_MAX}
          rows={4}
          autoResize
        />
      </Field>
      <Field label={t('merchantClaim.contest.urlLabel')}>
        <TextFieldInput
          label={t('merchantClaim.contest.urlLabel')}
          value={url}
          onValueChange={setUrl}
          placeholder={t('merchantClaim.evidence.urlPlaceholder')}
          keyboardType="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={2048}
        />
      </Field>
      {contest.isError ? <FailureText context="contest" error={contest.error} /> : null}
      <Button
        disabled={trimmed.length < CONTEST_REASON_MIN || contest.isPending}
        loading={contest.isPending}
        onPress={() =>
          contest.mutate({
            merchantId,
            reason: trimmed,
            ...(evidence.length > 0 ? { evidence } : {}),
          })
        }
      >
        {contest.isPending
          ? t('merchantClaim.contest.submitting')
          : t('merchantClaim.contest.submit')}
      </Button>
    </View>
  );
}
