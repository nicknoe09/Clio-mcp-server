// ============================================================
// Clio bill PDF download — async generation flow
// ============================================================
// Clio generates bill PDFs asynchronously. GET /bills/{id}.pdf does NOT
// reliably return PDF bytes on the first request: it kicks off generation
// and responds 200 with a JSON body (a "still generating" status, or a
// presigned download URL once the PDF is ready). The previous
// implementation did a single GET and errored on that JSON ("Clio
// returned content-type application/json instead of PDF"). This module
// implements the full flow:
//   1. GET /bills/{id}.pdf — returns the PDF if ready, otherwise triggers
//      generation and returns JSON (Clio may also 303 straight to S3,
//      which the binary helper already follows).
//   2. Interpret the response:
//        PDF bytes          → done
//        JSON with a URL    → download the PDF from that URL (presigned,
//                             fetched WITHOUT the bearer token)
//        JSON, no URL       → still generating; poll again
//        JSON with an error → fail fast with Clio's message
//   3. Repeat until the PDF arrives or the deadline passes. On timeout the
//      last JSON body is included in the error so Clio's actual response
//      is never hidden from the caller again.
// The response-shape interpretation is deliberately defensive (Clio's
// bill-PDF JSON is not in their OpenAPI spec): any JSON without an error
// or a URL is treated as "still generating" rather than a hard failure.
import { ENV } from "../utils/env";
import { rawGetBinarySingle, rawGetBinaryFromUrl } from "./pagination";

export type BinaryResult = { buffer: Buffer; contentType: string };

export type BillPdfProbe =
  | { kind: "pdf"; buffer: Buffer; contentType: string }
  | { kind: "url"; url: string; raw: any }
  | { kind: "pending"; raw: any }
  | { kind: "error"; raw: any; message: string }
  | { kind: "unrecognized"; snippet: string; contentType: string };

/** PDF by declared content-type or by magic bytes (%PDF). */
export function looksLikePdf(buffer: Buffer, contentType: string): boolean {
  return (
    (contentType || "").toLowerCase().includes("pdf") ||
    buffer.slice(0, 5).toString("latin1").startsWith("%PDF")
  );
}

/**
 * Find the most plausible download URL in an arbitrary JSON body.
 * Scores candidates so a signed/pdf/download link beats a generic `url`
 * field (which on Clio resources can be a plain .json self-link — those
 * are excluded outright). Accepts absolute http(s) URLs and root-relative
 * API paths. Returns null when nothing URL-like is present.
 */
export function extractDownloadUrl(body: any): string | null {
  let best: { url: string; score: number } | null = null;
  const consider = (key: string, value: string) => {
    if (typeof value !== "string") return;
    const isHttp = /^https?:\/\//i.test(value);
    const isRootRelative = value.startsWith("/");
    if (!isHttp && !isRootRelative) return;
    if (/\.json(\?|$)/i.test(value)) return; // self-links, not downloads
    let score = 0;
    if (/download|pdf|presigned|signed|file/i.test(key)) score += 2;
    else if (/(^|_)(url|uri|link|href)$/i.test(key)) score += 1;
    if (/\.pdf(\?|$)|X-Amz-|amazonaws/i.test(value)) score += 2;
    if (score === 0) return;
    if (!best || score > best.score) best = { url: value, score };
  };
  const walk = (node: any) => {
    if (node == null) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") consider(key, value);
      else walk(value);
    }
  };
  if (typeof body === "string") consider("url", body.trim());
  else walk(body);
  return best ? (best as { url: string; score: number }).url : null;
}

// Bill lifecycle states. If the "pending" JSON's state is one of THESE, the
// endpoint returned the bill resource itself (default fields: id/etag/number/
// state), NOT a generation-job status — i.e. GET /bills/{id}.pdf behaved like
// .json and no PDF render was started. Observed live 2026-07-13 on bill
// 1323892745: two 90s poll runs, body never changed from the bill envelope.
const BILL_STATES = new Set(["draft", "awaiting_approval", "awaiting_payment", "paid", "void", "deleted"]);

