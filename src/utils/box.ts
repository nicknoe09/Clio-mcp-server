import { boxUploadFile, boxUploadNewVersion, boxDownloadFile } from "../box/client";
import { getBoxRegisteredUsers } from "./tokenStore";

interface UploadResult {
  box_file_id: string;
  box_url: string;
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
 * Upload a file buffer to Box using OAuth tokens.
 * - New file: uploads to the specified folder
 * - Overwrite existing: uploads new version of overwriteFileId
 * - 409 conflict: auto-retries as version upload to the conflicting file
 * - 401: auto-refreshes token via interceptor; throws if refresh also fails
 */
export async function uploadToBox(opts: {
  buffer: Buffer;
  filename: string;
  folderId: string;
  overwriteFileId?: string;
}): Promise<UploadResult> {
  const users = getBoxRegisteredUsers();
  if (users.length === 0) {
    throw new Error("No Box user authenticated. Visit /box/oauth/start to connect your Box account.");
  }
  const userEmail = users[0]; // Single-user: use the first (and likely only) registered user

  // Upload as new version of an existing file
  if (opts.overwriteFileId) {
    try {
      const meta = await boxUploadNewVersion(opts.buffer, opts.filename, opts.overwriteFileId, userEmail);
      return { box_file_id: meta.id, box_url: `https://app.box.com/file/${meta.id}` };
    } catch (err: any) {
      // File was deleted — fall through to new upload
      if (err?.response?.status === 404) {
        // fall through
      } else {
        throw err;
      }
    }
  }

  // Upload as new file
  try {
    const meta = await boxUploadFile(opts.buffer, opts.filename, opts.folderId, userEmail);
    return { box_file_id: meta.id, box_url: `https://app.box.com/file/${meta.id}` };
  } catch (err: any) {
    // 409 = file with same name exists — version it instead
    if (err?.response?.status === 409) {
      const conflictId = err.response.data?.context_info?.conflicts?.[0]?.id
        ?? err.response.data?.context_info?.conflicts?.id;
      if (conflictId) {
        const meta = await boxUploadNewVersion(opts.buffer, opts.filename, conflictId, userEmail);
        return { box_file_id: meta.id, box_url: `https://app.box.com/file/${meta.id}` };
      }
    }
    throw err;
  }
}
