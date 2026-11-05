import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  ConversionReportExport,
  ConversionReportInterval,
  ConversionReportWindow,
  ConversionTrendReport,
  ListingConversionReport,
} from '@mercaria/shared-types';
import {
  fetchConversionCsv,
  fetchConversionTrend,
  fetchListingConversion,
} from '../api/conversion-report';
import { saveTextFile } from '../save-text-file';
import { queryKeys } from '../queryKeys';

/** The per-listing conversion report. Only mounted behind `PlanToolGate`. */
export function useListingConversion(storeId: string, window: ConversionReportWindow) {
  return useQuery<ListingConversionReport>({
    queryKey: queryKeys.conversionReport.listings(storeId, window.from, window.to),
    queryFn: () => fetchListingConversion(storeId, window),
    enabled: Boolean(storeId),
  });
}

/** The conversion trend and period comparison. */
export function useConversionTrend(
  storeId: string,
  window: ConversionReportWindow,
  interval: ConversionReportInterval,
) {
  return useQuery<ConversionTrendReport>({
    queryKey: queryKeys.conversionReport.trend(storeId, window.from, window.to, interval),
    queryFn: () => fetchConversionTrend(storeId, window, interval),
    enabled: Boolean(storeId),
  });
}

/** Download one report as CSV (a file on web, the share sheet on a device). */
export function useExportConversionReport(storeId: string) {
  return useMutation({
    mutationFn: async (input: {
      report: ConversionReportExport;
      window: ConversionReportWindow;
      interval: ConversionReportInterval;
    }) => {
      const csv = await fetchConversionCsv(storeId, input.report, input.window, input.interval);
      await saveTextFile(
        `conversion-${input.report}-${input.window.from}-${input.window.to}.csv`,
        csv,
        'text/csv',
      );
    },
  });
}
