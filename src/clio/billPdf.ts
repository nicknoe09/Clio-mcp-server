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
  let lastRaw: any = null;

  while (true) {
    const probe = await probeBillPdf(billId, deps);
    const resolved = await resolveProbe(billId, probe, deps);
    if (resolved) return resolved;
    lastRaw = (probe as { raw?: any }).raw ?? lastRaw;
    if (Date.now() + pollIntervalMs > deadline) {
      throw Object.assign(
        new Error(
          `Bill ${billId} PDF was still generating after ${Math.round(timeoutMs / 1000)}s — try again shortly. ` +
            `Last Clio response: ${JSON.stringify(lastRaw).slice(0, 500)}`
        ),
        { clioBody: lastRaw, timedOut: true }
      );
    }
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
  let pending: { id: number; lastRaw: any }[] = [];

  const attempt = async (id: number): Promise<{ pendingRaw: any } | null> => {
    try {
      const probe = await probeBillPdf(id, deps);
      const resolved = await resolveProbe(id, probe, deps);
      if (resolved) {
        results.set(id, { ok: true, buffer: resolved.buffer });
        return null;
      }
      return { pendingRaw: (probe as { raw?: any }).raw };
    } catch (err: any) {
      results.set(id, { ok: false, error: err.message });
      return null;
    }
  };

  // Phase 1: one probe per bill — triggers generation for all of them.
  for (const id of billIds) {
    const p = await attempt(id);
    if (p) pending.push({ id, lastRaw: p.pendingRaw });
    // Courtesy delay between kick-offs to avoid slamming the API.
    if (id !== billIds[billIds.length - 1]) await deps.sleep(200);
  }

  // Phase 2: poll the stragglers until they finish or time runs out.
  while (pending.length > 0 && Date.now() + pollIntervalMs <= deadline) {
    await deps.sleep(pollIntervalMs);
    const still: typeof pending = [];
    for (const entry of pending) {
      const p = await attempt(entry.id);
      if (p) still.push({ id: entry.id, lastRaw: p.pendingRaw ?? entry.lastRaw });
    }
    pending = still;
  }

  for (const entry of pending) {
    results.set(entry.id, {
      ok: false,
      error:
        `PDF was still generating after ${Math.round(timeoutMs / 1000)}s. ` +
        `Last Clio response: ${JSON.stringify(entry.lastRaw).slice(0, 300)}`,
    });
  }

  return results;
}
