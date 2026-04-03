import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import https from "https";
import { fetchAllPages, rawGetSingle, rawPatchSingle, rawPostSingle } from "../clio/pagination";
import { auditTimeEntries, AuditEntry } from "../tools/auditTime";
import { detectFlags, HC_COURT_IDS, Flag } from "../tools/audit";
import { getActiveUsers, findUserById } from "../utils/userRoster";

const router = Router();
const CSV_PATH = path.join(process.cwd(), "pending.csv");

const CSV_HEADERS = "activity_id,matter_id,matter_name,date,hours,rate,current_note,suggested_note,selected_note,status";

// ---------------------------------------------------------------------------
//  CSV helpers
// ---------------------------------------------------------------------------
interface PendingRow {
  activity_id: string;
  matter_id: string;
  matter_name: string;
  date: string;
  hours: string;
  rate: string;
  timekeeper: string;
  current_note: string;
  suggested_note: string;
  selected_note: string;
  status: string; // pending | accepted | edited | skipped
  flags_json?: string; // JSON-encoded flags for the UI (not persisted to CSV)
}

function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function csvUnescape(val: string): string {
  if (val.startsWith('"') && val.endsWith('"')) {
    return val.slice(1, -1).replace(/""/g, '"');
  }
  return val;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function readCSV(): PendingRow[] {
  if (!fs.existsSync(CSV_PATH)) return [];
  const content = fs.readFileSync(CSV_PATH, "utf-8").trim();
  const lines = content.split("\n");
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const f = parseCSVLine(line);
    return {
      activity_id: f[0] || "",
      matter_id: f[1] || "",
      matter_name: f[2] || "",
      date: f[3] || "",
      hours: f[4] || "",
      rate: f[5] || "",
      current_note: f[6] || "",
      suggested_note: f[7] || "",
      selected_note: f[8] || "",
      status: f[9] || "pending",
    };
  });
}

