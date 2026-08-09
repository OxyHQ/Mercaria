/**
 * Supplier platform accounts: the thing an adapter (#124) authenticates as.
 *
 * `credential_reference` is a PROTECTED column, so every ordinary read here
 * excludes it via `publicColumns` — and the one function that returns it,
 * `readCredentialReference`, is the explicit greppable opt-in for the
 * adapter's credential resolver and nothing else. It returns the secret-store
 * PATH; resolving the path into a secret happens in the adapter, against SSM,
 * never here.
 */

import { and, eq } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  SupplierAccountEnvironment,
  SupplierAccountState,
  SupplierApiCapability,
  SupplierCredentialStatus,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { supplierAccounts } from '../schema/procurement.js';

/** Every account column EXCEPT the protected credential reference. */
const ACCOUNT_COLUMNS = publicColumns(supplierAccounts, PROTECTED_COLUMNS);

/** An account row as every ordinary caller sees it — no credential reference. */
export type SupplierAccountRecord = SelectedRow<typeof ACCOUNT_COLUMNS>;

/** What `createSupplierAccount` needs. */
export interface NewSupplierAccount {
  supplierId: string;
  provider: string;
  environment: SupplierAccountEnvironment;
  providerAccountId: string;
  /** A secret-store PATH (`/oxy/mercaria/suppliers/…`) — never a secret value. */
  credentialReference?: string;
  billingReference?: string;
  enabledMarkets?: string[];
  fulfilmentOrigins?: string[];
  apiCapabilities?: SupplierApiCapability[];
  rateLimitPerMinute?: number;
  dailyOrderQuota?: number;
}

/** Create one account. The provider+environment+account uniqueness is the gate. */
export async function createSupplierAccount(
  input: NewSupplierAccount,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAccountRecord> {
  const [row] = await db
    .insert(supplierAccounts)
    .values({
      supplierId: input.supplierId,
      provider: input.provider,
      environment: input.environment,
      providerAccountId: input.providerAccountId,
      credentialReference: input.credentialReference ?? null,
      billingReference: input.billingReference ?? null,
      enabledMarkets: input.enabledMarkets ?? [],
      fulfilmentOrigins: input.fulfilmentOrigins ?? [],
      apiCapabilities: input.apiCapabilities ?? [],
      credentialStatus: input.credentialReference ? 'valid' : 'unconfigured',
      rateLimitPerMinute: input.rateLimitPerMinute ?? null,
      dailyOrderQuota: input.dailyOrderQuota ?? null,
    })
    .returning(ACCOUNT_COLUMNS);
  if (!row) throw new Error('createSupplierAccount inserted no row');
  return row;
}

/** One account, or `undefined`. */
export async function findSupplierAccountById(
  accountId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAccountRecord | undefined> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(supplierAccounts)
    .where(eq(supplierAccounts.id, accountId))
    .limit(1);
  return row;
}

/** "Which Mercaria account is this platform account?" — #118 indexes 1. */
export async function findSupplierAccountByProviderAccount(
  input: { provider: string; environment: SupplierAccountEnvironment; providerAccountId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAccountRecord | undefined> {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(supplierAccounts)
    .where(
      and(
        eq(supplierAccounts.provider, input.provider),
        eq(supplierAccounts.environment, input.environment),
        eq(supplierAccounts.providerAccountId, input.providerAccountId),
      ),
    )
    .limit(1);
  return row;
}

/** A supplier's accounts. */
export async function listSupplierAccounts(
  supplierId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAccountRecord[]> {
  return await db
    .select(ACCOUNT_COLUMNS)
    .from(supplierAccounts)
    .where(eq(supplierAccounts.supplierId, supplierId))
    .orderBy(supplierAccounts.createdAt);
}

/**
 * The secret-store PATH for one account — the explicit, greppable opt-in.
 * Adapter credential resolution only; nothing else may call this.
 */
export async function readCredentialReference(
  accountId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string | null | undefined> {
  const [row] = await db
    .select({ credentialReference: supplierAccounts.credentialReference })
    .from(supplierAccounts)
    .where(eq(supplierAccounts.id, accountId))
    .limit(1);
  return row ? row.credentialReference : undefined;
}

/** Point the account at a (new) secret-store path and state its status. */
export async function setAccountCredential(
  input: { accountId: string; credentialReference: string; status: SupplierCredentialStatus },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAccountRecord | undefined> {
  const [row] = await db
    .update(supplierAccounts)
    .set({ credentialReference: input.credentialReference, credentialStatus: input.status })
    .where(eq(supplierAccounts.id, input.accountId))
    .returning(ACCOUNT_COLUMNS);
  return row;
}

/** Record one health check — the freshest fact an operator dashboard shows. */
export async function recordAccountHealthCheck(
  input: { accountId: string; ok: boolean; credentialStatus?: SupplierCredentialStatus; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAccountRecord | undefined> {
  const [row] = await db
    .update(supplierAccounts)
    .set({
      lastHealthCheckAt: input.at ?? new Date(),
      lastHealthCheckOk: input.ok,
      ...(input.credentialStatus ? { credentialStatus: input.credentialStatus } : {}),
    })
    .where(eq(supplierAccounts.id, input.accountId))
    .returning(ACCOUNT_COLUMNS);
  return row;
}

/**
 * Move the account's activation / kill-switch state — a CAS on the current
 * state, one statement. Killing REQUIRES a reason (the CHECK would refuse the
 * row without one); reviving clears the kill columns together.
 */
export async function transitionAccountState(
  input: {
    accountId: string;
    expected: SupplierAccountState;
    next: SupplierAccountState;
    killSwitchReason?: string;
    at?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<SupplierAccountRecord | undefined> {
  const at = input.at ?? new Date();
  if (input.next === 'killed' && !input.killSwitchReason) {
    throw new Error('transitionAccountState: killing an account requires a reason');
  }
  const [row] = await db
    .update(supplierAccounts)
    .set({
      state: input.next,
      ...(input.next === 'killed'
        ? { killSwitchedAt: at, killSwitchReason: input.killSwitchReason }
        : { killSwitchedAt: null, killSwitchReason: null }),
      ...(input.next === 'active' ? { activatedAt: at } : {}),
      updatedAt: at,
    })
    .where(and(eq(supplierAccounts.id, input.accountId), eq(supplierAccounts.state, input.expected)))
    .returning(ACCOUNT_COLUMNS);
  return row;
}
