import { Router, Request, Response } from "express";
import multer from "multer";
import { createHash, timingSafeEqual } from "node:crypto";
import { uploadToBox, createBoxFile, uploadToBoxAsUser } from "../utils/box";
import { resolveUploadKey } from "../auth/vault";

// =====================================================================
// POST /upload and /version — authenticated binary upload → Box.
//
// A plain multipart/form-data route so an external client can stream raw
// bytes (curl -F) instead of base64-ing a binary into a tool argument.
//
//   field  file               the binary (.docx/.pdf/.xlsx) — REQUIRED
//   field  parent_folder_id   Box folder id → create a NEW file (/upload)
//   field  overwrite_file_id  Box file id   → upload a NEW VERSION (/upload)
//   field  file_id            Box file id   → upload a NEW VERSION (/version)
//   field  file_name          name to store as (falls back to the filename)
//
// Auth (X-Upload-Secret header), two kinds of credential:
//   1. A PER-USER upload key (resolveUploadKey → owning attorney). The upload
//      runs as THAT attorney's own Box account, using their Box token from the
//      platform vault. This is the per-user path.
//   2. The legacy shared UPLOAD_SECRET → the shared service Box account
//      (getBoxRegisteredUsers()[0]). Kept as a fallback.
// A per-user key takes precedence; if the upload_keys table isn't provisioned
// yet, resolveUploadKey returns null and we fall back to the shared secret.
// =====================================================================

const router = Router();

// Box's single-shot upload cap. Larger files would need the chunked-upload
// API, which this route does not implement — reject them up front.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
}).single("file");

// Constant-time check of the presented secret against the shared UPLOAD_SECRET.
function sharedSecretMatches(req: Request): boolean {
  const expected = process.env.UPLOAD_SECRET;
  if (!expected) {
    console.error("[Upload] UPLOAD_SECRET is not set — shared-secret path disabled (fail closed)");
    return false;
  }
  const provided = req.headers["x-upload-secret"];
  if (typeof provided !== "string" || !provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

type Auth = { kind: "user"; userId: string } | { kind: "shared" };
type Target = { create: string } | { version: string };

// Resolve who the request acts as: a per-user upload key (→ that attorney) or
// the shared secret (→ service account). Null = unauthorized.
async function resolveUploadAuth(req: Request): Promise<Auth | null> {
  const presented = req.headers["x-upload-secret"];
  if (typeof presented === "string" && presented) {
    try {
      const owner = await resolveUploadKey(presented);
      if (owner) return { kind: "user", userId: owner.userId };
    } catch (e: any) {
      // Vault unavailable / lookup failed — don't lock out the shared path.
      console.error(`[Upload] upload-key lookup failed, falling back to shared secret: ${e?.message ?? e}`);
    }
  }
  if (sharedSecretMatches(req)) return { kind: "shared" };
  return null;
}

async function dispatchToBox(
  auth: Auth,
  buffer: Buffer,
  filename: string,
  target: Target
): Promise<
  | { uploaded: true; box_file_id: string; filename: string; version?: string }
  | { uploaded: false; reason?: string; note?: string }
> {
  if (auth.kind === "user") {
    return uploadToBoxAsUser({ buffer, filename, userId: auth.userId, target });
  }
  // Shared service account (legacy).
  return "version" in target
    ? uploadToBox({ buffer, filename, folderId: "", overwriteFileId: target.version })
    : createBoxFile({ buffer, filename, folderId: target.create });
}

// Shared route body: auth → parse multipart → derive target → upload → respond.
function makeUploadHandler(
  deriveTarget: (body: any) => Target | { error: string }
) {
  return (req: Request, res: Response) => {
    (async () => {
      // Auth from the header before parsing the (potentially large) body.
      const auth = await resolveUploadAuth(req);
      if (!auth) {
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

        const target = deriveTarget(req.body ?? {});
        if ("error" in target) {
          res.status(400).json({ ok: false, error: target.error });
          return;
        }

        const fileName = (String(req.body?.file_name ?? "").trim()) || file.originalname;
        if (!fileName) {
          res.status(400).json({ ok: false, error: "missing file_name (and no multipart filename to fall back to)" });
          return;
        }

        const buffer = file.buffer;
        try {
          const result = await dispatchToBox(auth, buffer, fileName, target);
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
            acted_as: auth.kind, // "user" = the attorney's own Box; "shared" = service account
          });
        } catch (e: any) {
          console.error(`[Upload] unexpected failure filename=${fileName}: ${e?.message ?? e}`);
          res.status(500).json({ ok: false, error: e?.message ?? String(e) });
        }
      });
    })().catch((e: any) => {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    });
  };
}

// POST /upload — create (parent_folder_id) OR version (overwrite_file_id); exactly one.
router.post(
  "/upload",
  makeUploadHandler((body): Target | { error: string } => {
    const overwriteFileId = String(body?.overwrite_file_id ?? "").trim() || undefined;
    const parentFolderId = String(body?.parent_folder_id ?? "").trim() || undefined;
    if (!!overwriteFileId === !!parentFolderId) {
      return { error: "provide exactly one of overwrite_file_id or parent_folder_id" };
    }
    return overwriteFileId ? { version: overwriteFileId } : { create: parentFolderId! };
  })
);

// POST /version — version an existing file (one-shot): just file_id + file.
router.post(
  "/version",
  makeUploadHandler((body): Target | { error: string } => {
    const fileId = String(body?.file_id ?? "").trim();
    if (!fileId) return { error: "missing file_id" };
    return { version: fileId };
  })
);

export default router;