/** True when a JSON body is (a wrapper around) the bill resource itself. */
export function looksLikeBillResource(raw: any): boolean {
  const d = raw?.data ?? raw;
  return (
    !!d &&
    typeof d === "object" &&
    ("etag" in d || "number" in d) &&
    BILL_STATES.has(String(d.state ?? ""))
  );
}

/** Pull a human-readable message out of a Clio error body. */
function clioErrorMessage(raw: any): string {
  const err = raw?.error ?? raw?.errors;
  if (typeof err === "string") return err;
  if (err?.message) return String(err.message);
  return JSON.stringify(err ?? raw).slice(0, 300);
}

/**
 * Classify one response from GET /bills/{id}.pdf.
 * PDF bytes → pdf; JSON with error → error; JSON with a download URL →
 * url; any other JSON → pending (generation in progress); non-JSON,
 * non-PDF (e.g. an HTML error page) → unrecognized.
 */
export function interpretBillPdfResponse(result: BinaryResult): BillPdfProbe {
  if (looksLikePdf(result.buffer, result.contentType)) {
    return { kind: "pdf", buffer: result.buffer, contentType: result.contentType };
  }
  const text = result.buffer.toString("utf8");
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "unrecognized", snippet: text.slice(0, 300), contentType: result.contentType };
  }
  if (raw?.error || raw?.errors) {
    return { kind: "error", raw, message: clioErrorMessage(raw) };
  }
  const url = extractDownloadUrl(raw);
  if (url) return { kind: "url", url, raw };
  return { kind: "pending", raw };
}

// Injectable I/O so the polling logic is unit-testable without HTTPS.
export type BillPdfDeps = {
  /** GET a Clio API path (authorized, follows Clio's 303-to-S3). */
  getBinary: (path: string, params?: Record<string, any>, headers?: Record<string, string>) => Promise<BinaryResult>;
  /** GET an absolute presigned URL (unauthorized). */
  fetchUrl: (url: string) => Promise<BinaryResult>;
  sleep: (ms: number) => Promise<void>;
};

