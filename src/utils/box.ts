import { boxUploadFile, boxUploadNewVersion, boxDownloadFile, boxDeleteFile } from "../box/client";
import { getBoxRegisteredUsers } from "./tokenStore";
import { registerDownload, mimeForFilename } from "./downloadStore";

// =====================================================================
// uploadToBox — version-preferred with direct-download fallback.
//
// Upload flow (three paths, in order):
//
//   1. Direct version (only if overwriteFileId supplied):
//        boxUploadNewVersion(overwriteFileId). On 404 (target file was
//        deleted) fall through to step 2; any other error → DL fallback.
//
//   2. 409-lookup version (the primary path for files without a known
//      ID — this is how the old code kept versioning weekly goals etc.):
//        boxUploadFile(...) is called as a PROBE. Box normally responds
//        409 "file with this name already exists, id=X". We extract X
//        from the 409 body and boxUploadNewVersion(X) to version it.
//
//      Edge case: if boxUploadFile unexpectedly SUCCEEDS (filename did
//      not exist — first upload ever), we treat that as "not what we
//      wanted" per the caller's contract, DELETE the orphan via
//      boxDeleteFile, and fall to step 3. We never silently create new
//      files in Box.
//
//   3. Direct-download fallback: register the buffer in the in-process
//      download store (1-hour TTL) and return a /download/:token URL.
//      Used on every genuine failure above, and in the refuse-new-file
//      case.
//
// The prior base64-in-MCP-response fallback is gone entirely — that
// path was responsible for multi-minute client streaming lag.
//
// UploadResult is discriminated by `uploaded`. Callers branch on it.
// =====================================================================

export interface UploadSuccess {
  uploaded: true;
  box_file_id: string;
  box_url: string;
  filename: string;
  size_kb: number;
  elapsed_ms: number;
  via: "direct_version" | "conflict_lookup_version";
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

function extractConflictId(err: any): string | null {
  const c = err?.response?.data?.context_info?.conflicts;
  if (!c) return null;
  if (Array.isArray(c) && c[0]?.id) return String(c[0].id);
  if (typeof c === "object" && (c as any).id) return String((c as any).id);
  return null;
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
 * Upload (version) a file to Box. See module header for the full flow.
 */
export async function uploadToBox(opts: {
  buffer: Buffer;
  filename: string;
  folderId: string;
  overwriteFileId?: string;
}): Promise<UploadResult> {
  const start = Date.now();
  const { buffer, filename, folderId, overwriteFileId } = opts;
  const size_kb = Math.round(buffer.length / 1024);

  console.log(
    `[Box] upload start filename=${filename} size_kb=${size_kb} folderId=${folderId} overwriteFileId=${overwriteFileId ?? "<none>"}`,
  );

  const users = getBoxRegisteredUsers();
  if (users.length === 0) {
    return fallback(buffer, filename, "no-box-user-authenticated");
  }
  const userEmail = users[0];

  // ───── Path 1: direct version (only if caller gave us an ID) ─────
  if (overwriteFileId) {
    try {
      const meta = await boxUploadNewVersion(buffer, filename, overwriteFileId, userEmail);
      const elapsed_ms = Date.now() - start;
      console.log(
        `[Box] upload ok via=direct_version filename=${filename} file_id=${meta.id} size_kb=${size_kb} elapsed_ms=${elapsed_ms}`,
      );
      return {
        uploaded: true,
        box_file_id: meta.id,
        box_url: `https://app.box.com/file/${meta.id}`,
        filename,
        size_kb,
        elapsed_ms,
        via: "direct_version",
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) {
        // Target file was deleted — drop through to 409-lookup path.
        console.warn(
          `[Box] direct_version 404 — overwriteFileId=${overwriteFileId} missing, falling back to conflict-lookup`,
        );
      } else {
        const boxMsg = err?.response?.data?.message ?? err?.message ?? "unknown";
        console.error(
          `[Box] direct_version FAIL filename=${filename} overwriteFileId=${overwriteFileId} status=${status ?? "?"} message=${boxMsg}`,
        );
        return fallback(buffer, filename, `direct_version_failed status=${status ?? "?"} msg=${boxMsg}`);
      }
    }
  }

  // ───── Path 2: 409-lookup version (the common path) ─────
  // We call boxUploadFile as a probe. If the file exists (normal case),
  // Box returns 409 with the existing file's ID, which we then version.
  // If the file genuinely doesn't exist, Box accepts the upload and
  // creates a new file — we don't want that, so we delete it and fall
  // back to a download link (per caller's contract: don't silently
  // create new Box files).
  try {
    const meta = await boxUploadFile(buffer, filename, folderId, userEmail);
    // Unexpected success — Box accepted our probe as a real new-file
    // upload. Clean up the orphan and return a DL link instead.
    console.warn(
      `[Box] conflict_lookup UNEXPECTED_SUCCESS filename=${filename} file_id=${meta.id} — deleting orphan and falling back to direct_download_url`,
    );
    try {
      await boxDeleteFile(meta.id, userEmail);
      console.log(`[Box] orphan deleted file_id=${meta.id}`);
    } catch (delErr: any) {
      console.error(
        `[Box] orphan delete FAILED file_id=${meta.id} message=${delErr?.message ?? "unknown"} — orphan will remain in Box until cleaned up manually`,
      );
    }
    return fallback(buffer, filename, `no_existing_file_to_version (orphan ${meta.id} deleted)`);
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 409) {
      const conflictId = extractConflictId(err);
      if (!conflictId) {
        const boxMsg = err?.response?.data?.message ?? "unknown";
        console.error(
          `[Box] conflict_lookup 409 but no conflict ID in body filename=${filename} message=${boxMsg}`,
        );
        return fallback(buffer, filename, `409_no_conflict_id msg=${boxMsg}`);
      }
      try {
        const meta = await boxUploadNewVersion(buffer, filename, conflictId, userEmail);
        const elapsed_ms = Date.now() - start;
        console.log(
          `[Box] upload ok via=conflict_lookup_version filename=${filename} file_id=${meta.id} size_kb=${size_kb} elapsed_ms=${elapsed_ms}`,
        );
        return {
          uploaded: true,
          box_file_id: meta.id,
          box_url: `https://app.box.com/file/${meta.id}`,
          filename,
          size_kb,
          elapsed_ms,
          via: "conflict_lookup_version",
        };
      } catch (vErr: any) {
        const vStatus = vErr?.response?.status;
        const vMsg = vErr?.response?.data?.message ?? vErr?.message ?? "unknown";
        console.error(
          `[Box] conflict_lookup_version FAIL filename=${filename} conflictId=${conflictId} status=${vStatus ?? "?"} message=${vMsg}`,
        );
        return fallback(buffer, filename, `conflict_lookup_version_failed status=${vStatus ?? "?"} msg=${vMsg}`);
      }
    }
    const boxMsg = err?.response?.data?.message ?? err?.message ?? "unknown";
    console.error(
      `[Box] conflict_lookup FAIL (non-409) filename=${filename} status=${status ?? "?"} message=${boxMsg}`,
    );
    return fallback(buffer, filename, `conflict_lookup_failed status=${status ?? "?"} msg=${boxMsg}`);
  }
}
