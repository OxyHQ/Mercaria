/**
 * Store data exports controller (THIN) — `routes/admin/data-exports.ts`.
 *
 * Every handler passes the caller's resolved store permissions to the service,
 * which decides per DATASET (`DATA_EXPORT_DATASET_PERMISSIONS`): exporting,
 * scheduling and downloading orders needs `orders:read`, products
 * `products:read`, customers `customers:read` — the permission reading the same
 * data on the dashboard already requires.
 */

import type { Request, Response } from 'express';
import type {
  CreateDataExportScheduleInput,
  DataExportDataset,
  StorePermission,
  UpdateDataExportScheduleInput,
} from '@mercaria/shared-types';
import { sendSuccess } from '../../utils/api-response.js';
import { notFound, respondWithError } from '../../lib/errors/error-codes.js';
import { routeParam } from '../../utils/request.js';
import { log } from '../../lib/logger.js';
import {
  createDataExportSchedule,
  dataExportDownload,
  deleteDataExportScheduleForCaller,
  listDataExportRunsForCaller,
  listDataExportSchedulesForCaller,
  requestOnDemandDataExport,
  updateDataExportScheduleForCaller,
} from '../../services/data-exports/data-export.service.js';

function caller(req: Request): {
  storeId: string;
  oxyUserId: string;
  permissions: readonly StorePermission[];
} {
  const store = req.store;
  const access = req.storeAccess;
  if (!store || !access || !req.userId) throw notFound('Store not loaded');
  return { storeId: store.id, oxyUserId: req.userId, permissions: access.permissions };
}

/** GET …/exports/schedules — never gated by the plan. */
export async function listSchedulesHandler(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, permissions } = caller(req);
    sendSuccess(res, await listDataExportSchedulesForCaller(storeId, permissions));
  } catch (err) {
    log.general.error({ err }, 'Failed to list export schedules');
    respondWithError(res, err, 'Failed to load export schedules');
  }
}

/** POST …/exports/schedules — requires the `scheduled_exports` tool. */
export async function createScheduleHandler(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, oxyUserId, permissions } = caller(req);
    const schedule = await createDataExportSchedule(
      storeId,
      { oxyUserId, permissions },
      req.body as CreateDataExportScheduleInput,
    );
    sendSuccess(res, schedule, 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to create the export schedule');
  }
}

/** PATCH …/exports/schedules/:scheduleId — pausing is never gated. */
export async function updateScheduleHandler(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, oxyUserId, permissions } = caller(req);
    const schedule = await updateDataExportScheduleForCaller(
      storeId,
      routeParam(req, 'scheduleId'),
      { oxyUserId, permissions },
      req.body as UpdateDataExportScheduleInput,
    );
    sendSuccess(res, schedule);
  } catch (err) {
    respondWithError(res, err, 'Failed to update the export schedule');
  }
}

/** DELETE …/exports/schedules/:scheduleId — never gated; the runs stay. */
export async function deleteScheduleHandler(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, permissions } = caller(req);
    await deleteDataExportScheduleForCaller(storeId, routeParam(req, 'scheduleId'), permissions);
    sendSuccess(res, { deleted: true });
  } catch (err) {
    respondWithError(res, err, 'Failed to delete the export schedule');
  }
}

/** GET …/exports/runs — the history, on demand and scheduled. Never gated. */
export async function listRunsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, permissions } = caller(req);
    const query = req.query as { dataset?: DataExportDataset; scheduleId?: string };
    sendSuccess(
      res,
      await listDataExportRunsForCaller(storeId, permissions, {
        ...(query.dataset ? { dataset: query.dataset } : {}),
        ...(query.scheduleId ? { scheduleId: query.scheduleId } : {}),
      }),
    );
  } catch (err) {
    log.general.error({ err }, 'Failed to list export runs');
    respondWithError(res, err, 'Failed to load exports');
  }
}

/** POST …/exports/runs — export a dataset now. Free; never reads the plan. */
export async function requestExportHandler(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, oxyUserId, permissions } = caller(req);
    const { dataset } = req.body as { dataset: DataExportDataset };
    sendSuccess(
      res,
      await requestOnDemandDataExport(storeId, { oxyUserId, permissions }, dataset),
      202,
    );
  } catch (err) {
    respondWithError(res, err, 'Failed to start the export');
  }
}

/** GET …/exports/runs/:runId/download — a short-lived URL. Never gated. */
export async function downloadRunHandler(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, permissions } = caller(req);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, await dataExportDownload(storeId, routeParam(req, 'runId'), permissions));
  } catch (err) {
    respondWithError(res, err, 'Failed to open the export file');
  }
}
