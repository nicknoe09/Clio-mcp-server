import axios, { AxiosInstance } from "axios";
import { ENV } from "../utils/env";
import { getAccessToken } from "../utils/tokenStore";
import { refreshAccessToken } from "./auth";

let clioClient: AxiosInstance;

export function getClioClient(): AxiosInstance {
  if (clioClient) return clioClient;

  clioClient = axios.create({
    baseURL: ENV.CLIO_API_BASE_URL,
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
    },
  });

  // Request interceptor: attach token AND manually serialize params to prevent
  // axios from mangling Clio field syntax like matter{id,name}
  clioClient.interceptors.request.use((config) => {
    const token = getAccessToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // Bypass axios param serialization entirely — build query string ourselves
    if (config.params && Object.keys(config.params).length > 0) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(config.params)) {
        if (value === undefined || value === null) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))
          .replace(/%7B/gi, "{")
          .replace(/%7D/gi, "}")
          .replace(/%2C/gi, ",")}`);
      }
      const qs = parts.join("&");
      const separator = (config.url || "").includes("?") ? "&" : "?";
      config.url = `${config.url}${separator}${qs}`;
      config.params = {};  // Clear params so axios doesn't re-serialize
    }

    return config;
  });

  // Response interceptor: auto-refresh on 401
  clioClient.interceptors.response.use(
    (res) => res,
    async (error) => {
      if (error.response?.status === 401 && !error.config._retry) {
        error.config._retry = true;
        try {
          await refreshAccessToken();
          error.config.headers.Authorization = `Bearer ${getAccessToken()}`;
          return clioClient(error.config);
        } catch (refreshErr) {
          return Promise.reject(refreshErr);
        }
      }
      return Promise.reject(error);
    }
  );

  return clioClient;
}
