import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";
import { detectFlags, detectDuplicates, detectBillingSpikes, detectCombinables, detectOverstaffing, detectRepeatedShortComms, HC_COURT_IDS, Flag, CombineGroup } from "./audit";

export function registerAuditTimeTools(server: McpServer): void {
  server.tool(
    "audit_time_entries",
    "Audit time entries for a specific user within a date range. Runs the same billing compliance checks as audit_draft_bills (HC standards, block billing, vague entries, clerical, etc.) but on any time entries — not just those on draft bills. Returns CSV with flags and suggested revisions. Also used by the /review UI.",
    {
      user_id: z.coerce.number().describe("Clio user ID of the timekeeper to audit"),
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      flagged_only: z.boolean().default(true).describe("Return only flagged entries (default true). Set false for full export."),
    },
    async (params) => {
      try {
        const result = await auditTimeEntries(params.user_id, params.start_date, params.end_date, params.flagged_only);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message }) }],
          isError: true,
        };
      }
    }
  );
}

// Exported so the /review route can call it directly
export async function auditTimeEntries(
  userId: number,
  startDate: string,
  endDate: string,
  flaggedOnly: boolean = true
): Promise<AuditResult> {
  // 1. Fetch time entries (simple fields — activities endpoint doesn't support deep nesting)
  const queryParams: Record<string, any> = {
    type: "TimeEntry",
    fields: "id,date,quantity,rounded_quantity,price,note,matter{id,display_number,description},user{id,name}",
    user_id: userId,
    created_since: `${startDate}T00:00:00+00:00`,
  };
  let entries = await fetchAllPages<any>("/activities", queryParams);
  entries = entries.filter((e: any) => e.date >= startDate && e.date <= endDate);

  // 2. Build matter HC classification cache — fetch matter details separately
  const matterHC = new Map<number, { isHC: boolean; description: string }>();
  const matterIds = new Set(entries.map((e: any) => e.matter?.id).filter(Boolean));

  for (const mid of matterIds) {
    try {
      const matterDetail = await rawGetSingle(`/matters/${mid}`, {
        fields: "id,description,custom_field_values{id,field_name,value}",
      });
      const cfvs = matterDetail.data?.custom_field_values || [];
      const courtField = cfvs.find((c: any) => c.field_name === "Court");
      const courtId = courtField?.value || null;
      const isHC = courtId ? HC_COURT_IDS.has(courtId) : false;

      matterHC.set(mid, {
        isHC,
        description: matterDetail.data?.description || "",
      });
    } catch {
      // If we can't fetch matter details, assume non-HC
      matterHC.set(mid, { isHC: false, description: "" });
    }
  }

  // 3. Run detection on each entry
  const allEntries: AuditEntry[] = [];

  for (const e of entries) {
    const mid = e.matter?.id;
    const matterInfo = mid ? matterHC.get(mid) : null;
    const isHC = matterInfo?.isHC || false;
    const hours = (e.rounded_quantity || e.quantity) ? (e.rounded_quantity || e.quantity) / 3600 : 0;
    const rate = e.price || 0;
    const note = e.note || "";

    const flags = detectFlags(note, rate, hours, isHC, e.user?.id, matterInfo?.description);

    const matterName = e.matter
      ? `${e.matter.display_number} — ${e.matter.description || ""}`
      : "Unknown Matter";

    allEntries.push({
      activity_id: e.id,
      matter_id: mid || 0,
      matter_name: matterName,
      is_hc: isHC,
      date: e.date,
      timekeeper: e.user?.name || "Unknown",
      user_id: e.user?.id,
      hours: Math.round(hours * 100) / 100,
      rate,
      amount: Math.round(hours * rate * 100) / 100,
      note,
      flags,
    });
  }

  // 4. Cross-entry detection — detection helpers key by entryUid (activity_id
  // when sourced from /activities, line_item_id when sourced from /line_items).
  const dupeFlags = detectDuplicates(allEntries);
  const spikeFlags = detectBillingSpikes(allEntries);
  const { flags: combineFlags, groups: combineGroups } = detectCombinables(allEntries);
  const overstaffFlags = detectOverstaffing(allEntries);
  const repeatCommFlags = detectRepeatedShortComms(allEntries);

  for (const e of allEntries) {
    if (dupeFlags.has(e.activity_id)) {
      e.flags.push({ code: "DUPLICATE", severity: "strike", message: dupeFlags.get(e.activity_id)! });
    }
    if (spikeFlags.has(e.activity_id)) {
      e.flags.push({ code: "BILLING_SPIKE", severity: "review", message: spikeFlags.get(e.activity_id)! });
    }
    if (overstaffFlags.has(e.activity_id)) {
      e.flags.push({ code: "OVERSTAFFING", severity: "review", message: overstaffFlags.get(e.activity_id)! });
    }
    if (repeatCommFlags.has(e.activity_id)) {
      e.flags.push({ code: "REPEATED_SHORT_COMMS", severity: "review", message: repeatCommFlags.get(e.activity_id)! });
    }
    if (combineFlags.has(e.activity_id)) {
      // Find which group this entry belongs to
      const group = combineGroups.find(g => g.activityIds.includes(e.activity_id));
      e.flags.push({
        code: "COMBINABLE",
        severity: "review",
        message: combineFlags.get(e.activity_id)!,
        suggested_action: `COMBINE ${group?.activityIds.length || 0} entries into one (${group?.totalHours || 0} hrs)`,
        suggested_description: group?.suggestedCombined,
      });
    }
  }

  // 5. Build summary
  const flaggedEntries = allEntries.filter(e => e.flags.length > 0);
  const totalHours = allEntries.reduce((s, e) => s + e.hours, 0);
  const totalAmount = allEntries.reduce((s, e) => s + e.amount, 0);
  const flaggedHours = flaggedEntries.reduce((s, e) => s + e.hours, 0);
  const flaggedAmount = flaggedEntries.reduce((s, e) => s + e.amount, 0);

  // 6. Build CSV
  function csvEscape(val: any): string {
    const s = String(val ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  const outputEntries = flaggedOnly ? flaggedEntries : allEntries;

  const csvHeaders = "Activity ID,Matter,Date,Timekeeper,Hours,Rate,Amount,Description,Flags,Severity,Flag Details,Suggested Action,Suggested Revised Description";
  const csvRows = [csvHeaders];

  for (const e of outputEntries) {
    const worstSeverity = e.flags.length > 0
      ? (e.flags.some(f => f.severity === "strike") ? "strike"
        : e.flags.some(f => f.severity === "reduce") ? "reduce"
        : e.flags.some(f => f.severity === "review") ? "review"
        : "rephrase")
      : "";

    csvRows.push([
      csvEscape(e.activity_id),
      csvEscape(e.matter_name),
      csvEscape(e.date),
      csvEscape(e.timekeeper),
      csvEscape(e.hours),
      csvEscape(e.rate),
      csvEscape(e.amount),
      csvEscape(e.note),
      csvEscape(e.flags.map(f => f.code).join(", ")),
      csvEscape(worstSeverity),
      csvEscape(e.flags.map(f => f.message).join("; ")),
      csvEscape(e.flags.filter(f => f.suggested_action).map(f => f.suggested_action).join("; ")),
      csvEscape(e.flags.filter(f => f.suggested_description).map(f => f.suggested_description).join("\n")),
    ].join(","));
  }

  return {
    summary: {
      user: entries[0]?.user?.name || "Unknown",
      date_range: `${startDate} to ${endDate}`,
      total_entries: allEntries.length,
      total_hours: Math.round(totalHours * 100) / 100,
      total_amount: Math.round(totalAmount * 100) / 100,
      flagged_entries: flaggedEntries.length,
      flagged_hours: Math.round(flaggedHours * 100) / 100,
      flagged_amount: Math.round(flaggedAmount * 100) / 100,
    },
    entries: outputEntries,
    combineGroups,
    csv: csvRows.join("\n"),
  };
}

export interface AuditEntry {
  activity_id: number;
  matter_id: number;
  matter_name: string;
  is_hc: boolean;
  date: string;
  timekeeper: string;
  user_id?: number;
  hours: number;
  rate: number;
  amount: number;
  note: string;
  flags: Flag[];
}

export interface AuditResult {
  summary: {
    user: string;
    date_range: string;
    total_entries: number;
    total_hours: number;
    total_amount: number;
    flagged_entries: number;
    flagged_hours: number;
    flagged_amount: number;
  };
  entries: AuditEntry[];
  combineGroups: CombineGroup[];
  csv: string;
}
