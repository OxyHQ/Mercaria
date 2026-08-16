import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type {
  ReferralPartnerDashboard,
  ReferralPartnerEarnings,
  ReferralPartnerPerformance,
  ReferralPerformanceDimension,
} from '@mercaria/shared-types';
import {
  createReferralCode,
  createReferralLink,
  fetchReferralDashboard,
  fetchReferralEarnings,
  fetchReferralInstruments,
  fetchReferralPerformance,
  retireReferralCode,
  revokeReferralLink,
  type CreateReferralCodeInput,
  type CreateReferralLinkInput,
  type ReferralInstruments,
} from '../api/referral-partner';
import { queryKeys } from './query-keys';

/**
 * The referral partner dashboard's data layer (#147).
 *
 * ## `canUsePrivateApi`, never `isAuthenticated`
 *
 * The house rule, and it matters more here than usual: this surface is entirely
 * about somebody's own money, so a query firing during cold-boot session
 * restore would 401 and paint an error over a dashboard that is about to work.
 *
 * ## A mutation invalidates the DASHBOARD, not just the section it touched
 *
 * Retiring a code changes the instrument list AND what the enrolment checklist
 * says AND, on the next sweep, what attributes. The dashboard is one composed
 * read for exactly that reason, so a write that invalidated only its own slice
 * would leave the rest of the page describing a state that no longer holds.
 */

const STALE_TIME = 1000 * 30;

function invalidatePartner(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.referralPartner.all });
}

export function useReferralDashboard() {
  const { canUsePrivateApi } = useOxy();
  return useQuery<ReferralPartnerDashboard>({
    queryKey: queryKeys.referralPartner.dashboard,
    enabled: canUsePrivateApi,
    staleTime: STALE_TIME,
    queryFn: fetchReferralDashboard,
  });
}

export function useReferralEarnings() {
  const { canUsePrivateApi } = useOxy();
  return useQuery<ReferralPartnerEarnings>({
    queryKey: queryKeys.referralPartner.earnings,
    enabled: canUsePrivateApi,
    staleTime: STALE_TIME,
    queryFn: fetchReferralEarnings,
  });
}

export function useReferralInstruments() {
  const { canUsePrivateApi } = useOxy();
  return useQuery<ReferralInstruments>({
    queryKey: queryKeys.referralPartner.instruments,
    enabled: canUsePrivateApi,
    staleTime: STALE_TIME,
    queryFn: () => fetchReferralInstruments(),
  });
}

/**
 * One breakdown.
 *
 * `enabled` additionally requires a window, so switching the dimension picker
 * before the dashboard has loaded does not fire a request for a range nobody
 * chose. The dashboard's own trailing-30-day breakdown is what paints first.
 */
export function useReferralPerformance(input: {
  dimension: ReferralPerformanceDimension;
  from: string | undefined;
  through: string | undefined;
}) {
  const { canUsePrivateApi } = useOxy();
  const ready = canUsePrivateApi && Boolean(input.from) && Boolean(input.through);
  return useQuery<ReferralPartnerPerformance>({
    queryKey: queryKeys.referralPartner.performance(
      input.dimension,
      input.from ?? '',
      input.through ?? '',
    ),
    enabled: ready,
    staleTime: STALE_TIME,
    queryFn: () =>
      fetchReferralPerformance({
        dimension: input.dimension,
        from: input.from as string,
        through: input.through as string,
      }),
  });
}

export function useCreateReferralCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReferralCodeInput) => createReferralCode(input),
    onSuccess: () => invalidatePartner(client),
  });
}

export function useCreateReferralLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReferralLinkInput) => createReferralLink(input),
    onSuccess: () => invalidatePartner(client),
  });
}

export function useRetireReferralCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { codeId: string; reason: string }) => retireReferralCode(input),
    onSuccess: () => invalidatePartner(client),
  });
}

export function useRevokeReferralLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { linkId: string; reason: string }) => revokeReferralLink(input),
    onSuccess: () => invalidatePartner(client),
  });
}
