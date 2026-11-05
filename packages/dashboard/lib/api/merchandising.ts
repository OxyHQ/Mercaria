import type {
  ApiResponse,
  CreateMerchandisingRuleInput,
  MerchandisingPreview,
  MerchandisingPreviewInput,
  MerchandisingRule,
  UpdateMerchandisingRuleInput,
} from '@mercaria/shared-types';
import apiClient from './client';
import { unwrap } from './unwrap';

/** The paid store-page merchandising rules (`advanced_merchandising_rules`). */
const base = (storeId: string) => `/admin/stores/${storeId}/merchandising`;

/** Every rule of the store — readable whatever the plan says. */
export async function fetchMerchandisingRules(storeId: string): Promise<MerchandisingRule[]> {
  const { data } = await apiClient.get<ApiResponse<MerchandisingRule[]>>(`${base(storeId)}/rules`);
  return unwrap(data);
}

export async function fetchMerchandisingRule(
  storeId: string,
  id: string,
): Promise<MerchandisingRule> {
  const { data } = await apiClient.get<ApiResponse<MerchandisingRule>>(
    `${base(storeId)}/rules/${id}`,
  );
  return unwrap(data);
}

/** POST a rule; takes one unit of the plan's allowance. */
export async function createMerchandisingRule(
  storeId: string,
  input: CreateMerchandisingRuleInput,
): Promise<MerchandisingRule> {
  const { data } = await apiClient.post<ApiResponse<MerchandisingRule>>(
    `${base(storeId)}/rules`,
    input,
  );
  return unwrap(data);
}

export async function updateMerchandisingRule(
  storeId: string,
  id: string,
  input: UpdateMerchandisingRuleInput,
): Promise<MerchandisingRule> {
  const { data } = await apiClient.patch<ApiResponse<MerchandisingRule>>(
    `${base(storeId)}/rules/${id}`,
    input,
  );
  return unwrap(data);
}

/** DELETE a rule; gives its unit back. Never refused by the plan. */
export async function deleteMerchandisingRule(storeId: string, id: string): Promise<void> {
  await apiClient.delete(`${base(storeId)}/rules/${id}`);
}

/** The order a draft sort rule would produce, before it is saved. */
export async function previewMerchandising(
  storeId: string,
  input: MerchandisingPreviewInput,
): Promise<MerchandisingPreview> {
  const { data } = await apiClient.post<ApiResponse<MerchandisingPreview>>(
    `${base(storeId)}/preview`,
    input,
  );
  return unwrap(data);
}
