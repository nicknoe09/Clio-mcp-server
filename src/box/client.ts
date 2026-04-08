import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from "axios";
import FormData from "form-data";
import { getBoxAccessToken } from "../utils/tokenStore";
import { refreshBoxAccessToken } from "./auth";

const BOX_UPLOAD_BASE = "https://upload.box.com/api/2.0";

export interface BoxFileMetadata {
  id: string;
  name: string;
  size: number;
  sha1: string;
  parent?: { id: string; name: string };
}

function createUploadClient(userEmail: string): AxiosInstance {
  const client = axios.create({
    baseURL: BOX_UPLOAD_BASE,
    timeout: 300000, // 5 min for large uploads
  });

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
      if (error.response?.status === 401 && !originalRequest._retry) {
        originalRequest._retry = true;
        const newToken = await refreshBoxAccessToken(userEmail);
        originalRequest.headers = {
          ...originalRequest.headers,
          Authorization: `Bearer ${newToken}`,
        };
        return client(originalRequest);
      }
      if (error.response?.status === 429) {
        const retryAfter = parseInt(error.response.headers["retry-after"] ?? "5", 10);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return client(originalRequest);
      }
      throw error;
    }
  );

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
