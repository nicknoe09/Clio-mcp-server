import { Router, Request, Response } from "express";
import multer from "multer";
import { createHash, timingSafeEqual } from "node:crypto";
import { uploadToBox, createBoxFile } from "../utils/box";

// =====================================================================
// POST /upload — authenticated binary upload → Box (create or version).
//
// A plain multipart/form-data route so an external client can stream raw
// bytes (curl -F) instead of base64-ing a binary into a tool argument:
//
//   field  file               the binary (.docx/.pdf/.xlsx) — REQUIRED
//   field  overwrite_file_id  Box file id → upload a NEW VERSION of it
//   field  parent_folder_id   Box folder id → create a NEW file in it
//   field  file_name          name to store as (falls back to the
//                              multipart filename)
//
// Exactly one of overwrite_file_id / parent_folder_id is required.
//
// Auth: header X-Upload-Secret, constant-time compared to env UPLOAD_SECRET.
// Fails closed (401) if UPLOAD_SECRET is unset.
//
// The Box work reuses the dashboard updater's helpers (utils/box.ts):
// uploadToBox(overwriteFileId) for versions, createBoxFile() for new files.
// =====================================================================

const router = Router();

// Box's single-shot upload cap. Larger files would need the chunked-upload
// API, which this route does not implement — reject them up front.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// In-memory parsing: we hand the buffer straight to Box, never touching disk.
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
}).single("file");

// Constant-time secret check. Hashing both sides to a fixed-width digest keeps
// the comparison constant-time regardless of input length (timingSafeEqual
// throws on length mismatch) and avoids leaking the secret's length.
function secretMatches(req: Request): boolean {
  const expected = process.env.UPLOAD_SECRET;
  if (!expected) {
    console.error("[Upload] UPLOAD_SECRET is not set — rejecting all uploads (fail closed)");
    return false;
  }
  const provided = req.headers["x-upload-secret"];
  if (typeof provided !== "string" || !provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

router.post("/upload", (req: Request, res: Response) => {
  // Auth before parsing the (potentially large) body so a bad secret is cheap.
  if (!secretMatches(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  memUpload(req, res, async (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ ok: false, error: `file exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit` });
        return;
      }
      res.status(400).json({ ok: false, error: `multipart parse failed: ${err?.message ?? String(err)}` });
      return;
    }

    const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
    if (!file) {
      res.status(400).json({ ok: false, error: "missing 'file' part in multipart body" });
      return;
    }

    const overwriteFileId = String(req.body?.overwrite_file_id ?? "").trim() || undefined;
    const parentFolderId = String(req.body?.parent_folder_id ?? "").trim() || undefined;
    // Exactly one target must be given (both set or both unset → ambiguous).
    if (!!overwriteFileId === !!parentFolderId) {
      res.status(400).json({ ok: false, error: "provide exactly one of overwrite_file_id or parent_folder_id" });
      return;
    }

    const fileName = (String(req.body?.file_name ?? "").trim()) || file.originalname;
    if (!fileName) {
      res.status(400).json({ ok: false, error: "missing file_name (and no multipart filename to fall back to)" });
      return;
    }

    const buffer = file.buffer;

    try {
      // Version an existing file, or create a new one — reusing the same Box
      // helpers the dashboard updater uses. folderId is unused on the version
      // path (uploadToBox only touches it if the target file 404s).
      const result = overwriteFileId
        ? await uploadToBox({ buffer, filename: fileName, folderId: "", overwriteFileId })
        : await createBoxFile({ buffer, filename: fileName, folderId: parentFolderId! });

      if (!result.uploaded) {
        // Box upload failed; uploadToBox/createBoxFile produced a fallback
        // download link, which is useless to a remote client that just sent
        // us the bytes — surface the reason as an error instead.
        res.status(502).json({ ok: false, error: result.reason, note: result.note });
        return;
      }

      res.json({
        ok: true,
        file_id: result.box_file_id,
        file_name: result.filename,
        version: result.version ?? null,
        size: buffer.length,
      });
    } catch (e: any) {
      console.error(`[Upload] unexpected failure filename=${fileName}: ${e?.message ?? e}`);
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });
});

// =====================================================================
// POST /version — upload a NEW VERSION of an existing Box file.
//
// Symmetric with /upload but for the version case only, so the call is a
// clean one-shot (no parent_folder_id / "exactly one of" rule):
//
//   field  file_id    Box file id to version — REQUIRED
//   field  file       the new binary — REQUIRED
//   field  file_name  name to store as (falls back to the multipart filename)
//
// This is the same path /upload takes when given overwrite_file_id —
// uploadToBox(overwriteFileId) → boxUploadNewVersion →
// POST upload.box.com/api/2.0/files/{id}/content. Auth + limits identical.
// =====================================================================
router.post("/version", (req: Request, res: Response) => {
  if (!secretMatches(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  memUpload(req, res, async (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ ok: false, error: `file exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit` });
        return;
      }
      res.status(400).json({ ok: false, error: `multipart parse failed: ${err?.message ?? String(err)}` });
      return;
    }

    const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
    if (!file) {
      res.status(400).json({ ok: false, error: "missing 'file' part in multipart body" });
      return;
    }

    const fileId = String(req.body?.file_id ?? "").trim();
    if (!fileId) {
      res.status(400).json({ ok: false, error: "missing file_id" });
      return;
    }

    const fileName = (String(req.body?.file_name ?? "").trim()) || file.originalname;
    if (!fileName) {
      res.status(400).json({ ok: false, error: "missing file_name (and no multipart filename to fall back to)" });
      return;
    }

    const buffer = file.buffer;

    try {
      // folderId is unused on the version path (uploadToBox only touches it if
      // the target file 404s — i.e. file_id is wrong/deleted, which then 502s).
      const result = await uploadToBox({ buffer, filename: fileName, folderId: "", overwriteFileId: fileId });

      if (!result.uploaded) {
        res.status(502).json({ ok: false, error: result.reason, note: result.note });
        return;
      }

      res.json({
        ok: true,
        file_id: result.box_file_id,
        file_name: result.filename,
        version: result.version ?? null,
        size: buffer.length,
      });
    } catch (e: any) {
      console.error(`[Upload] /version unexpected failure file_id=${fileId}: ${e?.message ?? e}`);
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });
});

export default router;