function writeCSV(rows: PendingRow[]): void {
  const lines = [CSV_HEADERS];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.activity_id),
        csvEscape(r.matter_id),
        csvEscape(r.matter_name),
        csvEscape(r.date),
        csvEscape(r.hours),
        csvEscape(r.rate),
        csvEscape(r.current_note),
        csvEscape(r.suggested_note),
        csvEscape(r.selected_note),
        csvEscape(r.status),
      ].join(",")
    );
  }
  fs.writeFileSync(CSV_PATH, lines.join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------
//  Anthropic API call (raw HTTPS, no SDK)
// ---------------------------------------------------------------------------
async function suggestNote(
  matterName: string,
  date: string,
  hours: string,
  currentNote: string
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return currentNote || "(no suggestion — ANTHROPIC_API_KEY not set)";

  const prompt = `You are a legal billing compliance assistant for a Texas probate law firm. Your job is to IMPROVE time entry descriptions so they are specific, defensible, and clearly describe the legal work performed.

Here is a time entry to revise:
- Matter: ${matterName}
- Date: ${date}
- Hours: ${hours}
- Current description: "${currentNote || "none"}"

Rules:
1. The revised description MUST be materially different and more specific than the original. Do NOT return the same text.
2. Include WHO was involved (if a communication), WHAT specific legal task was performed, and WHY (the purpose).
3. Use active verbs: "Drafted", "Reviewed", "Analyzed", "Conferred with", "Prepared", "Researched".
4. Reference specific documents, pleadings, or legal issues when the matter name gives context.
5. 1-2 sentences max. No fluff, no filler words like "various" or "regarding matters".
6. If the current note is already excellent and specific, you may keep it but still try to improve specificity.

Return ONLY the revised description text, nothing else.`;

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    messages: [{ role: "user", content: prompt }],
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              console.error("[Review] Anthropic API error:", parsed.error);
              resolve(`[AI error: ${parsed.error.message || "unknown"}] ${currentNote}`);
              return;
            }
            const text = parsed.content?.[0]?.text;
            if (!text) {
              console.error("[Review] No text in Anthropic response:", JSON.stringify(parsed).slice(0, 300));
              resolve(`[No suggestion generated] ${currentNote}`);
              return;
            }
            resolve(text.trim());
          } catch (e) {
            console.error("[Review] Failed to parse Anthropic response:", data.slice(0, 300));
            resolve(`[Parse error] ${currentNote}`);
          }
        });
      }
    );
    req.on("error", (e) => {
      console.error("[Review] Anthropic request error:", e.message);
      resolve(`[Request error: ${e.message}] ${currentNote}`);
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
//  Audit draft bill entries for a specific user
// ---------------------------------------------------------------------------
async function auditDraftBillEntries(userId: number): Promise<{ entries: AuditEntry[]; billCount: number; matterCount: number }> {
  // First, get all matters where this user has billed time (as responsible attorney)
  const matters = await fetchAllPages<any>("/matters", {
    fields: "id,display_number,description,responsible_attorney{id},custom_field_values{id,field_name,value}",
    responsible_attorney_id: userId,
    status: "open",
  });

  const matterMap = new Map<number, { display_number: string; description: string; isHC: boolean }>();
  for (const m of matters) {
    const cfvs = m.custom_field_values || [];
    const courtField = cfvs.find((c: any) => c.field_name === "Court");
    const courtId = courtField?.value || null;
    matterMap.set(m.id, {
      display_number: m.display_number || "",
      description: m.description || "",
      isHC: courtId ? HC_COURT_IDS.has(courtId) : false,
    });
  }

  if (matterMap.size === 0) return [];

  // Get all draft bills
  const draftBills = await fetchAllPages<any>("/bills", {
    fields: "id,number,state,total,balance,matters",
    state: "draft",
  });

  // Filter to bills that belong to this attorney's matters
  const matterIds = new Set(matterMap.keys());
  const relevantBills = draftBills.filter((b: any) => {
    const billMatter = b.matters?.[0];
    return billMatter && matterIds.has(billMatter.id);
  });

  console.log(`[Review] Draft bills: ${draftBills.length} total, ${relevantBills.length} for user ${userId} (${matterMap.size} matters)`);

  const allEntries: AuditEntry[] = [];

  for (const bill of relevantBills) {
    const lineItems = await fetchAllPages<any>("/line_items", {
      fields: "id,total,type,date,description,quantity,price,bill{id,number},matter{id,display_number},user{id,name},activity{id,type,note}",
      bill_id: bill.id,
    });

    const matterId = bill.matters?.[0]?.id;
    const matterInfo = matterId ? matterMap.get(matterId) : null;
    const isHC = matterInfo?.isHC || false;

    for (const li of lineItems) {
      if (li.activity?.type !== "TimeEntry") continue;

      // Line items return quantity in HOURS (not seconds like /activities)
      // Verify: li.quantity * li.price should ≈ li.total
      let hours = li.quantity || 0;
      const rate = li.price || 0;

      // Fallback: derive hours from total/rate
      if (hours === 0 && rate > 0 && li.total) {
        hours = li.total / rate;
      }

      // Debug first 3 entries
      if (allEntries.length < 3) {
        console.log(`[Review] Entry #${allEntries.length}: li.quantity=${li.quantity}, li.price=${li.price}, li.total=${li.total}, hours=${hours}`);
      }

      const note = li.activity?.note || li.description || "";

      const flags = detectFlags(note, rate, hours, isHC, li.user?.id, matterInfo?.description || "");

      const matterName = matterInfo
        ? `${matterInfo.display_number} — ${matterInfo.description}`
        : (li.matter?.display_number || "Unknown Matter");

      allEntries.push({
        activity_id: li.activity.id,
        matter_id: matterId || 0,
        matter_name: matterName,
        is_hc: isHC,
        date: li.date,
        timekeeper: li.user?.name || "Unknown",
        user_id: li.user?.id,
        hours: Math.round(hours * 100) / 100,
        rate,
        amount: Math.round((li.total || 0) * 100) / 100,
        note,
        flags,
      });
    }

    if (relevantBills.indexOf(bill) < relevantBills.length - 1) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`[Review] Total entries for user ${userId}: ${allEntries.length}`);
  return { entries: allEntries, billCount: relevantBills.length, matterCount: matterMap.size };
}

// ---------------------------------------------------------------------------
//  Auth — simple password gate via cookie
// ---------------------------------------------------------------------------
function isAuthenticated(req: Request): boolean {
  const pw = process.env.REVIEW_PASSWORD || "";
  if (!pw) return true; // no password set = open access
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/review_auth=([^;]+)/);
  return match?.[1] === "granted";
}

router.post("/review/login", (req: Request, res: Response) => {
  const { password } = req.body || {};
  const expectedPw = process.env.REVIEW_PASSWORD || "";
  if (password === expectedPw && expectedPw !== "") {
    res.setHeader("Set-Cookie", "review_auth=granted; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400");
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: "Wrong password" });
  }
});

