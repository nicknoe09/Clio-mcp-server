import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from "axios";
import FormData from "form-data";
import { getBoxAccessToken } from "../utils/tokenStore";
import { refreshBoxAccessToken } from "./auth";

const BOX_API_BASE = "https://api.box.com/2.0";
const BOX_UPLOAD_BASE = "https://upload.box.com/api/2.0";

export interface BoxFileMetadata {
  id: string;
  name: string;
  size: number;
  sha1: string;
  parent?: { id: string; name: string };
}

function attachInterceptors(client: AxiosInstance, userEmail: string): void {
  client.interceptors.request.use((config) => {
    const token = getBoxAccessToken(userEmail);
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean };
      const status = error.response?.status;
      const method = (error.config?.method || "?").toUpperCase();
      const url = error.config?.url || "?";

      if (status === 401 && !originalRequest._retry) {
        originalRequest._retry = true;
        console.log(`[Box] 401 — refreshing access token for ${userEmail} (${method} ${url})`);
        try {
          const newToken = await refreshBoxAccessToken(userEmail);
          originalRequest.headers = {
            ...originalRequest.headers,
            Authorization: `Bearer ${newToken}`,
          };
          return client(originalRequest);
        } catch (refreshErr: any) {
          console.error(
            `[Box] token refresh FAILED for ${userEmail}: ${refreshErr?.message ?? "unknown"}`,
          );
          throw error;
        }
      }
      if (status === 429) {
        const retryAfter = parseInt(error.response?.headers["retry-after"] ?? "5", 10);
        console.warn(`[Box] 429 rate-limited ${method} ${url} — retrying after ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return client(originalRequest);
      }

      // Log Box's error body on other 4xx/5xx so upstream callers can see
      // the actual cause rather than just an opaque axios error.
      if (status && status >= 400) {
        const body = error.response?.data;
        let bodyStr: string;
        if (body === null || body === undefined) {
          bodyStr = "<empty>";
        } else if (typeof body === "string") {
          bodyStr = body;
        } else if (Buffer.isBuffer(body)) {
          bodyStr = "<binary>";
        } else {
          try { bodyStr = JSON.stringify(body); } catch { bodyStr = "<unserializable>"; }
        }
        console.error(
          `[Box] HTTP ${status} ${method} ${url} — body=${bodyStr.slice(0, 500)}`,
        );
      }
      throw error;
    }
  );
}

function createUploadClient(userEmail: string): AxiosInstance {
  const client = axios.create({
    baseURL: BOX_UPLOAD_BASE,
    timeout: 300000,
  });
  attachInterceptors(client, userEmail);
  return client;
}

function createApiClient(userEmail: string): AxiosInstance {
  const client = axios.create({
    baseURL: BOX_API_BASE,
    timeout: 300000,
  });
  attachInterceptors(client, userEmail);
  return client;
}

export async function boxUploadFile(
  fileBuffer: Buffer,
  fileName: string,
  parentFolderId: string,
  userEmail: string
): Promise<BoxFileMetadata> {
  const form = new FormData();
  form.append("attributes", JSON.stringify({
    name: fileName,
    parent: { id: parentFolderId },
  }));
  form.append("file", fileBuffer, { filename: fileName });

  const client = createUploadClient(userEmail);
  const response = await client.post("/files/content", form, {
    headers: form.getHeaders(),
  });

  return response.data.entries[0];
}

export async function boxUploadNewVersion(
  fileBuffer: Buffer,
  fileName: string,
  fileId: string,
  userEmail: string
): Promise<BoxFileMetadata> {
  const form = new FormData();
  form.append("attributes", JSON.stringify({ name: fileName }));
  form.append("file", fileBuffer, { filename: fileName });

  const client = createUploadClient(userEmail);
  const response = await client.post(`/files/${fileId}/content`, form, {
    headers: form.getHeaders(),
  });

  return response.data.entries[0];
}

export async function boxDownloadFile(
  fileId: string,
  userEmail: string
): Promise<Buffer> {
  const client = createApiClient(userEmail);
  const response = await client.get(`/files/${fileId}/content`, {
    responseType: "arraybuffer",
  });
  return Buffer.from(response.data);
}

/**
 * Permanently delete a file by ID. Used to clean up orphan uploads when
 * boxUploadFile unexpectedly creates a new file (instead of hitting the
 * expected 409 conflict we use as a lookup mechanism).
 */
export async function boxDeleteFile(
  fileId: string,
  userEmail: string,
): Promise<void> {
  const client = createApiClient(userEmail);
  await client.delete(`/files/${fileId}`);
}
