import axios from "axios";

/** Only transient read failures may keep an already visible, store-scoped detail. */
export function canRetainDetailData(error: unknown): boolean {
  if (!error) return true;
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status === 408 || status === 429 || status >= 500;
}
