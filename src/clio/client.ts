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

  // Request interceptor: attach current access token
  clioClient.interceptors.request.use((config) => {
    const token = getAccessToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
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
