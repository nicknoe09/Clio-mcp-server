import { Router, Request, Response } from "express";
import multer from "multer";
import { uploadToBox, createBoxFile } from "../utils/box";
import { requireMicrosoftUser } from "../auth/requireUser";

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
// Auth: the same per-user Microsoft Bearer JWT the /mcp transport requires
// (Authorization: Bearer <token>), enforced by requireMicrosoftUser — no
// separate shared secret to manage.
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

// requireMicrosoftUser runs first (rejecting unauthenticated callers before we
// parse the potentially large body); the multipart handler runs only once the
// Bearer JWT has been verified and allowlisted.
router.post("/upload", requireMicrosoftUser, (req: Request, res: Response) => {
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

export default router;