function defaultDeps(): BillPdfDeps {
  return {
    getBinary: rawGetBinarySingle,
    fetchUrl: (url: string) => {
      // A relative path or a URL on the Clio API host still needs the
      // bearer token; anything else is a presigned link fetched bare.
      // Strip a leading /api/v4 so it doesn't double with the base URL path.
      const base = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
      if (url.startsWith("/")) return rawGetBinarySingle(url.replace(/^\/api\/v4/, ""));
      if (url.startsWith(base + "/")) return rawGetBinarySingle(url.slice(base.length));
      return rawGetBinaryFromUrl(url);
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * One GET of /bills/{id}.pdf, classified. Falls back to an Accept-header
 * request on 404/406 in case a Clio region doesn't route the .pdf suffix.
 */
export async function probeBillPdf(billId: number, deps: BillPdfDeps): Promise<BillPdfProbe> {
  let result: BinaryResult;
  try {
    result = await deps.getBinary(`/bills/${billId}.pdf`);
  } catch (suffixErr: any) {
    if (suffixErr.response?.status === 404 || suffixErr.response?.status === 406) {
      result = await deps.getBinary(`/bills/${billId}`, {}, { Accept: "application/pdf" });
    } else {
      throw suffixErr;
    }
  }
  return interpretBillPdfResponse(result);
}

export type BillPdfOptions = {
  /** Overall deadline for generation + download. Default 90s. */
  timeoutMs?: number;
  /** Delay between generation-status polls. Default 2.5s. */
  pollIntervalMs?: number;
  deps?: BillPdfDeps;
};

/** Resolve a classified probe into PDF bytes (downloads `url` probes). */
async function resolveProbe(
  billId: number,
  probe: BillPdfProbe,
  deps: BillPdfDeps
): Promise<BinaryResult | null> {
  switch (probe.kind) {
    case "pdf":
      return { buffer: probe.buffer, contentType: probe.contentType };
    case "url": {
      const dl = await deps.fetchUrl(probe.url);
      if (!looksLikePdf(dl.buffer, dl.contentType)) {
        throw new Error(
          `Clio's download URL for bill ${billId} returned content-type "${dl.contentType}" instead of a PDF. ` +
            `Body starts: ${dl.buffer.toString("utf8").slice(0, 200)}`
        );
      }
      return dl;
    }
    case "error":
      throw Object.assign(new Error(`Clio rejected the PDF request for bill ${billId}: ${probe.message}`), {
        clioBody: probe.raw,
      });
    case "unrecognized":
      throw new Error(
        `Unexpected response for bill ${billId} PDF (content-type "${probe.contentType}"): ${probe.snippet}`
      );
    case "pending":
      return null;
  }
}

// Per-bill poll bookkeeping: every interim body, verbatim, so live behavior is
// diagnosable from logs/errors (requested after the 2026-07-13 timeout runs
// where only the last truncated body was visible).
type PendingState = {
  polls: number;
  lastRaw: any;
  bodies: Set<string>;
  alternatesTried: boolean;
  allBillResource: boolean;
};

function newPendingState(): PendingState {
  return { polls: 0, lastRaw: null, bodies: new Set(), alternatesTried: false, allBillResource: true };
}

function recordPending(billId: number, raw: any, st: PendingState): void {
  st.polls++;
  st.lastRaw = raw;
  const body = JSON.stringify(raw);
  st.bodies.add(body);
  if (!looksLikeBillResource(raw)) st.allBillResource = false;
  console.log(`[bill-pdf] bill ${billId} poll #${st.polls}: no PDF yet; full Clio body: ${body.slice(0, 2000)}`);
}

function timeoutError(billId: number, st: PendingState, timeoutMs: number): Error {
  const secs = Math.round(timeoutMs / 1000);
  const changed = st.bodies.size > 1 ? "the body CHANGED across polls" : "the body never changed";
  const diagnosis = st.allBillResource
    ? `Clio kept returning the bill resource itself (id/etag/number/state; ${st.polls} poll(s), ${changed}) — ` +
      `GET /bills/{id}.pdf did not start PDF generation for this API client, so longer polling won't help. ` +
      `Run probe_bill_pdf_apis with this bill_id to discover the route that actually serves the file.`
    : `PDF was still generating after ${secs}s (${st.polls} poll(s), ${changed}) — try again shortly.`;
  const bodies = [...st.bodies].map((b) => b.slice(0, 400)).join(" || ");
  return Object.assign(
    new Error(`Bill ${billId} PDF download failed after ${secs}s: ${diagnosis} Distinct Clio responses seen: ${bodies}`),
    { clioBody: st.lastRaw, timedOut: true }
  );
}

/**
 * One-shot attempts at alternative routes, tried after the first "pending"
 * response. GET /bills/{id}.pdf has been observed returning plain bill JSON
 * forever (never a render job), so also try content negotiation on the bare
 * resource and a /download route mirroring /reports/{id}/download. Any
 * failure here is swallowed — the caller keeps polling the .pdf route.
 */
async function tryAlternateRoutes(billId: number, deps: BillPdfDeps): Promise<BinaryResult | null> {
  const candidates: Array<{ label: string; get: () => Promise<BinaryResult> }> = [
    { label: `GET /bills/${billId} (Accept: application/pdf)`, get: () => deps.getBinary(`/bills/${billId}`, {}, { Accept: "application/pdf" }) },
    { label: `GET /bills/${billId}/download`, get: () => deps.getBinary(`/bills/${billId}/download`) },
  ];
  for (const c of candidates) {
    try {
      const probe = interpretBillPdfResponse(await c.get());
      if (probe.kind !== "pdf" && probe.kind !== "url") continue;
      const resolved = await resolveProbe(billId, probe, deps);
      if (resolved) {
        console.log(`[bill-pdf] bill ${billId}: alternate route succeeded: ${c.label}`);
        return resolved;
      }
    } catch (e: any) {
      console.log(`[bill-pdf] bill ${billId}: alternate route failed (${c.label}): ${e?.response?.status ?? e?.message}`);
    }
  }
  return null;
}

/**
 * Download one bill's PDF, driving Clio's async generation: request,
 * poll while Clio reports the PDF as still generating, then return the
 * bytes (following Clio's presigned download URL when it hands one back).
 */
export async function downloadBillPdfBuffer(billId: number, opts: BillPdfOptions = {}): Promise<BinaryResult> {
  const deps = opts.deps ?? defaultDeps();
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;
  const st = newPendingState();

  while (true) {
    const probe = await probeBillPdf(billId, deps);
    const resolved = await resolveProbe(billId, probe, deps);
    if (resolved) return resolved;
    recordPending(billId, (probe as { raw?: any }).raw, st);
    if (!st.alternatesTried) {
      st.alternatesTried = true;
      const alt = await tryAlternateRoutes(billId, deps);
      if (alt) return alt;
    }
    if (Date.now() + pollIntervalMs > deadline) throw timeoutError(billId, st, timeoutMs);
    await deps.sleep(pollIntervalMs);
  }
}

export type BulkBillPdfResult = Map<number, { ok: true; buffer: Buffer } | { ok: false; error: string }>;

/**
 * Download many bill PDFs. Phase 1 probes every bill once — each probe
 * kicks off that bill's PDF generation on Clio's side, so all bills
 * generate concurrently and total wall time tracks the SLOWEST bill, not
 * the sum. Phase 2 round-robin polls the still-pending bills until the
 * deadline. Per-bill failures are captured, never thrown, so one bad
 * bill can't sink the batch.
 */
export async function downloadBillPdfBuffers(
  billIds: number[],
  opts: BillPdfOptions = {}
): Promise<BulkBillPdfResult> {
  const deps = opts.deps ?? defaultDeps();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;

  const results: BulkBillPdfResult = new Map();
  let pending: { id: number; st: PendingState }[] = [];

  /** Returns true when the bill reached a terminal result (success or failure). */
  const attempt = async (id: number, st: PendingState): Promise<boolean> => {
    try {
      const probe = await probeBillPdf(id, deps);
      const resolved = await resolveProbe(id, probe, deps);
      if (resolved) {
        results.set(id, { ok: true, buffer: resolved.buffer });
        return true;
      }
      recordPending(id, (probe as { raw?: any }).raw, st);
      if (!st.alternatesTried) {
        st.alternatesTried = true;
        const alt = await tryAlternateRoutes(id, deps);
        if (alt) {
          results.set(id, { ok: true, buffer: alt.buffer });
          return true;
        }
      }
      return false;
    } catch (err: any) {
      results.set(id, { ok: false, error: err.message });
      return true;
    }
  };

  // Phase 1: one probe per bill — triggers generation for all of them.
  for (const id of billIds) {
    const st = newPendingState();
    if (!(await attempt(id, st))) pending.push({ id, st });
    // Courtesy delay between kick-offs to avoid slamming the API.
    if (id !== billIds[billIds.length - 1]) await deps.sleep(200);
  }

  // Phase 2: poll the stragglers until they finish or time runs out.
  while (pending.length > 0 && Date.now() + pollIntervalMs <= deadline) {
    await deps.sleep(pollIntervalMs);
    const still: typeof pending = [];
    for (const entry of pending) {
      if (!(await attempt(entry.id, entry.st))) still.push(entry);
    }
    pending = still;
  }

  for (const entry of pending) {
    results.set(entry.id, { ok: false, error: timeoutError(entry.id, entry.st, timeoutMs).message });
  }

  return results;
}
