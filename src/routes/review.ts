import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import https from "https";
import { fetchAllPages, rawGetSingle, rawPatchSingle } from "../clio/pagination";
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
  current_note: string;
  suggested_note: string;
  selected_note: string;
  status: string; // pending | accepted | edited | skipped
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

  const prompt = `You are a legal billing assistant. Generate a concise, specific time entry description (1-2 sentences, no fluff) for a Texas probate attorney based on: Matter: ${matterName} | Date: ${date} | Hours: ${hours} | Existing note: ${currentNote || "none"}. Return only the description text.`;

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
            const text = parsed.content?.[0]?.text || currentNote || "";
            resolve(text.trim());
          } catch {
            resolve(currentNote || "(suggestion generation failed)");
          }
        });
      }
    );
    req.on("error", () => resolve(currentNote || "(suggestion generation failed)"));
    req.write(body);
    req.end();
  });
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
    let entries: any[];

    if (scope === "draft_bills") {
      // Fetch draft bills, then pull line items to get activity IDs for this user
      const draftBills = await fetchAllPages<any>("/bills", {
        fields: "id,number,state,matters{id,display_number,description}",
        state: "draft",
      });

      entries = [];
      for (const bill of draftBills) {
        const lineItems = await fetchAllPages<any>("/line_items", {
          fields: "id,date,quantity,price,description,bill{id},matter{id,display_number,description},user{id,name},activity{id,type,note}",
          bill_id: bill.id,
        });

        for (const li of lineItems) {
          if (li.activity?.type !== "TimeEntry") continue;
          if (String(li.user?.id) !== String(userId)) continue;

          const matter = li.matter || bill.matters?.[0] || {};
          entries.push({
            id: li.activity.id,
            date: li.date,
            quantity: li.quantity,
            price: li.price,
            note: li.activity?.note || li.description || "",
            matter: {
              id: matter.id,
              display_number: matter.display_number,
              description: matter.description,
            },
            user: li.user,
          });
        }

        // Courtesy delay
        if (draftBills.indexOf(bill) < draftBills.length - 1) {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      // No date filter for draft bills — show all entries on current drafts
    } else {
      // All time entries for user in date range
      const queryParams: Record<string, any> = {
        type: "TimeEntry",
        fields: "id,date,quantity,price,note,matter{id,display_number,description},user{id,name}",
        user_id: userId,
        created_since: `${startDate}T00:00:00+00:00`,
      };
      entries = await fetchAllPages<any>("/activities", queryParams);
      entries = entries.filter((e: any) => e.date >= startDate && e.date <= endDate);
    }

    // 2. Generate suggestions for each entry
    const rows: PendingRow[] = [];
    for (const e of entries) {
      const matterName = e.matter
        ? `${e.matter.display_number} — ${e.matter.description || ""}`
        : "Unknown Matter";
      const hours = (e.quantity / 3600).toFixed(2);
      const rate = (e.price || 0).toFixed(2);
      const currentNote = e.note || "";

      const suggested = await suggestNote(matterName, e.date, hours, currentNote);

      rows.push({
        activity_id: String(e.id),
        matter_id: String(e.matter?.id || ""),
        matter_name: matterName,
        date: e.date,
        hours,
        rate,
        current_note: currentNote,
        suggested_note: suggested,
        selected_note: "",
        status: "pending",
      });
    }

    // 3. Write CSV
    writeCSV(rows);

    // 4. Serve HTML
    res.setHeader("Content-Type", "text/html");
    const userName = findUserById(Number(userId))?.name || `User ${userId}`;
    const scopeLabel = scope === "draft_bills" ? "Draft Bills Only" : "All Entries";
    res.send(buildHTML(rows, startDate, endDate, userName, scopeLabel));
  } catch (err: any) {
    res.status(500).send(`Error: ${err.message}`);
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
function buildHTML(rows: PendingRow[], startDate: string, endDate: string, userName: string, scopeLabel: string): string {
  const rowsJSON = JSON.stringify(rows).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Time Entry Review</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: #0f1117;
    color: #e2e8f0;
    min-height: 100vh;
    padding: 0;
  }

  .header {
    background: linear-gradient(135deg, #1a1d2e 0%, #0f1117 100%);
    border-bottom: 1px solid #2d3348;
    padding: 28px 32px;
    position: sticky;
    top: 0;
    z-index: 100;
    backdrop-filter: blur(12px);
  }

  .header h1 {
    font-size: 22px;
    font-weight: 700;
    color: #f8fafc;
    margin-bottom: 4px;
  }

  .header .subtitle {
    font-size: 13px;
    color: #94a3b8;
  }

  .progress-wrap {
    margin-top: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .progress-bar {
    flex: 1;
    height: 6px;
    background: #1e2235;
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #6366f1, #818cf8);
    border-radius: 3px;
    transition: width 0.4s ease;
    width: 0%;
  }

  .progress-text {
    font-size: 13px;
    color: #818cf8;
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
    background: #1a1d2e;
    border: 1px solid #2d3348;
    border-radius: 12px;
    margin-bottom: 16px;
    overflow: hidden;
    transition: all 0.35s ease;
  }

  .card.done {
    opacity: 0.5;
    transform: scale(0.98);
  }

  .card.done .card-body { display: none; }

  .card-header {
    padding: 16px 20px;
    border-bottom: 1px solid #2d3348;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }

  .card.done .card-header {
    border-bottom: none;
  }

  .matter-name {
    font-size: 14px;
    font-weight: 600;
    color: #f1f5f9;
    line-height: 1.4;
  }

  .meta-row {
    display: flex;
    gap: 16px;
    margin-top: 6px;
    font-size: 12px;
    color: #94a3b8;
  }

  .meta-row span { display: flex; align-items: center; gap: 4px; }

  .status-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 20px;
    white-space: nowrap;
    display: none;
  }

  .card.done .status-badge { display: inline-block; }

  .status-badge.accepted { background: #064e3b; color: #6ee7b7; }
  .status-badge.edited { background: #1e3a5f; color: #7dd3fc; }
  .status-badge.skipped { background: #374151; color: #9ca3af; }

  .card-body { padding: 20px; }

  .note-section { margin-bottom: 16px; }

  .note-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }

  .note-label.current { color: #64748b; }
  .note-label.suggested { color: #818cf8; }

  .note-box {
    padding: 12px 14px;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.6;
  }

  .note-box.current {
    background: #111322;
    color: #64748b;
    border: 1px solid #1e2235;
  }

  .note-box.suggested {
    background: #1e1b4b;
    color: #c7d2fe;
    border: 1px solid #312e81;
  }

  .edit-area {
    display: none;
    margin-top: 12px;
  }

  .edit-area textarea {
    width: 100%;
    min-height: 80px;
    background: #111322;
    border: 2px solid #6366f1;
    border-radius: 8px;
    color: #e2e8f0;
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    line-height: 1.6;
    padding: 12px 14px;
    resize: vertical;
    outline: none;
  }

  .edit-area textarea:focus { border-color: #818cf8; }

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
    border-radius: 8px;
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn:hover { transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }

  .btn-accept {
    background: linear-gradient(135deg, #059669, #047857);
    color: #fff;
  }
  .btn-accept:hover { background: linear-gradient(135deg, #047857, #065f46); }

  .btn-edit {
    background: linear-gradient(135deg, #6366f1, #4f46e5);
    color: #fff;
  }
  .btn-edit:hover { background: linear-gradient(135deg, #4f46e5, #4338ca); }

  .btn-skip {
    background: #374151;
    color: #9ca3af;
  }
  .btn-skip:hover { background: #4b5563; }

  .btn-save {
    background: linear-gradient(135deg, #059669, #047857);
    color: #fff;
  }

  .btn-cancel {
    background: #374151;
    color: #9ca3af;
  }

  .btn-sm { padding: 6px 12px; font-size: 12px; }

  .apply-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: #1a1d2e;
    border-top: 1px solid #2d3348;
    padding: 16px 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    z-index: 100;
    backdrop-filter: blur(12px);
  }

  .apply-stats {
    font-size: 13px;
    color: #94a3b8;
  }

  .apply-stats strong { color: #6ee7b7; }

  .btn-apply {
    background: linear-gradient(135deg, #6366f1, #4f46e5);
    color: #fff;
    padding: 12px 28px;
    font-size: 14px;
    border-radius: 10px;
    font-weight: 700;
  }

  .btn-apply:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none !important;
  }

  .btn-apply:not(:disabled):hover {
    background: linear-gradient(135deg, #4f46e5, #4338ca);
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
  }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: #64748b;
  }

  .empty-state h2 { font-size: 18px; color: #94a3b8; margin-bottom: 8px; }

  .applying-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(15, 17, 23, 0.85);
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
    border: 3px solid #2d3348;
    border-top-color: #818cf8;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .applying-text { font-size: 14px; color: #94a3b8; }

  .result-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(15, 17, 23, 0.85);
    z-index: 200;
    justify-content: center;
    align-items: center;
  }

  .result-overlay.show { display: flex; }

  .result-card {
    background: #1a1d2e;
    border: 1px solid #2d3348;
    border-radius: 16px;
    padding: 32px 40px;
    text-align: center;
    max-width: 400px;
  }

  .result-card h2 { font-size: 20px; margin-bottom: 12px; }
  .result-card p { font-size: 14px; color: #94a3b8; line-height: 1.6; }
  .result-card .btn { margin-top: 20px; }
</style>
</head>
<body>

<div class="header">
  <h1>Time Entry Review</h1>
  <div class="subtitle">${userName} &middot; ${startDate} to ${endDate} &middot; ${rows.length} entries &middot; ${scopeLabel}</div>
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
    return \`
    <div class="card \${isDone ? 'done' : ''}" id="card-\${e.activity_id}">
      <div class="card-header">
        <div>
          <div class="matter-name">\${esc(e.matter_name)}</div>
          <div class="meta-row">
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
      <div class="card-body">
        <div class="note-section">
          <div class="note-label current">Current</div>
          <div class="note-box current">\${esc(e.current_note) || '<em style="opacity:0.5">No description</em>'}</div>
        </div>
        <div class="note-section">
          <div class="note-label suggested">Suggested</div>
          <div class="note-box suggested">\${esc(e.suggested_note)}</div>
        </div>
        <div class="edit-area" id="edit-\${e.activity_id}">
          <textarea id="textarea-\${e.activity_id}">\${esc(e.suggested_note)}</textarea>
          <div class="edit-actions">
            <button class="btn btn-cancel btn-sm" onclick="cancelEdit('\${e.activity_id}')">Cancel</button>
            <button class="btn btn-save btn-sm" onclick="saveEdit('\${e.activity_id}')">Save Edit</button>
          </div>
        </div>
        <div class="actions" id="actions-\${e.activity_id}">
          <button class="btn btn-accept" onclick="accept('\${e.activity_id}')">\\u2713 Accept</button>
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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', system-ui, sans-serif;
    background: #0f1117;
    color: #e2e8f0;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .panel {
    background: #1a1d2e;
    border: 1px solid #2d3348;
    border-radius: 16px;
    padding: 40px;
    width: 100%;
    max-width: 380px;
    text-align: center;
  }
  h1 { font-size: 22px; font-weight: 700; color: #f8fafc; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #94a3b8; margin-bottom: 28px; }
  input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    background: #111322;
    border: 1px solid #2d3348;
    border-radius: 8px;
    color: #e2e8f0;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    margin-bottom: 16px;
    outline: none;
    text-align: center;
  }
  input[type="password"]:focus { border-color: #6366f1; }
  .btn {
    display: block;
    width: 100%;
    padding: 12px;
    background: linear-gradient(135deg, #6366f1, #4f46e5);
    color: #fff;
    border: none;
    border-radius: 10px;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn:hover { background: linear-gradient(135deg, #4f46e5, #4338ca); transform: translateY(-1px); }
  .error { color: #f87171; font-size: 13px; margin-top: 12px; display: none; }
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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', system-ui, sans-serif;
    background: #0f1117;
    color: #e2e8f0;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
  }
  .panel {
    background: #1a1d2e;
    border: 1px solid #2d3348;
    border-radius: 16px;
    padding: 40px;
    width: 100%;
    max-width: 440px;
  }
  h1 { font-size: 22px; font-weight: 700; color: #f8fafc; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #94a3b8; margin-bottom: 28px; }
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #94a3b8;
    margin-bottom: 6px;
  }
  select, input[type="date"] {
    width: 100%;
    padding: 10px 14px;
    background: #111322;
    border: 1px solid #2d3348;
    border-radius: 8px;
    color: #e2e8f0;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    margin-bottom: 20px;
    outline: none;
  }
  select:focus, input[type="date"]:focus { border-color: #6366f1; }
  .date-row { display: flex; gap: 12px; }
  .date-row > div { flex: 1; }
  .btn {
    display: block;
    width: 100%;
    padding: 12px;
    background: linear-gradient(135deg, #6366f1, #4f46e5);
    color: #fff;
    border: none;
    border-radius: 10px;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    margin-top: 8px;
    transition: all 0.2s;
  }
  .btn:hover { background: linear-gradient(135deg, #4f46e5, #4338ca); transform: translateY(-1px); }
  .loading { display: none; text-align: center; color: #94a3b8; font-size: 13px; margin-top: 16px; }
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
