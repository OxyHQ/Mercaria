import { Router } from 'express';
import { validateBody, validateId, validateQuery } from '../../middleware/validate.js';
import {
  createDataExportScheduleSchema,
  listDataExportRunsQuerySchema,
  requestDataExportSchema,
  updateDataExportScheduleSchema,
} from '../../middleware/data-export-schemas.js';
import {
  createScheduleHandler,
  deleteScheduleHandler,
  downloadRunHandler,
  listRunsHandler,
  listSchedulesHandler,
  requestExportHandler,
  updateScheduleHandler,
} from '../../controllers/admin/data-exports-admin.controller.js';

/**
 * Store data exports, mounted at `/admin/stores/:storeId/exports`
 * (`docs/data-exports.md`).
 *
 * The parent already ran `authenticateToken` → `loadStore`. Permission is per
 * DATASET and decided in the service, because one route serves three datasets
 * with three different read permissions.
 *
 * NOT flag-gated, and only two routes reach the plan: creating a schedule and
 * an edit that leaves one enabled (`scheduled_exports`). Exporting on demand,
 * reading schedules and runs, pausing, deleting and downloading never do —
 * `data_export` is ungateable.
 */
const router = Router({ mergeParams: true });

router.get('/schedules', listSchedulesHandler);
router.post('/schedules', validateBody(createDataExportScheduleSchema), createScheduleHandler);
router.patch(
  '/schedules/:scheduleId',
  validateId('scheduleId'),
  validateBody(updateDataExportScheduleSchema),
  updateScheduleHandler,
);
router.delete('/schedules/:scheduleId', validateId('scheduleId'), deleteScheduleHandler);

router.get('/runs', validateQuery(listDataExportRunsQuerySchema), listRunsHandler);
router.post('/runs', validateBody(requestDataExportSchema), requestExportHandler);
router.get('/runs/:runId/download', validateId('runId'), downloadRunHandler);

export default router;
