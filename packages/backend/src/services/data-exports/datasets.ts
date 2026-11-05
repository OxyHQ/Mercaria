/**
 * What an export CONTAINS: one reader and one column list per dataset, shared
 * by the free on-demand export and the paid schedule, so a scheduled file is
 * byte-for-byte the file an on-demand export of the same moment would be.
 *
 * Each reader pages through the SAME service call the dashboard's list screen
 * makes (`getStoreOrders`, `findStoreListingsPageForAdmin` + `hydrateListings`,
 * `listCustomers` + `toCustomerDTO`), so an export carries exactly what the
 * merchant already reads about their own store — the merchant projection of an
 * order (never the buyer's account email), the admin listing DTO, the customer
 * DTO — and nothing a list screen does not.
 *
 * Every text cell is guarded against spreadsheet formula injection: a buyer's
 * display name or a product title is somebody else's text, and a merchant opens
 * this file in a spreadsheet.
 */

import {
  CURRENCY_PRECISION,
  DATA_EXPORT_MAX_ROWS,
  type CurrencyCode,
  type DataExportDataset,
  type Money,
} from '@mercaria/shared-types';
import { getStoreOrders } from '../order.service.js';
import { findStoreListingsPageForAdmin } from '../../db/catalog/listingRepository.js';
import { hydrateListings } from '../catalog-hydration.service.js';
import { listCustomers, toCustomerDTO } from '../customer.service.js';

/** One page per round trip; each page renews the run's lease. */
const PAGE_SIZE = 100;

/** A decimal amount, written bare and never through a float. */
interface DecimalCell {
  readonly decimal: string;
}

/** A cell: text is quoted and guarded; a number, a decimal or empty is written bare. */
type Cell = string | number | boolean | DecimalCell | null | undefined;

