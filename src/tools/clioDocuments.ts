import { z } from "zod/v4";
import https from "https";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildQueryString,
  fetchAllPages,
  rawGetSingle,
  rawGetBinarySingle,
  rawPostSingle,
  rawPatchSingle,
} from "../clio/pagination";
import { registerDownload, mimeForFilename } from "../utils/downloadStore";
import { downloadFromBox } from "../utils/box";

// =====================================================================
// Clio Documents & Folders — the matter file itself.
//
// Wraps Clio's /documents and /folders resources: browse and search the
// documents on a matter, fetch metadata and version history, download the
// bytes (Clio 303-redirects to a presigned S3 URL), upload new documents
// or new versions, rename/move, and manage folders.
//
// Not exposed on purpose: DELETE /documents and DELETE /folders. Trashing
// client files is kept a human-in-Clio action.
// =====================================================================

const DOC_FIELDS =
  "id,name,filename,size,content_type,received_at,created_at,updated_at,locked," +
  "parent{id,name},matter{id,display_number},document_category{id,name}," +
  "latest_document_version{id,version_number,fully_uploaded}";

const FOLDER_FIELDS =
  "id,name,root,locked,created_at,updated_at,parent{id,name},matter{id,display_number}";

const VERSION_FIELDS =
  "id,version_number,filename,size,content_type,created_at,received_at,fully_uploaded";

// Same single-shot cap as the /upload route; Clio's put_url is one PUT, and
// larger files would need the multipart part_number flow.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// Above this, download_document refuses to inline base64 (streaming lag) and
// only hands back the short-lived download URL.
const MAX_INLINE_BASE64_BYTES = 2 * 1024 * 1024; // 2 MB

function ok(payload: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(err: any) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: true,
        message: err.message,
        status: err.response?.status,
        clio_error: err.response?.data,
      }),
    }],
    isError: true,
  };
}

export function formatDocument(d: any) {
  return {
    id: d.id,
    name: d.name,
    filename: d.filename,
    size: d.size,
    content_type: d.content_type,
    received_at: d.received_at,
    created_at: d.created_at,
    updated_at: d.updated_at,
    locked: d.locked,
    folder: d.parent,
    matter: d.matter,
    category: d.document_category,
    latest_version: d.latest_document_version,
  };
}

function formatFolder(f: any) {
  return {
    id: f.id,
    name: f.name,
    root: f.root,
    locked: f.locked,
    created_at: f.created_at,
    updated_at: f.updated_at,
    parent: f.parent,
    matter: f.matter,
  };
}

/** Build a Clio parent ref from exactly one of folder/matter/contact id. */
export function resolveParent(params: {
  folder_id?: number;
  matter_id?: number;
  contact_id?: number;
}): { id: number; type: "Folder" | "Matter" | "Contact" } | { error: string } {
  const given = [
    params.folder_id !== undefined ? { id: params.folder_id, type: "Folder" as const } : null,
    params.matter_id !== undefined ? { id: params.matter_id, type: "Matter" as const } : null,
    params.contact_id !== undefined ? { id: params.contact_id, type: "Contact" as const } : null,
  ].filter(Boolean) as Array<{ id: number; type: "Folder" | "Matter" | "Contact" }>;
  if (given.length !== 1) {
    return { error: "Provide exactly one of folder_id, matter_id, or contact_id as the destination." };
  }
  return given[0];
}

/**
 * PUT a buffer to a presigned upload URL (Clio's put_url → S3). No
 * Authorization header — S3 rejects requests carrying both a bearer header
 * and signed query params.
 */
