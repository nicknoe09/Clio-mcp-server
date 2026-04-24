import crypto from "crypto";
import { ENV } from "./env";

// In-memory, token-addressed store for outbound file downloads.
//
// Why it exists: Box uploads require an existing file ID to version against.
// When we don't have one (or the version call fails), we can't push the file
// to Box, but we also don't want to inline the bytes into the MCP response as
// base64 — that causes multi-minute streaming lag on the client. Instead we
// park the buffer here and hand the caller a short-lived download URL served
// by this same process (see GET /download/:token in index.ts).

interface StoredFile {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  createdAt: number;
  expiresAt: number;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour

const store = new Map<string, StoredFile>();

// Sweep expired entries every 5 minutes. .unref() so this timer never blocks
// process exit.
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [token, entry] of store.entries()) {
    if (entry.expiresAt < now) {
      store.delete(token);
      removed += 1;
    }
  }
  if (removed > 0) {
    console.log(`[Download] sweep removed=${removed} remaining=${store.size}`);
  }
}, 5 * 60 * 1000).unref();

function generateToken(): string {
  // 24 bytes = 192 bits of entropy; unguessable.
  return crypto.randomBytes(24).toString("hex");
}

export interface RegisteredDownload {
  token: string;
  url: string;
  expires_at: string;
  expires_in_seconds: number;
}

export function registerDownload(
  buffer: Buffer,
  filename: string,
  mimetype: string = "application/octet-stream",
): RegisteredDownload {
  const token = generateToken();
  const now = Date.now();
  const expiresAt = now + TTL_MS;
  store.set(token, { buffer, filename, mimetype, createdAt: now, expiresAt });
  const base = ENV.PUBLIC_BASE_URL.replace(/\/$/, "");
  const url = `${base}/download/${token}`;
  console.log(
    `[Download] registered filename=${filename} size_kb=${Math.round(buffer.length / 1024)} token=${token.slice(0, 8)}… ttl_s=${Math.round(TTL_MS / 1000)}`,
  );
  return {
    token,
    url,
    expires_at: new Date(expiresAt).toISOString(),
    expires_in_seconds: Math.round(TTL_MS / 1000),
  };
}

export function getDownload(token: string): StoredFile | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(token);
    return null;
  }
  return entry;
}

export function mimeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}