/**
 * One CSV cell. Text is always quoted; a leading `=`, `+`, `-`, `@`, tab or
 * carriage return is prefixed with an apostrophe so a spreadsheet reads it as
 * text, never as a formula. Numbers are written bare — a negative amount is a
 * number, not an injection.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return value.decimal;
  const guarded = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/gu, '""')}"`;
}

function csvLine(cells: readonly Cell[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** Minor units as a plain decimal in the currency's own precision: `1999` USD → `19.99`. */
export function decimalAmount(money: Money | undefined): string | undefined {
  if (!money) return undefined;
  const precision = CURRENCY_PRECISION[money.currency as CurrencyCode] ?? 2;
  const negative = money.amount < 0;
  const digits = String(Math.abs(Math.trunc(money.amount))).padStart(precision + 1, '0');
  const whole = precision === 0 ? digits : digits.slice(0, -precision);
  const fraction = precision === 0 ? '' : `.${digits.slice(-precision)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * A decimal amount is written BARE (it is a number to a spreadsheet), but it is
 * produced as a string so FAIR's eight decimals never pass through a float.
 */
function amountCell(money: Money | undefined): Cell {
  const decimal = decimalAmount(money);
  return decimal === undefined ? undefined : { decimal };
}

/** What one export produced, before it is stored. */
export interface DataExportFile {
  readonly body: string;
  readonly rowCount: number;
  readonly byteSize: number;
  readonly truncated: boolean;
}

/** Called after every page; `false` (the lease was lost) stops the read. */
export type PageCheckpoint = () => Promise<boolean>;

/** The read stopped because the worker no longer holds the run. */
export class DataExportLeaseLost extends Error {
  constructor() {
    super('The export run lease was lost mid-read.');
    this.name = 'DataExportLeaseLost';
  }
}

interface DatasetDefinition {
  readonly header: readonly string[];
  /** One page of rows, newest first; `total` is the dataset's size at that read. */
  readonly page: (storeId: string, page: number) => Promise<{ rows: Cell[][]; total: number }>;
}

/**
 * The columns, in order. Appending a column is a change a merchant's import
 * script survives; renaming or reordering one is not — so never do either.
 */
export const DATA_EXPORT_DEFINITIONS: Readonly<Record<DataExportDataset, DatasetDefinition>> = {
  orders: {
    header: [
      'order_number',
      'order_id',
      'created_at',
      'status',
      'item_count',
      'buyer',
      'buyer_oxy_user_id',
      'total',
      'currency',
      'presentment_total',
      'presentment_currency',
    ],
    page: async (storeId, page) => {
      const { data, total } = await getStoreOrders(storeId, { page, limit: PAGE_SIZE });
      return {
        total,
        rows: data.map((order) => [
          order.orderNumber,
          order.id,
          order.createdAt,
          order.status,
          order.itemCount,
          order.buyer.displayLabel,
          order.buyer.oxyUserId,
          amountCell(order.grandTotal.shop),
          order.grandTotal.shop.currency,
          amountCell(order.grandTotal.presentment),
          order.grandTotal.presentment.currency,
        ]),
      };
    },
  },
  products: {
    header: [
      'product_id',
      'title',
      'handle',
      'status',
      'vendor',
      'product_type',
      'tags',
      'variant_id',
      'variant_title',
      'sku',
      'barcode',
      'price',
      'compare_at_price',
      'currency',
      'available',
      'created_at',
      'updated_at',
    ],
    page: async (storeId, page) => {
      const { rows, total } = await findStoreListingsPageForAdmin(storeId, {}, page, PAGE_SIZE);
      const listings = await hydrateListings(rows, { includeSource: true });
      return {
        total,
        rows: listings.flatMap((listing) =>
          (listing.variants.length > 0 ? listing.variants : [undefined]).map((variant) => [
            listing.id,
            listing.title,
            listing.handle,
            listing.status,
            listing.vendor,
            listing.productType,
            listing.tags.join(', '),
            variant?.id,
            variant?.title,
            variant?.sku,
            variant?.barcode,
            amountCell(variant?.price ?? listing.price),
            amountCell(variant ? variant.compareAtPrice : listing.compareAtPrice),
            (variant?.price ?? listing.price).currency,
            variant ? variant.available : listing.quantity,
            listing.createdAt,
            listing.updatedAt,
          ]),
        ),
      };
    },
  },
  customers: {
    header: [
      'customer_id',
      'display_name',
      'email',
      'phone',
      'walk_in',
      'tags',
      'order_count',
      'total_spent',
      'currency',
      'last_order_at',
      'created_at',
    ],
    page: async (storeId, page) => {
      const { data, total } = await listCustomers(storeId, { page, limit: PAGE_SIZE });
      return {
        total,
        rows: data
          .map(toCustomerDTO)
          .map((customer) => [
            customer.id,
            customer.displayName,
            customer.email,
            customer.phone,
            customer.isWalkIn,
            customer.tags.join(', '),
            customer.stats.orderCount,
            amountCell(customer.stats.totalSpent),
            customer.stats.totalSpent.currency,
            customer.stats.lastOrderAt,
            customer.createdAt,
          ]),
      };
    },
  },
};

/** Primary-key column per dataset: a page that shifted under the read repeats a row, never drops one. */
const KEY_COLUMN = 0;
const PRODUCT_VARIANT_COLUMN = 7;

/**
 * Read a whole dataset into one CSV, newest first, at most
 * {@link DATA_EXPORT_MAX_ROWS} rows.
 *
 * Offset pages over a newest-first list: an order placed mid-read shifts every
 * later page by one, which repeats a row and never skips one (orders, products
 * and customers are not hard-deleted from under a merchant). The repeat is
 * dropped by key, so the file holds each row once.
 */
export async function buildDataExportFile(
  storeId: string,
  dataset: DataExportDataset,
  checkpoint: PageCheckpoint,
  options: { maxRows?: number } = {},
): Promise<DataExportFile> {
  const definition = DATA_EXPORT_DEFINITIONS[dataset];
  const maxRows = options.maxRows ?? DATA_EXPORT_MAX_ROWS;
  const lines: string[] = [csvLine(definition.header)];
  const seen = new Set<string>();
  let rowCount = 0;
  let truncated = false;

  for (let page = 1; ; page += 1) {
    const { rows, total } = await definition.page(storeId, page);
    for (const row of rows) {
      const key =
        dataset === 'products'
          ? `${String(row[KEY_COLUMN])}:${String(row[PRODUCT_VARIANT_COLUMN] ?? '')}`
          : String(row[KEY_COLUMN]);
      if (seen.has(key)) continue;
      if (rowCount >= maxRows) {
        truncated = true;
        break;
      }
      seen.add(key);
      lines.push(csvLine(row));
      rowCount += 1;
    }
    if (truncated || rows.length === 0 || page * PAGE_SIZE >= total) break;
    if (!(await checkpoint())) throw new DataExportLeaseLost();
  }

  const body = lines.join('');
  return { body, rowCount, byteSize: Buffer.byteLength(body, 'utf8'), truncated };
}