function putBufferToUrl(fullUrl: string, buffer: Buffer, contentType?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: "PUT",
        headers: {
          "Content-Length": buffer.length,
          ...(contentType ? { "Content-Type": contentType } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            const err: any = new Error(`Upload PUT failed with status ${res.statusCode}`);
            err.response = { status: res.statusCode, data: body.slice(0, 500) };
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

export function registerClioDocumentTools(server: McpServer): void {
  // ============================================================
  //  list_documents — browse/search documents
  // ============================================================
  server.tool(
    "list_documents",
    "List or search documents in Clio's document repository. Filter by matter, contact, containing folder, and/or a wildcard name search. By default returns direct children when a folder_id is given; set scope='descendants' to search the whole subtree. Returns metadata only — use download_document for the file bytes.",
    {
      matter_id: z.coerce.number().optional().describe("Only documents on this matter"),
      contact_id: z.coerce.number().optional().describe("Only documents on this contact"),
      folder_id: z.coerce.number().optional().describe("Only documents inside this folder"),
      query: z.string().optional().describe("Wildcard search on document name"),
      scope: z.enum(["children", "descendants"]).optional().default("children")
        .describe("With folder_id: 'children' = direct contents only, 'descendants' = entire subtree"),
      include_deleted: z.boolean().optional().default(false).describe("Include trashed documents"),
      updated_since: z.string().optional().describe("Only documents updated after this ISO-8601 timestamp"),
      limit: z.coerce.number().optional().default(100).describe("Max documents to return (default 100)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: DOC_FIELDS,
          order: "updated_at(desc)",
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.contact_id) queryParams.contact_id = params.contact_id;
        if (params.folder_id) {
          queryParams.parent_id = params.folder_id;
          queryParams.scope = params.scope;
        }
        if (params.query) queryParams.query = params.query;
        if (params.include_deleted) queryParams.include_deleted = true;
        if (params.updated_since) queryParams.updated_since = params.updated_since;

        const docs = await fetchAllPages<any>("/documents", queryParams, params.limit);
        return ok({ count: docs.length, documents: docs.map(formatDocument) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // ============================================================
  //  get_document — single document metadata (+ optional versions)
  // ============================================================
  server.tool(
    "get_document",
    "Get full metadata for a single Clio document by ID, optionally including its version history. Returns metadata only — use download_document for the file bytes.",
    {
      document_id: z.coerce.number().describe("Clio document ID"),
      include_versions: z.boolean().optional().default(false)
        .describe("Also return the document's version history"),
    },
    async (params) => {
      try {
        const res = await rawGetSingle(`/documents/${params.document_id}`, { fields: DOC_FIELDS });
        const out: any = { document: formatDocument(res.data) };
        if (params.include_versions) {
          const versions = await fetchAllPages<any>(
            `/documents/${params.document_id}/versions`,
            { fields: VERSION_FIELDS }
          );
          out.versions = versions;
        }
        return ok(out);
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // ============================================================
  //  download_document — fetch the bytes (303 → presigned S3)
  // ============================================================
  server.tool(
    "download_document",
    "Download a Clio document's file content (latest version unless a document_version_id is given). Returns a short-lived direct download URL (1 hour); small files (≤2 MB) can also be returned inline as base64 with include_base64=true.",
    {
      document_id: z.coerce.number().describe("Clio document ID"),
      document_version_id: z.coerce.number().optional()
        .describe("Specific version to download (defaults to the latest)"),
      include_base64: z.boolean().optional().default(false)
        .describe("Also inline the file as base64 (only honored for files ≤2 MB)"),
    },
    async (params) => {
      try {
        const meta = await rawGetSingle(`/documents/${params.document_id}`, {
          fields: "id,name,filename,size,content_type",
        });
        const doc = meta.data;

        const query: Record<string, any> = {};
        if (params.document_version_id) query.document_version_id = params.document_version_id;
        const { buffer, contentType } = await rawGetBinarySingle(
          `/documents/${params.document_id}/download`,
          query
        );

        const filename = doc?.filename || doc?.name || `document-${params.document_id}`;
        const mimetype = doc?.content_type || contentType || mimeForFilename(filename);
        const reg = registerDownload(buffer, filename, mimetype);

        const out: any = {
          document_id: params.document_id,
          filename,
          content_type: mimetype,
          size_kb: Math.round(buffer.length / 1024),
          direct_download_url: reg.url,
          expires_at: reg.expires_at,
        };
        if (params.include_base64) {
          if (buffer.length <= MAX_INLINE_BASE64_BYTES) {
            out.base64 = buffer.toString("base64");
          } else {
            out.base64_skipped = `file is ${Math.round(buffer.length / 1024)} KB — over the ${MAX_INLINE_BASE64_BYTES / 1024} KB inline limit; use direct_download_url`;
          }
        }
        return ok(out);
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // ============================================================
  //  upload_document — create a document (or a new version)
  // ============================================================
  // Clio's upload is three steps: POST the metadata (returns a presigned
  // put_url on the new version), PUT the bytes to that URL, then PATCH the
  // document with the version uuid + fully_uploaded=true to finalize.
  server.tool(
    "upload_document",
    "Upload a file into Clio Documents — either as a NEW document (destination: exactly one of matter_id, folder_id, or contact_id) or as a NEW VERSION of an existing document (pass version_of_document_id instead). File content comes from exactly one of content_base64 (small files) or box_file_id (pull the bytes from Box). Max 50 MB.",
    {
      name: z.string().describe("Document name in Clio (e.g. 'Engagement Letter.pdf')"),
      matter_id: z.coerce.number().optional().describe("Destination matter (file goes to the matter's documents)"),
      folder_id: z.coerce.number().optional().describe("Destination Clio folder ID"),
      contact_id: z.coerce.number().optional().describe("Destination contact's document folder"),
      version_of_document_id: z.coerce.number().optional()
        .describe("Upload as a new VERSION of this existing Clio document (instead of a destination)"),
      content_base64: z.string().optional().describe("File content, base64-encoded"),
      box_file_id: z.string().optional().describe("Box file ID to pull the file content from"),
      content_type: z.string().optional()
        .describe("MIME type; inferred from the name's extension when omitted"),
      received_at: z.string().optional().describe("When the document was received (ISO 8601)"),
    },
    async (params) => {
      try {
        // Resolve the parent: a new version targets the existing Document,
        // otherwise exactly one destination container is required.
        let parent: { id: number; type: string };
        if (params.version_of_document_id !== undefined) {
          if (params.matter_id !== undefined || params.folder_id !== undefined || params.contact_id !== undefined) {
            return fail(new Error("Pass either version_of_document_id OR a destination (matter_id/folder_id/contact_id), not both."));
          }
          parent = { id: params.version_of_document_id, type: "Document" };
        } else {
          const resolved = resolveParent(params);
          if ("error" in resolved) return fail(new Error(resolved.error));
          parent = resolved;
        }

        if (!!params.content_base64 === !!params.box_file_id) {
          return fail(new Error("Provide exactly one of content_base64 or box_file_id."));
        }
        const buffer = params.box_file_id
          ? await downloadFromBox(params.box_file_id)
          : Buffer.from(params.content_base64!, "base64");
        if (buffer.length === 0) {
          return fail(new Error("Decoded file content is empty — nothing to upload."));
        }
        if (buffer.length > MAX_UPLOAD_BYTES) {
          return fail(new Error(`File is ${Math.round(buffer.length / (1024 * 1024))} MB — over the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB single-shot upload limit.`));
        }

        const contentType = params.content_type || mimeForFilename(params.name);

        // Step 1: create the document shell; Clio hands back a presigned put_url.
        const createBody: any = {
          data: {
            name: params.name,
            parent,
            content_type: contentType,
          },
        };
        if (params.received_at) createBody.data.received_at = params.received_at;
        const created = await rawPostSingle(
          `/documents?${buildQueryString({ fields: "id,name,latest_document_version{uuid,put_url}" })}`,
          createBody
        );
        const docId = created.data?.id;
        const version = created.data?.latest_document_version;
        if (!docId || !version?.put_url || !version?.uuid) {
          return fail(new Error(`Clio did not return an upload URL (document id=${docId ?? "?"}). Response: ${JSON.stringify(created.data ?? created).slice(0, 300)}`));
        }

        // Step 2: PUT the bytes to the presigned URL.
        await putBufferToUrl(version.put_url, buffer, contentType);

        // Step 3: finalize — mark the version fully uploaded.
        const finalized = await rawPatchSingle(
          `/documents/${docId}?${buildQueryString({ fields: DOC_FIELDS })}`,
          { data: { uuid: version.uuid, fully_uploaded: true } }
        );

        return ok({
          uploaded: true,
          new_version: parent.type === "Document",
          size_kb: Math.round(buffer.length / 1024),
          document: formatDocument(finalized.data ?? {}),
        });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // ============================================================
  //  update_document — rename / move / recategorize
  // ============================================================
  server.tool(
    "update_document",
    "Rename a Clio document, move it to a different folder/matter/contact, and/or change its document category. Does not touch the file content — use upload_document with version_of_document_id for that.",
    {
      document_id: z.coerce.number().describe("Clio document ID to update"),
      name: z.string().optional().describe("New document name"),
      folder_id: z.coerce.number().optional().describe("Move into this Clio folder"),
      matter_id: z.coerce.number().optional().describe("Move to this matter's documents"),
      contact_id: z.coerce.number().optional().describe("Move to this contact's document folder"),
      document_category_id: z.coerce.number().optional().describe("Set the document category"),
    },
    async (params) => {
      try {
        const body: any = { data: {} };
        if (params.name !== undefined) body.data.name = params.name;
        const destinationGiven =
          params.folder_id !== undefined || params.matter_id !== undefined || params.contact_id !== undefined;
        if (destinationGiven) {
          const resolved = resolveParent(params);
          if ("error" in resolved) return fail(new Error(resolved.error));
          body.data.parent = resolved;
        }
        if (params.document_category_id !== undefined) {
          body.data.document_category = { id: params.document_category_id };
        }
        if (Object.keys(body.data).length === 0) {
          return fail(new Error("Nothing to update — pass name, a destination, or document_category_id."));
        }

        const result = await rawPatchSingle(
          `/documents/${params.document_id}?${buildQueryString({ fields: DOC_FIELDS })}`,
          body
        );
        return ok({ updated: true, document: formatDocument(result.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // ============================================================
  //  list_folders — browse the folder tree
  // ============================================================
  server.tool(
    "list_folders",
    "List folders in Clio's document repository. Filter by matter, contact, parent folder, and/or a wildcard name search. Use this to find a folder_id for list_documents, upload_document, or create_folder.",
    {
      matter_id: z.coerce.number().optional().describe("Only folders on this matter"),
      contact_id: z.coerce.number().optional().describe("Only folders on this contact"),
      parent_id: z.coerce.number().optional().describe("Only folders inside this parent folder"),
      query: z.string().optional().describe("Wildcard search on folder name"),
      scope: z.enum(["children", "descendants"]).optional().default("children")
        .describe("With parent_id: 'children' = direct subfolders only, 'descendants' = entire subtree"),
      limit: z.coerce.number().optional().default(100).describe("Max folders to return (default 100)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = { fields: FOLDER_FIELDS };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.contact_id) queryParams.contact_id = params.contact_id;
        if (params.parent_id) {
          queryParams.parent_id = params.parent_id;
          queryParams.scope = params.scope;
        }
        if (params.query) queryParams.query = params.query;

        const folders = await fetchAllPages<any>("/folders", queryParams, params.limit);
        return ok({ count: folders.length, folders: folders.map(formatFolder) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // ============================================================
  //  create_folder — new folder under a matter/contact/folder
  // ============================================================
  server.tool(
    "create_folder",
    "Create a new folder in Clio Documents. Destination is exactly one of folder_id (subfolder), matter_id (matter's documents), or contact_id (contact's documents).",
    {
      name: z.string().describe("Folder name"),
      folder_id: z.coerce.number().optional().describe("Create inside this Clio folder"),
      matter_id: z.coerce.number().optional().describe("Create in this matter's documents"),
      contact_id: z.coerce.number().optional().describe("Create in this contact's documents"),
    },
    async (params) => {
      try {
        const resolved = resolveParent(params);
        if ("error" in resolved) return fail(new Error(resolved.error));

        const result = await rawPostSingle(
          `/folders?${buildQueryString({ fields: FOLDER_FIELDS })}`,
          { data: { name: params.name, parent: resolved } }
        );
        return ok({ created: true, folder: formatFolder(result.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );
}
