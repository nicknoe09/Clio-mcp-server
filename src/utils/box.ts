import { boxUploadNewVersion, boxDownloadFile } from "../box/client";
import { getBoxRegisteredUsers } from "./tokenStore";
import { registerDownload, mimeForFilename } from "./downloadStore";

// =====================================================================
// uploadToBox — version-only semantics with direct-download fallback.
//
// Design rationale:
//   - New-file uploads through this wrapper proved unreliable in practice,
//     and the prior base64-in-MCP-response fallback caused multi-minute
//     streaming lag on the client (the infamous "base64 eternity").
//   - So: we ONLY attempt Box version uploads. If we can't version (no
//     overwriteFileId given, Box returns any error), we do NOT try a new
//     upload and we do NOT return base64. Instead we register the buffer
//     in the in-process download store and return a short-lived
//     /download/:token URL the caller can hit to retrieve the generated
//     file directly.
//   - The shape of UploadResult is discriminated by `uploaded`. Callers
//     should branch on that and surface whichever set of fields is
//     populated.
// =====================================================================

export interface UploadSuccess {
  uploaded: true;
  box_file_id: string;
  box_url: string;
  filename: string;
  size_kb: number;
  elapsed_ms: number;
}

export interface UploadFallback {
  uploaded: false;
  filename: string;
  size_kb: number;
  direct_download_url: string;
  expires_at: string;
  expires_in_seconds: number;
  reason: string;
  note: string;
}

export type UploadResult = UploadSuccess | UploadFallback;

function fallback(buffer: Buffer, filename: string, reason: string): UploadFallback {
  const reg = registerDownload(buffer, filename, mimeForFilename(filename));
  const size_kb = Math.round(buffer.length / 1024);
  console.warn(
    `[Box] upload fallback — serving direct_download_url filename=${filename} size_kb=${size_kb} reason=${reason}`,
  );
  return {
    uploaded: false,
    filename,
    size_kb,
    direct_download_url: reg.url,
    expires_at: reg.expires_at,
    expires_in_seconds: reg.expires_in_seconds,
    reason,
    note: "Box upload unavailable. Download the file from direct_download_url within 1 hour.",
  };
}

/**
 * Download a file from Box by its file ID.
 */
export async function downloadFromBox(fileId: string): Promise<Buffer> {
  const users = getBoxRegisteredUsers();
  if (users.length === 0) {
    throw new Error("No Box user authenticated. Visit /box/oauth/start to connect your Box account.");
  }
  return boxDownloadFile(fileId, users[0]);
}

/**
 * Version an existing Box file with a new buffer. Falls back to a direct
 * download URL if versioning is impossible or fails.
 *
 * `folderId` is retained for backwards API compatibility with existing
 * callers but is NOT used — we never create new files.
 */
export async function uploadToBox(opts: {
  buffer: Buffer;
  filename: string;
  folderId: string;
  overwriteFileId?: string;
}): Promise<UploadResult> {
  const start = Date.now();
  const { buffer, filename, overwriteFileId } = opts;
  const size_kb = Math.round(buffer.length / 1024);

  console.log(
    `[Box] upload start filename=${filename} size_kb=${size_kb} overwriteFileId=${overwriteFileId ?? "<none>"}`,
  );

  const users = getBoxRegisteredUsers();
  if (users.length === 0) {
    return fallback(buffer, filename, "no-box-user-authenticated");
  }
  const userEmail = users[0];

  if (!overwriteFileId) {
    // Version-only: without a target file ID we cannot proceed against Box.
    return fallback(buffer, filename, "no-overwriteFileId-provided");
  }

  try {
    const meta = await boxUploadNewVersion(buffer, filename, overwriteFileId, userEmail);
    const elapsed_ms = Date.now() - start;
    console.log(
      `[Box] upload ok filename=${filename} file_id=${meta.id} size_kb=${size_kb} elapsed_ms=${elapsed_ms}`,
    );
    return {
      uploaded: true,
      box_file_id: meta.id,
      box_url: `https://app.box.com/file/${meta.id}`,
      filename,
      size_kb,
      elapsed_ms,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    const boxMsg =
      err?.response?.data?.message
        ?? err?.response?.data?.code
        ?? err?.message
        ?? "unknown";
    console.error(
      `[Box] upload FAIL filename=${filename} overwriteFileId=${overwriteFileId} status=${status ?? "?"} message=${boxMsg}`,
    );
    return fallback(buffer, filename, `version_failed status=${status ?? "?"} msg=${boxMsg}`);
  }
}