// ---------------------------------------------------------------------------
//  GET /review?user_id=&start=&end=
// ---------------------------------------------------------------------------
router.get("/review", async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) {
    res.setHeader("Content-Type", "text/html");
    res.send(buildLoginHTML());
    return;
  }

  const userId = req.query.user_id as string;
  const start = req.query.start as string;
  const end = req.query.end as string;
  const scope = (req.query.scope as string) || "all"; // "all" | "draft_bills"

  if (!userId) {
    res.setHeader("Content-Type", "text/html");
    res.send(buildLandingHTML());
    return;
  }

  const startDate = start || new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];
  const endDate = end || new Date().toISOString().split("T")[0];

  try {
    let auditEntries: AuditEntry[];
    let billCount = 0;
    let matterCount = 0;

    if (scope === "draft_bills") {
      const draftResult = await auditDraftBillEntries(Number(userId));
      auditEntries = draftResult.entries;
      billCount = draftResult.billCount;
      matterCount = draftResult.matterCount;
    } else {
      const result = await auditTimeEntries(Number(userId), startDate, endDate);
      auditEntries = result.entries;
    }

    // Convert flagged audit entries to pending rows (skip clean entries)
    const rows: PendingRow[] = [];
    const totalEntries = auditEntries.length;
    const flaggedEntries = auditEntries.filter(e => e.flags.length > 0);
    for (const e of flaggedEntries) {
      // Build suggested note from flags
      const suggestedDescriptions = e.flags
        .filter(f => f.suggested_description)
        .map(f => f.suggested_description);
      const suggestedActions = e.flags
        .filter(f => f.suggested_action)
        .map(f => f.suggested_action);

      let suggested = "";
      if (suggestedDescriptions.length > 0) {
        suggested = suggestedDescriptions[0]!;
      } else if (suggestedActions.length > 0) {
        suggested = suggestedActions.join("; ");
      } else if (e.flags.length > 0) {
        suggested = e.flags.map(f => f.message).join("; ");
      } else {
        suggested = e.note; // clean entry — no changes needed
      }

      rows.push({
        activity_id: String(e.activity_id),
        matter_id: String(e.matter_id),
        matter_name: e.matter_name,
        date: e.date,
        hours: e.hours.toFixed(2),
        rate: e.rate.toFixed(2),
        timekeeper: e.timekeeper,
        current_note: e.note,
        suggested_note: suggested,
        selected_note: "",
        status: "pending",
        flags_json: JSON.stringify(e.flags.map(f => {
          const obj: any = { code: f.code, severity: f.severity, message: f.message };
          // For BLOCK_BILL, include split tasks for the UI
          if (f.code === "BLOCK_BILL" && f.suggested_description) {
            const taskLines = f.suggested_description.split("\n").filter(l => l.trim());
            const taskCount = taskLines.length || 1;
            const perTaskHours = Math.round((e.hours / taskCount) * 100) / 100;
            obj.split_tasks = taskLines.map((line: string) => ({
              description: line.replace(/^Entry \d+:\s*/, ""),
              hours: perTaskHours,
            }));
          }
          return obj;
        })),
      });
    }

    // 3. Write CSV
    writeCSV(rows);

    // 4. Serve HTML
    res.setHeader("Content-Type", "text/html");
    const userName = findUserById(Number(userId))?.name || `User ${userId}`;
    const totalAmount = Math.round(auditEntries.reduce((s, e) => s + e.amount, 0) * 100) / 100;
    const flaggedAmount = Math.round(flaggedEntries.reduce((s, e) => s + e.amount, 0) * 100) / 100;
    const fmt = (n: number) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

    let subtitle = `${userName} &middot; `;
    if (scope === "draft_bills") {
      subtitle += `${billCount} draft bills &middot; ${matterCount} matters &middot; `;
    } else {
      subtitle += `${startDate} to ${endDate} &middot; `;
    }
    subtitle += `${rows.length} flagged of ${totalEntries} entries`;
    subtitle += ` &middot; $${fmt(totalAmount)} total &middot; $${fmt(flaggedAmount)} flagged`;

    res.send(buildHTML(rows, startDate, endDate, subtitle));
  } catch (err: any) {
    console.error("[Review] Error:", err.message, err.response?.status, err.response?.data);
    res.status(500).send(`Error: ${err.message}${err.response?.status ? ` (Clio status: ${err.response.status})` : ''}`);
  }
});

