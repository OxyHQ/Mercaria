import axios from "axios";
import config from "../config";

/**
 * Shared axios instance for the Mercaria backend API.
 *
 * The bearer token getter is injected by `AuthSetup` (which reads the live Oxy
 * access token from the SDK). Every admin request is authenticated with that
 * bearer token — the dashboard never plumbs `Authorization` manually elsewhere.
 */
const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
  },
});

let getAccessToken: (() => string | null) | null = null;

/** Wire the live Oxy access-token getter (called once from `AuthSetup`). */
export function setTokenGetter(getter: () => string | null) {
  getAccessToken = getter;
}

apiClient.interceptors.request.use(
  (request) => {
    if (getAccessToken) {
      const token = getAccessToken();
      if (token) {
        request.headers["Authorization"] = `Bearer ${token}`;
      }
    }
    return request;
  },
  (error) => Promise.reject(error),
);

apiClient.interceptors.response.use(
  (response) => response,
  (error) => Promise.reject(error),
);

export default apiClient;
