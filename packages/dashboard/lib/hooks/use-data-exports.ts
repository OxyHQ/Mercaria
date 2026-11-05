import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDataExportScheduleInput,
  DataExportDataset,
  DataExportRunView,
  DataExportScheduleView,
  UpdateDataExportScheduleInput,
} from '@mercaria/shared-types';
import {
  createDataExportSchedule,
  deleteDataExportSchedule,
  fetchDataExportDownload,
  fetchDataExportRuns,
  fetchDataExportSchedules,
  requestDataExport,
  updateDataExportSchedule,
} from '../api/data-exports';
import { queryKeys } from '../queryKeys';

/** While any run is queued or running, poll so the row turns downloadable on its own. */
const POLL_WHILE_OPEN_MS = 4_000;

export function useDataExportSchedules(storeId: string) {
  return useQuery<DataExportScheduleView[]>({
    queryKey: queryKeys.dataExports.schedules(storeId),
    queryFn: () => fetchDataExportSchedules(storeId),
    enabled: Boolean(storeId),
  });
}

/** Export history. `scheduledOnly` keeps the runs a schedule produced. */
export function useDataExportRuns(storeId: string) {
  return useQuery<DataExportRunView[]>({
    queryKey: queryKeys.dataExports.runs(storeId),
    queryFn: () => fetchDataExportRuns(storeId),
    enabled: Boolean(storeId),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'pending' || run.status === 'running')
        ? POLL_WHILE_OPEN_MS
        : false,
  });
}

function useInvalidateExports(storeId: string) {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: queryKeys.dataExports.all(storeId) });
    // A schedule change can move the "runs used" figure the gate shows.
    void client.invalidateQueries({ queryKey: queryKeys.storeCapabilities(storeId) });
  };
}

export function useCreateDataExportSchedule(storeId: string) {
  const invalidate = useInvalidateExports(storeId);
  return useMutation({
    mutationFn: (input: CreateDataExportScheduleInput) => createDataExportSchedule(storeId, input),
    onSuccess: invalidate,
  });
}

export function useUpdateDataExportSchedule(storeId: string) {
  const invalidate = useInvalidateExports(storeId);
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateDataExportScheduleInput }) =>
      updateDataExportSchedule(storeId, id, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteDataExportSchedule(storeId: string) {
  const invalidate = useInvalidateExports(storeId);
  return useMutation({
    mutationFn: (scheduleId: string) => deleteDataExportSchedule(storeId, scheduleId),
    onSuccess: invalidate,
  });
}

/** Export a dataset now. Free; the server never asks the plan. */
export function useRequestDataExport(storeId: string) {
  const invalidate = useInvalidateExports(storeId);
  return useMutation({
    mutationFn: (dataset: DataExportDataset) => requestDataExport(storeId, dataset),
    onSuccess: invalidate,
  });
}

/** Resolve a download link at the moment of the tap; nothing is cached. */
export function useDataExportDownload(storeId: string) {
  return useMutation({
    mutationFn: (runId: string) => fetchDataExportDownload(storeId, runId),
  });
}