// ---------------------------------------------------------------------------
//  POST /pending  — update a single row
// ---------------------------------------------------------------------------
router.post("/pending", (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.status(401).json({ ok: false, error: "Not authenticated" }); return; }
  const { activity_id, selected_note, status } = req.body || {};
  if (!activity_id || !status) {
    res.status(400).json({ ok: false, error: "activity_id and status required" });
    return;
  }

  const rows = readCSV();
  const row = rows.find((r) => r.activity_id === String(activity_id));
  if (!row) {
    res.status(404).json({ ok: false, error: "activity_id not found in pending.csv" });
    return;
  }

  row.status = status;
  row.selected_note = selected_note || "";
  writeCSV(rows);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  POST /pending/split — split a block-billed entry into multiple entries
// ---------------------------------------------------------------------------
router.post("/pending/split", async (req: Request, res: Response) => {
  if (!isAuthenticated(req)) { res.status(401).json({ ok: false, error: "Not authenticated" }); return; }

  const { activity_id, tasks } = req.body || {};
  // tasks: [{ description: string, hours: number }]

  if (!activity_id || !tasks || !Array.isArray(tasks) || tasks.length === 0) {
    res.status(400).json({ ok: false, error: "activity_id and tasks[] required" });
    return;
  }

  try {
    // 1. Read the original activity to get matter, date, user, rate
    const original = await rawGetSingle(`/activities/${activity_id}`, {
      fields: "id,date,quantity,price,note,matter{id},user{id}",
    });
    const act = original.data;
    const matterId = act.matter?.id;
    const userId = act.user?.id;
    const date = act.date;
    const rate = act.price || 0;

    if (!matterId || !userId) {
      res.status(400).json({ ok: false, error: "Could not read matter or user from original entry" });
      return;
    }

    // 2. Create new entries for each task
    const created: any[] = [];
    for (const task of tasks) {
      const quantitySeconds = Math.round((task.hours || 0) * 3600);
      const result = await rawPostSingle("/activities", {
        data: {
          type: "TimeEntry",
          date,
          note: task.description,
          quantity: quantitySeconds,
          price: rate,
          matter: { id: matterId },
          user: { id: userId },
        },
      });
      created.push({
        id: result.data?.id,
        description: task.description,
        hours: task.hours,
      });
    }

    // 3. Zero out the original entry
    await rawPatchSingle(`/activities/${activity_id}`, {
      data: {
        quantity: 0,
        note: `[SPLIT into ${created.length} entries] ${act.note || ""}`,
      },
    });

    // 4. Update CSV status
    const rows = readCSV();
    const row = rows.find((r) => r.activity_id === String(activity_id));
    if (row) {
      row.status = "accepted";
      row.selected_note = `Split into ${created.length} entries`;
      writeCSV(rows);
    }

    res.json({
      ok: true,
      original_zeroed: activity_id,
      created,
    });
  } catch (err: any) {
    console.error("[Review] Split error:", err.message, err.response?.status, err.response?.data);
    res.status(500).json({
      ok: false,
      error: err.message,
      clio_status: err.response?.status,
    });
  }
});

// ---------------------------------------------------------------------------
//  POST /pending/apply — apply accepted/edited entries to Clio
// ---------------------------------------------------------------------------
router.post("/pending/apply", async (_req: Request, res: Response) => {
  if (!isAuthenticated(_req)) { res.status(401).json({ ok: false, error: "Not authenticated" }); return; }
  try {
    const rows = readCSV();
    const toApply = rows.filter((r) => r.status === "accepted" || r.status === "edited");
    const skipped = rows.filter((r) => r.status === "skipped" || r.status === "pending").length;

    let patched = 0;
    const errors: string[] = [];

    for (const row of toApply) {
      try {
        await rawPatchSingle(`/activities/${row.activity_id}`, {
          data: { note: row.selected_note },
        });
        patched++;
      } catch (err: any) {
        errors.push(`Activity ${row.activity_id}: ${err.message}`);
      }
    }

    // Clear CSV after apply
    if (errors.length === 0) {
      writeCSV([]);
    }

    res.json({ patched, skipped, errors });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
//  Exported helpers for the MCP tool
// ---------------------------------------------------------------------------
export { readCSV, writeCSV, PendingRow, CSV_PATH };

// ---------------------------------------------------------------------------
//  HTML builder
// ---------------------------------------------------------------------------
function buildHTML(rows: PendingRow[], startDate: string, endDate: string, subtitle: string): string {
  const rowsJSON = JSON.stringify(rows).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Time Entry Review</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Lora', Georgia, 'Times New Roman', serif;
    background: #faf9f7;
    color: #1a1a1a;
    min-height: 100vh;
    padding: 0;
  }

  .header {
    background: #1b2a3d;
    border-bottom: 2px solid #c9a84c;
    padding: 28px 32px;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header h1 {
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 26px;
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 4px;
    letter-spacing: 0.02em;
  }

  .header .subtitle {
    font-size: 13px;
    color: #c9cdd5;
    letter-spacing: 0.01em;
  }

  .progress-wrap {
    margin-top: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .progress-bar {
    flex: 1;
    height: 4px;
    background: #2a3a50;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: #c9a84c;
    transition: width 0.4s ease;
    width: 0%;
  }

  .progress-text {
    font-size: 13px;
    color: #c9a84c;
    font-weight: 600;
    min-width: 90px;
    text-align: right;
  }

  .container {
    max-width: 820px;
    margin: 0 auto;
    padding: 24px 20px 120px;
  }

  .card {
    background: #ffffff;
    border: 1px solid #d4d0c8;
    border-radius: 2px;
    margin-bottom: 14px;
    overflow: hidden;
    transition: all 0.3s ease;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }

  .card.done {
    opacity: 0.5;
  }

  .card.done .card-body { display: none; }

  .card-header {
    padding: 14px 20px;
    border-bottom: 1px solid #e8e5df;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    background: #f8f7f5;
  }

  .card.done .card-header {
    border-bottom: none;
  }

  .matter-name {
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 16px;
    font-weight: 700;
    color: #1b2a3d;
    line-height: 1.4;
  }

  .meta-row {
    display: flex;
    gap: 16px;
    margin-top: 4px;
    font-size: 12px;
    color: #7a7568;
  }

  .meta-row span { display: flex; align-items: center; gap: 4px; }

  .flag-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 12px 0 8px;
  }

  .flag-tag {
    display: inline-block;
    font-family: 'Lora', Georgia, serif;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 3px 8px;
    border-radius: 2px;
    cursor: default;
  }

  .status-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 2px;
    white-space: nowrap;
    display: none;
  }

  .card.done .status-badge { display: inline-block; }

  .status-badge.accepted { background: #d1fae5; color: #065f46; }
  .status-badge.edited { background: #dbeafe; color: #1e40af; }
  .status-badge.skipped { background: #e8e5df; color: #7a7568; }

  .card-body { padding: 20px; }

  .note-section { margin-bottom: 16px; }

  .note-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }

  .note-label.current { color: #7a7568; }
  .note-label.suggested { color: #1b2a3d; }

  .note-box {
    padding: 12px 14px;
    border-radius: 2px;
    font-size: 13px;
    line-height: 1.7;
  }

  .note-box.current {
    background: #f5f4f1;
    color: #7a7568;
    border: 1px solid #e8e5df;
  }

  .note-box.suggested {
    background: #f0ede6;
    color: #1a1a1a;
    border: 1px solid #c9a84c;
    border-left: 3px solid #c9a84c;
  }

  .edit-area {
    display: none;
    margin-top: 12px;
  }

  .edit-area textarea {
    width: 100%;
    min-height: 80px;
    background: #ffffff;
    border: 2px solid #1b2a3d;
    border-radius: 2px;
    color: #1a1a1a;
    font-family: 'Lora', Georgia, serif;
    font-size: 13px;
    line-height: 1.7;
    padding: 12px 14px;
    resize: vertical;
    outline: none;
  }

  .edit-area textarea:focus { border-color: #c9a84c; }

  .edit-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    justify-content: flex-end;
  }

  .actions {
    display: flex;
    gap: 8px;
    padding-top: 8px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border: none;
    border-radius: 2px;
    font-family: 'Lora', Georgia, serif;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn:hover { transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }

  .btn-accept {
    background: #1b2a3d;
    color: #fff;
  }
  .btn-accept:hover { background: #263b52; }

  .btn-edit {
    background: #c9a84c;
    color: #1b2a3d;
  }
  .btn-edit:hover { background: #b8973f; }

  .btn-skip {
    background: #e8e5df;
    color: #7a7568;
  }
  .btn-skip:hover { background: #d4d0c8; }

  .btn-save {
    background: #1b2a3d;
    color: #fff;
  }

  .btn-cancel {
    background: #e8e5df;
    color: #7a7568;
  }

  .btn-sm { padding: 6px 12px; font-size: 12px; }

  .apply-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: #1b2a3d;
    border-top: 2px solid #c9a84c;
    padding: 16px 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    z-index: 100;
  }

  .apply-stats {
    font-size: 13px;
    color: #c9cdd5;
  }

  .apply-stats strong { color: #c9a84c; }

  .btn-apply {
    background: #c9a84c;
    color: #1b2a3d;
    padding: 12px 28px;
    font-size: 14px;
    border-radius: 2px;
    font-weight: 700;
    font-family: 'Cormorant Garamond', Georgia, serif;
    letter-spacing: 0.03em;
  }

  .btn-apply:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none !important;
  }

  .btn-apply:not(:disabled):hover {
    background: #b8973f;
  }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: #7a7568;
  }

  .empty-state h2 {
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 20px;
    color: #1b2a3d;
    margin-bottom: 8px;
  }

  .applying-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(27, 42, 61, 0.85);
    z-index: 200;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    gap: 16px;
  }

  .applying-overlay.show { display: flex; }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid #2a3a50;
    border-top-color: #c9a84c;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .applying-text { font-size: 14px; color: #c9cdd5; }

  .result-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(27, 42, 61, 0.85);
    z-index: 200;
    justify-content: center;
    align-items: center;
  }

  .result-overlay.show { display: flex; }

  .result-card {
    background: #ffffff;
    border: 1px solid #d4d0c8;
    border-radius: 2px;
    padding: 32px 40px;
    text-align: center;
    max-width: 400px;
  }

  .result-card h2 { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 22px; color: #1b2a3d; margin-bottom: 12px; }
  .result-card p { font-size: 14px; color: #7a7568; line-height: 1.6; }
  .result-card .btn { margin-top: 20px; }
</style>
</head>
<body>

<div class="header">
  <h1>Time Entry Review</h1>
  <div class="subtitle">${subtitle}</div>
  <div class="progress-wrap">
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    <div class="progress-text" id="progressText">0 of ${rows.length}</div>
  </div>
</div>

<div class="container" id="cards"></div>

<div class="apply-bar">
  <div class="apply-stats" id="applyStats">No entries reviewed yet</div>
  <button class="btn btn-apply" id="applyBtn" disabled onclick="applyAll()">Apply All Changes</button>
</div>

<div class="applying-overlay" id="applyingOverlay">
  <div class="spinner"></div>
  <div class="applying-text" id="applyingText">Applying changes...</div>
</div>

<div class="result-overlay" id="resultOverlay">
  <div class="result-card" id="resultCard"></div>
</div>

<script>
const entries = ${rowsJSON};
const state = {};
entries.forEach(e => { state[e.activity_id] = { status: 'pending', selected_note: '' }; });

function render() {
  const container = document.getElementById('cards');
  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-state"><h2>No time entries found</h2><p>No entries matched the date range.</p></div>';
    return;
  }

  container.innerHTML = entries.map((e, i) => {
    const s = state[e.activity_id];
    const isDone = s.status !== 'pending';
    const flags = e.flags_json ? JSON.parse(e.flags_json) : [];
    const flagTags = flags.map(f => {
      const colors = {
        strike: 'background:#991b1b;color:#fecaca',
        reduce: 'background:#92400e;color:#fde68a',
        review: 'background:#854d0e;color:#fef08a',
        rephrase: 'background:#1e3a5f;color:#7dd3fc',
      };
      const style = colors[f.severity] || 'background:#374151;color:#9ca3af';
      return '<span class="flag-tag" style="' + style + '" title="' + esc(f.message) + '">' + esc(f.code) + '</span>';
    }).join(' ');
    return \`
    <div class="card \${isDone ? 'done' : ''}" id="card-\${e.activity_id}">
      <div class="card-header">
        <div>
          <div class="matter-name">\${esc(e.matter_name)}</div>
          <div class="meta-row">
            <span><strong>\${esc(e.timekeeper)}</strong></span>
            <span>\${e.date}</span>
            <span>\${e.hours} hrs</span>
            <span>$\${e.rate}/hr</span>
          </div>
        </div>
        <span class="status-badge \${s.status}">\${
          s.status === 'accepted' ? '\u2713 Accepted' :
          s.status === 'edited' ? '\u270E Edited' :
          s.status === 'skipped' ? 'Skipped' : ''
        }</span>
      </div>
      <div class="card-body">\${flags.length > 0 ? '<div class="flag-row">' + flagTags + '</div>' : '<div class="flag-row"><span class="flag-tag" style="background:#064e3b;color:#6ee7b7">CLEAN</span></div>'}
        <div class="note-section">
          <div class="note-label current">Current</div>
          <div class="note-box current">\${esc(e.current_note) || '<em style="opacity:0.5">No description</em>'}</div>
        </div>
        <div class="note-section">
          <div class="note-label suggested">\${flags.length > 0 ? 'Suggested Revision' : 'No Changes Needed'}</div>
          <div class="note-box suggested">\${esc(e.suggested_note)}</div>
        </div>
        <div class="edit-area" id="edit-\${e.activity_id}">
          <textarea id="textarea-\${e.activity_id}">\${esc(e.suggested_note)}</textarea>
          <div class="edit-actions">
            <button class="btn btn-cancel btn-sm" onclick="cancelEdit('\${e.activity_id}')">Cancel</button>
            <button class="btn btn-save btn-sm" onclick="saveEdit('\${e.activity_id}')">Save Edit</button>
          </div>
        </div>\${buildSplitUI(e, flags)}
        <div class="actions" id="actions-\${e.activity_id}">\${
          hasBlockBill(flags)
            ? '<button class="btn btn-accept" onclick="showSplit(\\'' + e.activity_id + '\\')">\\u2702 Split Entries</button>'
            : '<button class="btn btn-accept" onclick="accept(\\'' + e.activity_id + '\\')">\\u2713 Accept</button>'
        }
          <button class="btn btn-edit" onclick="startEdit('\${e.activity_id}')">\\u270E Edit</button>
          <button class="btn btn-skip" onclick="skip('\${e.activity_id}')">\\u2717 Skip</button>
        </div>
      </div>
    </div>\`;
  }).join('');
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function hasBlockBill(flags) {
  return flags.some(f => f.code === 'BLOCK_BILL' && f.split_tasks && f.split_tasks.length > 0);
}

function buildSplitUI(e, flags) {
  const bb = flags.find(f => f.code === 'BLOCK_BILL' && f.split_tasks);
  if (!bb) return '';
  const tasks = bb.split_tasks;
  const rows = tasks.map((t, i) =>
    '<div class="split-row" style="display:flex;gap:8px;margin-bottom:8px;align-items:start">' +
      '<input type="number" step="0.1" min="0" value="' + t.hours + '" ' +
        'id="split-hrs-' + e.activity_id + '-' + i + '" ' +
        'style="width:70px;padding:8px;background:#f8f7f5;border:1px solid #d4d0c8;border-radius:2px;font-family:Lora,Georgia,serif;font-size:13px;color:#1a1a1a">' +
      '<span style="padding-top:8px;color:#7a7568;font-size:12px">hrs</span>' +
      '<textarea id="split-desc-' + e.activity_id + '-' + i + '" ' +
        'style="flex:1;padding:8px;min-height:50px;background:#f8f7f5;border:1px solid #d4d0c8;border-radius:2px;font-family:Lora,Georgia,serif;font-size:13px;color:#1a1a1a;resize:vertical">' +
        esc(t.description) + '</textarea>' +
    '</div>'
  ).join('');

  return '<div class="split-area" id="split-' + e.activity_id + '" style="display:none;margin-top:12px;padding:16px;background:#f8f7f5;border:1px solid #d4d0c8;border-radius:2px">' +
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#1b2a3d;margin-bottom:10px">Split into ' + tasks.length + ' entries (total: ' + e.hours + ' hrs)</div>' +
    rows +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">' +
      '<button class="btn btn-cancel btn-sm" onclick="hideSplit(\\'' + e.activity_id + '\\')">Cancel</button>' +
      '<button class="btn btn-accept btn-sm" onclick="applySplit(\\'' + e.activity_id + '\\',' + tasks.length + ')">Apply Split</button>' +
    '</div>' +
  '</div>';
}

function showSplit(id) {
  document.getElementById('split-' + id).style.display = 'block';
  document.getElementById('actions-' + id).style.display = 'none';
}

function hideSplit(id) {
  document.getElementById('split-' + id).style.display = 'none';
  document.getElementById('actions-' + id).style.display = 'flex';
}

async function applySplit(id, taskCount) {
  const tasks = [];
  for (let i = 0; i < taskCount; i++) {
    const hrs = parseFloat(document.getElementById('split-hrs-' + id + '-' + i).value) || 0;
    const desc = document.getElementById('split-desc-' + id + '-' + i).value.trim();
    if (desc) tasks.push({ description: desc, hours: hrs });
  }
  if (tasks.length === 0) return;

  // Disable buttons
  const splitArea = document.getElementById('split-' + id);
  splitArea.querySelectorAll('button').forEach(b => b.disabled = true);
  splitArea.querySelector('.btn-accept').textContent = 'Splitting...';

  try {
    const res = await fetch('/pending/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activity_id: id, tasks }),
    });
    const data = await res.json();
    if (data.ok) {
      state[id] = { status: 'accepted', selected_note: 'Split into ' + data.created.length + ' entries' };
      render();
      updateProgress();
    } else {
      alert('Split failed: ' + (data.error || 'Unknown error'));
      splitArea.querySelectorAll('button').forEach(b => b.disabled = false);
      splitArea.querySelector('.btn-accept').textContent = 'Apply Split';
    }
  } catch (err) {
    alert('Split error: ' + err.message);
    splitArea.querySelectorAll('button').forEach(b => b.disabled = false);
    splitArea.querySelector('.btn-accept').textContent = 'Apply Split';
  }
}

function updateProgress() {
  const total = entries.length;
  const reviewed = Object.values(state).filter(s => s.status !== 'pending').length;
  const accepted = Object.values(state).filter(s => s.status === 'accepted').length;
  const edited = Object.values(state).filter(s => s.status === 'edited').length;
  const skipped = Object.values(state).filter(s => s.status === 'skipped').length;

  const pct = total > 0 ? (reviewed / total) * 100 : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = reviewed + ' of ' + total;

  const parts = [];
  if (accepted) parts.push('<strong>' + accepted + ' accepted</strong>');
  if (edited) parts.push(edited + ' edited');
  if (skipped) parts.push(skipped + ' skipped');
  document.getElementById('applyStats').innerHTML = parts.length ? parts.join(' &middot; ') : 'No entries reviewed yet';

  document.getElementById('applyBtn').disabled = (accepted + edited) === 0;
}

async function postUpdate(activityId, selectedNote, status) {
  await fetch('/pending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activity_id: activityId, selected_note: selectedNote, status }),
  });
}

function accept(id) {
  const entry = entries.find(e => e.activity_id === id);
  state[id] = { status: 'accepted', selected_note: entry.suggested_note };
  postUpdate(id, entry.suggested_note, 'accepted');
  render();
  updateProgress();
}

function skip(id) {
  state[id] = { status: 'skipped', selected_note: '' };
  postUpdate(id, '', 'skipped');
  render();
  updateProgress();
}

function startEdit(id) {
  document.getElementById('edit-' + id).style.display = 'block';
  document.getElementById('actions-' + id).style.display = 'none';
  document.getElementById('textarea-' + id).focus();
}

function cancelEdit(id) {
  document.getElementById('edit-' + id).style.display = 'none';
  document.getElementById('actions-' + id).style.display = 'flex';
}

function saveEdit(id) {
  const text = document.getElementById('textarea-' + id).value.trim();
  if (!text) return;
  state[id] = { status: 'edited', selected_note: text };
  postUpdate(id, text, 'edited');
  render();
  updateProgress();
}

async function applyAll() {
  const overlay = document.getElementById('applyingOverlay');
  const text = document.getElementById('applyingText');
  overlay.classList.add('show');

  try {
    const res = await fetch('/pending/apply', { method: 'POST' });
    const data = await res.json();
    overlay.classList.remove('show');

    const rc = document.getElementById('resultCard');
    rc.innerHTML = \`
      <h2>\${data.errors && data.errors.length ? '\u26A0\uFE0F Completed with errors' : '\u2705 All changes applied!'}</h2>
      <p>\${data.patched || 0} entries updated in Clio<br>\${data.skipped || 0} entries skipped\${data.errors && data.errors.length ? '<br>' + data.errors.length + ' errors' : ''}</p>
      <button class="btn btn-apply" onclick="location.reload()">Done</button>
    \`;
    document.getElementById('resultOverlay').classList.add('show');
  } catch (err) {
    overlay.classList.remove('show');
    alert('Error applying changes: ' + err.message);
  }
}

render();
updateProgress();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
//  Landing page — user picker
// ---------------------------------------------------------------------------
function buildLoginHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Time Entry Review — Login</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Lora', Georgia, 'Times New Roman', serif;
    background: #faf9f7;
    color: #1a1a1a;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .panel {
    background: #ffffff;
    border: 1px solid #d4d0c8;
    border-top: 3px solid #1b2a3d;
    border-radius: 2px;
    padding: 40px;
    width: 100%;
    max-width: 380px;
    text-align: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  }
  h1 { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; font-weight: 700; color: #1b2a3d; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #7a7568; margin-bottom: 28px; }
  input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    background: #f8f7f5;
    border: 1px solid #d4d0c8;
    border-radius: 2px;
    color: #1a1a1a;
    font-family: 'Lora', Georgia, serif;
    font-size: 14px;
    margin-bottom: 16px;
    outline: none;
    text-align: center;
  }
  input[type="password"]:focus { border-color: #c9a84c; }
  .btn {
    display: block;
    width: 100%;
    padding: 12px;
    background: #1b2a3d;
    color: #fff;
    border: none;
    border-radius: 2px;
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
    letter-spacing: 0.03em;
  }
  .btn:hover { background: #263b52; }
  .error { color: #991b1b; font-size: 13px; margin-top: 12px; display: none; }
  .error.show { display: block; }
</style>
</head>
<body>
<div class="panel">
  <h1>Time Entry Review</h1>
  <div class="sub">Enter password to continue</div>
  <form onsubmit="login(event)">
    <input type="password" id="pw" placeholder="Password" autofocus required>
    <button type="submit" class="btn">Sign In</button>
  </form>
  <div class="error" id="err">Incorrect password</div>
</div>
<script>
async function login(e) {
  e.preventDefault();
  const pw = document.getElementById('pw').value;
  const res = await fetch('/review/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  if (res.ok) {
    window.location.reload();
  } else {
    document.getElementById('err').classList.add('show');
    document.getElementById('pw').value = '';
    document.getElementById('pw').focus();
  }
}
</script>
</body>
</html>`;
}

function buildLandingHTML(): string {
  const users = getActiveUsers();
  const today = new Date().toISOString().split("T")[0];
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];

  const userOptions = users
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => `<option value="${u.id}">${u.name} (${u.role})</option>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Time Entry Review</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=Lora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Lora', Georgia, 'Times New Roman', serif;
    background: #faf9f7;
    color: #1a1a1a;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .panel {
    background: #ffffff;
    border: 1px solid #d4d0c8;
    border-top: 3px solid #1b2a3d;
    border-radius: 2px;
    padding: 40px;
    width: 100%;
    max-width: 440px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  }
  h1 { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; font-weight: 700; color: #1b2a3d; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #7a7568; margin-bottom: 28px; }
  label {
    display: block;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #7a7568;
    margin-bottom: 6px;
  }
  select, input[type="date"] {
    width: 100%;
    padding: 10px 14px;
    background: #f8f7f5;
    border: 1px solid #d4d0c8;
    border-radius: 2px;
    color: #1a1a1a;
    font-family: 'Lora', Georgia, serif;
    font-size: 14px;
    margin-bottom: 20px;
    outline: none;
  }
  select:focus, input[type="date"]:focus { border-color: #c9a84c; }
  .date-row { display: flex; gap: 12px; }
  .date-row > div { flex: 1; }
  .btn {
    display: block;
    width: 100%;
    padding: 12px;
    background: #1b2a3d;
    color: #fff;
    border: none;
    border-radius: 2px;
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
    margin-top: 8px;
    transition: all 0.15s;
    letter-spacing: 0.03em;
  }
  .btn:hover { background: #263b52; }
  .loading { display: none; text-align: center; color: #7a7568; font-size: 13px; margin-top: 16px; }
  .loading.show { display: block; }
</style>
</head>
<body>
<div class="panel">
  <h1>Time Entry Review</h1>
  <div class="sub">Select a team member and date range to review their time entries with AI-suggested revisions.</div>

  <form id="reviewForm" onsubmit="go(event)">
    <label for="user">Team Member</label>
    <select id="user" required>
      <option value="">Select a person...</option>
      ${userOptions}
    </select>

    <label for="scope">Scope</label>
    <select id="scope" onchange="toggleDates()">
      <option value="all">All time entries in date range</option>
      <option value="draft_bills">Only entries on draft bills</option>
    </select>

    <div class="date-row" id="dateRow">
      <div>
        <label for="start">Start Date</label>
        <input type="date" id="start" value="${twoWeeksAgo}">
      </div>
      <div>
        <label for="end">End Date</label>
        <input type="date" id="end" value="${today}">
      </div>
    </div>

    <button type="submit" class="btn">Review Entries</button>
  </form>
  <div class="loading" id="loading">Loading entries and generating suggestions... this may take a moment.</div>
</div>
<script>
function toggleDates() {
  const scope = document.getElementById('scope').value;
  document.getElementById('dateRow').style.display = scope === 'draft_bills' ? 'none' : 'flex';
}

function go(e) {
  e.preventDefault();
  const uid = document.getElementById('user').value;
  const scope = document.getElementById('scope').value;
  if (!uid) return;
  document.getElementById('loading').classList.add('show');
  let url = '/review?user_id=' + uid + '&scope=' + scope;
  if (scope !== 'draft_bills') {
    url += '&start=' + document.getElementById('start').value + '&end=' + document.getElementById('end').value;
  }
  window.location.href = url;
}
</script>
</body>
</html>`;
}

export default router;
