import type {
  ApiResponse,
  CreateDataExportScheduleInput,
  DataExportDataset,
  DataExportDownloadView,
  DataExportRunView,
  DataExportScheduleView,
  UpdateDataExportScheduleInput,
} from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';

const base = (storeId: string) => `/admin/stores/${storeId}/exports`;

/** The store's export schedules the caller may read. Never gated by the plan. */
export async function fetchDataExportSchedules(storeId: string): Promise<DataExportScheduleView[]> {
  const { data } = await apiClient.get<ApiResponse<DataExportScheduleView[]>>(
    `${base(storeId)}/schedules`,
  );
  return unwrap(data);
}

/** Create a schedule — the server refuses it when the plan lacks the tool. */
export async function createDataExportSchedule(
  storeId: string,
  input: CreateDataExportScheduleInput,
): Promise<DataExportScheduleView> {
  const { data } = await apiClient.post<ApiResponse<DataExportScheduleView>>(
    `${base(storeId)}/schedules`,
    input,
  );
  return unwrap(data);
}

export async function updateDataExportSchedule(
  storeId: string,
  scheduleId: string,
  patch: UpdateDataExportScheduleInput,
): Promise<DataExportScheduleView> {
  const { data } = await apiClient.patch<ApiResponse<DataExportScheduleView>>(
    `${base(storeId)}/schedules/${scheduleId}`,
    patch,
  );
  return unwrap(data);
}

export async function deleteDataExportSchedule(storeId: string, scheduleId: string): Promise<void> {
  await apiClient.delete(`${base(storeId)}/schedules/${scheduleId}`);
}

/** Export history, on demand and scheduled. */
export async function fetchDataExportRuns(
  storeId: string,
  filter: { scheduleId?: string; dataset?: DataExportDataset } = {},
): Promise<DataExportRunView[]> {
  const { data } = await apiClient.get<ApiResponse<DataExportRunView[]>>(`${base(storeId)}/runs`, {
    params: filter,
  });
  return unwrap(data);
}

/** Export a dataset now — free, whatever the plan. */
export async function requestDataExport(
  storeId: string,
  dataset: DataExportDataset,
): Promise<DataExportRunView> {
  const { data } = await apiClient.post<ApiResponse<DataExportRunView>>(`${base(storeId)}/runs`, {
    dataset,
  });
  return unwrap(data);
}

/**
 * A short-lived link to one export's file. Never cached: the URL is a
 * credential, opened at once and dropped.
 */
export async function fetchDataExportDownload(
  storeId: string,
  runId: string,
): Promise<DataExportDownloadView> {
  const { data } = await apiClient.get<ApiResponse<DataExportDownloadView>>(
    `${base(storeId)}/runs/${runId}/download`,
  );
  return unwrap(data);
}
