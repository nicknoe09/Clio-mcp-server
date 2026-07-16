import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawPatchSingle, rawDeleteSingle } from "../clio/pagination";

// Note fields we read back. Clio Note has subject + detail (the body), a date,
// and a polymorphic parent (matter or contact). We expand the matter so callers
// get the matter number/description without a second lookup.
const NOTE_FIELDS =
  "id,date,subject,detail,type," +
  "matter{id,display_number,description}," +
  "contact{id,name}";

export function registerNoteTools(server: McpServer): void {
  // search_notes — read/search the native Clio Notes timeline (GET /notes).
  // This is the per-record "Notes" tab in Clio (a separate resource from the
  // matter 'Notes' custom field). Use it to find matters whose notes contain a
  // marker like "FF" (flat fee) and a fee amount.
  server.tool(
    "search_notes",
    "Search Clio's native Notes (GET /notes) — the per-matter/per-contact Notes timeline (the 'Notes' tab), NOT the 'Notes' custom field. Returns each matching note's id, date, subject, detail (body), and its parent matter (id, display_number, description) or contact. Pass `query` to use Clio's server-side wildcard search over subject/detail (e.g. 'FF'); additionally/alternatively pass `contains` to filter client-side with a case-sensitive substring or regex (e.g. the exact token 'FF'). Scope with note_type (default 'Matter') and/or matter_id. Use this to find flat-fee matters where someone wrote 'FF' + a fee amount into the note.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Clio server-side wildcard search over note subject/detail (case-insensitive). E.g. 'FF'. NOTE: Clio's query is a relevance search capped at ~200 rows; if it returns a full page the tool automatically re-runs a complete cursor-paginated scan and filters by this term client-side (scan_mode='full_scan_fallback'). Omit to scan all notes of the given type and rely on `contains`.",
        ),
      contains: z
        .string()
        .optional()
        .describe(
          "Client-side filter applied to subject+detail after fetching. Treated as a regex (fall back to literal substring if it isn't valid regex). Use this for precise matching, e.g. '\\\\bFF\\\\b'.",
        ),
      case_sensitive: z
        .boolean()
        .optional()
        .describe("Whether the `contains` filter is case-sensitive. Default false."),
      note_type: z
        .enum(["Matter", "Contact"])
        .optional()
        .describe("Which notes to search. Default 'Matter'."),
      matter_id: z
        .number()
        .optional()
        .describe("Scope to a single matter's notes (Clio matter ID)."),
      max_results: z
        .number()
        .optional()
        .describe("Cap the number of returned matches (default 500)."),
    },
    async ({ query, contains, case_sensitive, note_type, matter_id, max_results }) => {
      try {
        const type = note_type ?? "Matter";
        const params: Record<string, any> = { type, fields: NOTE_FIELDS };
        if (query) params.query = query;
        if (matter_id) params.matter_id = matter_id;

        // Clio's `query` is a relevance-ranked full-text search: it returns at
        // most ONE page (~200 rows) and provides no `next` cursor, so
        // fetchAllPages stops after the first page and silently truncates.
        // (A query-less scan paginates correctly over every note.) So when a
        // `query` run comes back as a full page, we can't trust it to be
        // complete — re-run as a full cursor-paginated scan and apply `query`
        // as a client-side case-insensitive substring filter instead.
        const CLIO_PAGE_SIZE = 200;
        let notes = await fetchAllPages<any>("/notes", params);
        let scan_mode: "full_scan" | "server_query" | "full_scan_fallback" =
          query ? "server_query" : "full_scan";

        if (query && notes.length >= CLIO_PAGE_SIZE) {
          const fullParams: Record<string, any> = { type, fields: NOTE_FIELDS };
          if (matter_id) fullParams.matter_id = matter_id;
          const all = await fetchAllPages<any>("/notes", fullParams);
          const q = query.toLowerCase();
          notes = all.filter((n: any) =>
            `${n.subject ?? ""}\n${n.detail ?? ""}`.toLowerCase().includes(q),
          );
          scan_mode = "full_scan_fallback";
        }

        // Optional client-side refine. Build a matcher from `contains`.
        let matcher: ((s: string) => boolean) | null = null;
        if (contains) {
          const flags = case_sensitive ? "" : "i";
          try {
            const re = new RegExp(contains, flags);
            matcher = (s: string) => re.test(s);
          } catch {
            const needle = case_sensitive ? contains : contains.toLowerCase();
            matcher = (s: string) =>
              (case_sensitive ? s : s.toLowerCase()).includes(needle);
          }
        }

        const cap = max_results ?? 500;
        const matches = notes
          .filter((n: any) => {
            if (!matcher) return true;
            const hay = `${n.subject ?? ""}\n${n.detail ?? ""}`;
            return matcher(hay);
          })
          .slice(0, cap)
          .map((n: any) => ({
            note_id: n.id,
            date: n.date,
            subject: n.subject,
            detail: n.detail,
            matter: n.matter
              ? {
                  id: n.matter.id,
                  display_number: n.matter.display_number,
                  description: n.matter.description,
                }
              : null,
            contact: n.contact ? { id: n.contact.id, name: n.contact.name } : null,
          }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  type,
                  query: query ?? null,
                  contains: contains ?? null,
                  // 'server_query' = Clio relevance search (may be capped at one
                  // page); 'full_scan_fallback' = query truncated so we scanned
                  // every note client-side; 'full_scan' = no query, full scan.
                  scan_mode,
                  notes_scanned: notes.length,
                  count: matches.length,
                  notes: matches,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status: err.response?.status,
                clio_error: err.response?.data,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // update_note — edit an existing note's subject/body/date (PATCH /notes/{id}).
  server.tool(
    "update_note",
    "Update an existing Clio note (PATCH /notes/{id}). Find the note_id via search_notes. Only the fields you pass are changed; the note's parent matter/contact and type are not moved.",
    {
      note_id: z.coerce.number().describe("Clio note ID to update"),
      subject: z.string().optional().describe("New note subject"),
      detail: z.string().optional().describe("New note body/detail text"),
      date: z.string().optional().describe("New note date (YYYY-MM-DD)"),
    },
    async ({ note_id, subject, detail, date }) => {
      try {
        const body: any = { data: {} };
        if (subject !== undefined) body.data.subject = subject;
        if (detail !== undefined) body.data.detail = detail;
        if (date !== undefined) body.data.date = date;
        if (Object.keys(body.data).length === 0) {
          throw new Error("Nothing to update — pass at least one of subject, detail, or date.");
        }

        const result = await rawPatchSingle(`/notes/${note_id}`, body);
        const n = result.data ?? {};
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              updated: true,
              note: { id: n.id, date: n.date, subject: n.subject, detail: n.detail },
            }, null, 2),
          }],
        };
      } catch (err: any) {
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
    },
  );

  // delete_note — remove a note (DELETE /notes/{id}).
  server.tool(
    "delete_note",
    "Delete a Clio note (DELETE /notes/{id}). This permanently removes the note. Find the note_id via search_notes.",
    {
      note_id: z.coerce.number().describe("Clio note ID to delete"),
    },
    async ({ note_id }) => {
      try {
        await rawDeleteSingle(`/notes/${note_id}`);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ deleted: true, id: note_id }, null, 2),
          }],
        };
      } catch (err: any) {
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
    },
  );
}
