// ============================================================
// Clio bill → PDF, rendered from the invoice preview HTML
// ============================================================
// Clio's OAuth API does not serve rendered bill PDFs (see billPdf.ts for the
// exhaustive probe), but GET /bills/{id}/preview returns the invoice as
// self-contained HTML (inline CSS + DOCTYPE). This module turns that HTML into
// a faithful PDF with a headless browser:
//   1. Fetch the preview HTML (authorized Clio call).
//   2. Strip the Clio Payments stub that the preview appends after the invoice
//      .footer — a "Page Break" divider (div.qr-code-preview-page-break), a
//      REPEATED firm-address/invoice-number header (the second div.top-fold),
//      and the "Pay your invoice online" block with its QR placeholder + link
//      (div.qr-code-page). None of it belongs on the client-facing PDF (product
//      decision: the payment QR is deliberately kept out of the rendered
//      invoice), and left in it produces a spurious trailing page. The real
//      invoice header (the FIRST div.top-fold) and the .footer are preserved.
//   3. Inline external <img> assets so the render needs no network:
//        - the firm logo (a presigned S3 URL) is fetched and base64-embedded;
//        - any stray Clio Payments QR <img> that survives the stub strip is
//          removed, not embedded, so the PDF carries no broken-image box.
//   4. Render to PDF with Chromium via puppeteer-core, with request
//      interception aborting ALL network so the render is hermetic and fast
//      (webfonts fall back to system fonts; nothing hangs on a dead asset).
//
// Everything is injected through `RenderDeps` so the orchestration and the
// asset-inlining logic are unit-testable without a real browser or HTTPS.
// ============================================================
import axios from "axios";
import { existsSync, readdirSync } from "node:fs";
import type { Browser } from "puppeteer-core";
import { rawGetBinarySingle } from "./pagination";

export type AssetResult = { buffer: Buffer; contentType: string };

export type RenderDeps = {
  /** Fetch a bill's rendered preview HTML (authorized Clio call). */
  fetchPreviewHtml: (billId: number) => Promise<string>;
  /** Fetch an external asset (e.g. the presigned S3 logo) — no Clio auth. */
  fetchAsset: (url: string) => Promise<AssetResult>;
  /** Render a self-contained HTML string to PDF bytes. */
  renderPdf: (html: string) => Promise<Buffer>;
};

// An <img> whose src matches this is the Clio Payments QR placeholder
// (e.g. /images/clio_payments/qr-code-preview.svg). It is removed from the
// invoice rather than inlined — see the product note above.
const PAYMENT_QR_SRC = /clio_payments|qr[-_]?code/i;

/** Decode the handful of HTML entities that show up inside an attribute URL. */
function decodeEntities(url: string): string {
  return url
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export type InlineResult = { html: string; inlined: string[]; skipped: string[] };

/**
 * Inline the invoice's external images so the render is self-contained.
 * The firm logo (absolute http(s) URL) is fetched and turned into a data: URI;
 * the payment-QR <img> is stripped; data: URIs and unresolvable relative URLs
 * are left untouched. Returns the rewritten HTML plus what was inlined/skipped.
 */
export async function inlineBillAssets(
  html: string,
  fetchAsset: RenderDeps["fetchAsset"],
): Promise<InlineResult> {
  const inlined: string[] = [];
  const skipped: string[] = [];

  // Collect every <img ...> tag with its src so we can rewrite/remove it.
  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);

  let out = html;
  for (const tag of imgTags) {
    const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    const rawSrc = srcMatch?.[1];

    // Strip the payment QR entirely (do not inline it).
    if (rawSrc && PAYMENT_QR_SRC.test(rawSrc)) {
      out = out.replace(tag, "");
      skipped.push(`stripped payment-qr: ${rawSrc}`);
      continue;
    }

    if (!rawSrc || rawSrc.startsWith("data:")) {
      skipped.push(rawSrc ? "already-data-uri" : "img-without-src");
      continue;
    }

    const url = decodeEntities(rawSrc);
    // Only absolute http(s) assets can be fetched; relative paths have no host.
    if (!/^https?:\/\//i.test(url)) {
      skipped.push(`unresolvable-relative: ${rawSrc}`);
      continue;
    }

    try {
      const asset = await fetchAsset(url);
      const mime = (asset.contentType || "image/jpeg").split(";")[0].trim();
      const dataUri = `data:${mime};base64,${asset.buffer.toString("base64")}`;
      const newTag = tag.replace(srcMatch![0], `src="${dataUri}"`);
      out = out.replace(tag, newTag);
      inlined.push(url);
    } catch (e: any) {
      // Leave the original tag; the hermetic render will just show nothing
      // for it rather than failing the whole PDF.
      skipped.push(`fetch-failed (${e?.message ?? "error"}): ${url}`);
    }
  }

  return { html: out, inlined, skipped };
}

// ------------------------------------------------------------
// Payment-stub removal (DOM surgery on the preview HTML string)
// ------------------------------------------------------------
// The preview appends a "Clio Payments" stub AFTER the invoice .footer:
//   <div class='qr-code-preview-page-break'> … Page Break … </div>
//   <div class='top-fold'> … repeated firm-address/invoice-number header … </div>
//   <div class="qr-code-page"> … "Pay your invoice online" + QR + click-here … </div>
// We remove that whole stub. The FIRST .top-fold (the real invoice header) and
// the .footer ("Please make all amounts payable to…" / "Please pay within
// 15 days") must be preserved. Sanitization happens before the page loads, so
// the surgery is done on the HTML string with a small balanced-tag matcher
// (avoids a DOM-parser dependency and keeps this unit-testable and pure).

/** Escape a string for safe embedding in a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if a class attribute value carries `cls` as a whole (space-delimited) token. */
function classListHas(classAttr: string, cls: string): boolean {
  return classAttr.trim().split(/\s+/).includes(cls);
}

/**
 * Given the index of an opening `<tag …>` in `html`, return the index just past
 * its balanced `</tag>`, or -1 if unbalanced. Nested same-tag children are
 * counted so the whole element (with its descendants) is spanned. Assumes tag
 * attributes contain no unescaped `>` (true of Clio's preview markup).
 */
function elementEnd(html: string, openIdx: number): number {
  const nameMatch = /^<([a-zA-Z][\w-]*)/.exec(html.slice(openIdx));
  if (!nameMatch) return -1;
  const tag = escapeRegExp(nameMatch[1]);
  const tokenRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, "gi");
  tokenRe.lastIndex = openIdx;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else if (!m[0].endsWith("/>")) {
      depth++;
    }
  }
  return -1;
}

/** [start, end) spans of every element whose opening tag carries class `cls`. */
function findElementsByClass(html: string, cls: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const openRe = /<[a-zA-Z][\w-]*\b[^>]*\bclass\s*=\s*(['"])([^'"]*)\1[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    if (!classListHas(m[2], cls)) continue;
    const end = elementEnd(html, m.index);
    if (end > m.index) spans.push([m.index, end]);
  }
  return spans;
}

/** True if `outer` strictly contains `inner` (used to drop nested removals). */
function strictlyContains(outer: [number, number], inner: [number, number]): boolean {
  return (
    outer[0] <= inner[0] &&
    inner[1] <= outer[1] &&
    (outer[0] < inner[0] || inner[1] < outer[1])
  );
}

export type StubResult = { html: string; removed: string[] };

/**
 * Remove the Clio Payments stub appended after the invoice .footer:
 *   - div.qr-code-page             ("Pay your invoice online" + QR + link)
 *   - div.qr-code-preview-page-break ("Page Break" divider)
 *   - the SECOND div.top-fold      (repeated header; the first is the real one)
 *   - any div.einvoice-qr-code-container (defensive; absent in current markup)
 * Removal is by container class where possible; the repeated header is the one
 * case that must fall back to index [1] (guarded against there being only one
 * .top-fold). Returns the cleaned HTML and a human-readable list of what went.
 */
export function stripPaymentStub(html: string): StubResult {
  const removed: string[] = [];
  // [start, end, label] for each element we intend to remove.
  const targets: Array<[number, number, string]> = [];

  // Prefer removal by container class.
  for (const cls of ["qr-code-page", "qr-code-preview-page-break", "einvoice-qr-code-container"]) {
    for (const [s, e] of findElementsByClass(html, cls)) targets.push([s, e, cls]);
  }

  // Repeated header: the second .top-fold. The FIRST is the real invoice header
  // and must survive, so only fall back to [1] indexing here — and only when a
  // second one actually exists.
  const topFolds = findElementsByClass(html, "top-fold");
  if (topFolds.length > 1) {
    targets.push([topFolds[1][0], topFolds[1][1], "repeated header (top-fold[1])"]);
  }

  if (targets.length === 0) return { html, removed };

  // Drop any target nested inside another (avoid double-removing / index skew).
  const outer = targets.filter(
    (t) => !targets.some((o) => o !== t && strictlyContains([o[0], o[1]], [t[0], t[1]])),
  );

  // Splice from the end backward so earlier offsets stay valid.
  outer.sort((a, b) => b[0] - a[0]);
  let out = html;
  const labels: string[] = [];
  for (const [start, end, label] of outer) {
    out = out.slice(0, start) + out.slice(end);
    labels.unshift(label); // rebuild document order
  }

  removed.push(`stripped payment-stub: ${labels.join(" + ")}`);
  return { html: out, removed };
}

// Common Chromium/Chrome binary names, most-specific first, used for PATH and
// well-known-location scanning when no explicit env var is set.
const CHROMIUM_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "chrome",
];
const CHROMIUM_WELL_KNOWN = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium",
  // Nix profile locations (the Nixpacks `chromium` package), for when the
  // Nix profile bin dir is not on the runtime $PATH.
  "/root/.nix-profile/bin/chromium",
  "/nix/var/nix/profiles/default/bin/chromium",
];

// The Nix store, where the Nixpacks `chromium` package's binary actually lives
// (e.g. /nix/store/<hash>-chromium-<ver>/bin/chromium). The store dir is baked
// into the runtime image, but the hashed sub-path is not stable and its bin dir
// is not reliably on the runtime $PATH — so we scan it directly.
const NIX_STORE = "/nix/store";

/**
 * Scan /nix/store for a Chromium binary. This is the reliable fallback on
 * Railway/Nixpacks: the store is present in the runtime image even when the
 * Nix profile bin dir is missing from $PATH. Prefers a full `chromium` build
 * over `chromium-headless-shell`. Injectable readdir/exists for testing.
 */
export function scanNixStore(
  opts: { exists?: (p: string) => boolean; readdir?: (p: string) => string[] } = {},
): string | null {
  const exists = opts.exists ?? existsSync;
  const readdir = opts.readdir ?? ((p: string) => readdirSync(p));

  let entries: string[];
  try {
    entries = readdir(NIX_STORE);
  } catch {
    return null; // No Nix store on this host — nothing to scan.
  }

  // Rank full chromium ahead of the headless-shell variant.
  const ranked = entries
    .filter((e) => /chromium/i.test(e))
    .sort((a, b) => (/headless/i.test(a) ? 1 : 0) - (/headless/i.test(b) ? 1 : 0));

  for (const entry of ranked) {
    const p = `${NIX_STORE}/${entry}/bin/chromium`;
    if (exists(p)) return p;
  }
  return null;
}

/**
 * Locate a Chromium/Chrome binary for puppeteer-core (which needs a real file
 * path — it does NOT resolve a bare name via PATH). Resolution order:
 *   1. PUPPETEER_EXECUTABLE_PATH / CHROMIUM_PATH / CHROME_PATH, if the file exists;
 *   2. a binary named like Chromium found on $PATH (covers the nixpacks
 *      `chromium` package, whose Nix-store path is not stable across builds);
 *   3. a well-known absolute location;
 *   4. a scan of /nix/store (the Nixpacks chromium binary lives here even when
 *      its bin dir is not on the runtime $PATH — the failure mode seen in prod).
 * Injectable env/exists/readdir for testing. Returns null when nothing is found.
 */
export function findChromium(
  opts: {
    env?: NodeJS.ProcessEnv;
    exists?: (p: string) => boolean;
    readdir?: (p: string) => string[];
  } = {},
): string | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;

  const explicit =
    env.PUPPETEER_EXECUTABLE_PATH || env.CHROMIUM_PATH || env.CHROME_PATH;
  if (explicit && exists(explicit)) return explicit;

  const dirs = (env.PATH || "").split(":").filter(Boolean);
  for (const dir of dirs) {
    for (const name of CHROMIUM_NAMES) {
      const full = `${dir.replace(/\/$/, "")}/${name}`;
      if (exists(full)) return full;
    }
  }

  for (const p of CHROMIUM_WELL_KNOWN) {
    if (exists(p)) return p;
  }

  return scanNixStore({ exists, readdir: opts.readdir });
}

/** Chromium executable path for puppeteer-core, or a clear (diagnostic) error. */
export function resolveChromiumPath(): string {
  const p = findChromium();
  if (!p) {
    // Self-diagnosing: report what the runtime actually exposed so a lingering
    // failure is debuggable from the tool output alone.
    let nixHits = "n/a";
    try {
      nixHits =
        readdirSync(NIX_STORE)
          .filter((e) => /chromium/i.test(e))
          .slice(0, 5)
          .join(", ") || "(none)";
    } catch {
      nixHits = "(no /nix/store)";
    }
    const pathDirs = (process.env.PATH || "").split(":").filter(Boolean).length;
    throw new Error(
      "No Chromium found for PDF rendering. The server scans $PATH, common " +
        "locations, and /nix/store; on Railway the nixpacks.toml `chromium` " +
        "package should be present in the image. To override, set " +
        "PUPPETEER_EXECUTABLE_PATH (or CHROMIUM_PATH) to an existing Chromium " +
        `binary. [diagnostics: PATH dirs=${pathDirs}, ` +
        `PUPPETEER_EXECUTABLE_PATH=${process.env.PUPPETEER_EXECUTABLE_PATH ?? "unset"}, ` +
        `/nix/store chromium entries=${nixHits}]`,
    );
  }
  return p;
}

/**
 * Default PDF renderer: Chromium via puppeteer-core. Network is fully blocked
 * (request interception aborts everything) so the render is hermetic — the
 * logo is already a data: URI, and webfonts fall back to system fonts.
 */
export async function renderHtmlToPdfDefault(html: string): Promise<Buffer> {
  // Lazy import so the module (and its unit tests) don't require the native
  // package unless an actual render is requested.
  const puppeteer = (await import("puppeteer-core")).default;
  const browser: Browser = await puppeteer.launch({
    executablePath: resolveChromiumPath(),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const u = req.url();
      // Allow the inline document + data: URIs; block all real network.
      if (u.startsWith("data:") || u === "about:blank") req.continue();
      else req.abort();
    });
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

function defaultDeps(): RenderDeps {
  return {
    fetchPreviewHtml: async (billId: number) => {
      const { buffer } = await rawGetBinarySingle(`/bills/${billId}/preview`);
      return buffer.toString("utf8");
    },
    fetchAsset: async (url: string) => {
      const res = await axios.get(url, { responseType: "arraybuffer", timeout: 20_000 });
      return {
        buffer: Buffer.from(res.data),
        contentType: String(res.headers["content-type"] || "application/octet-stream"),
      };
    },
    renderPdf: renderHtmlToPdfDefault,
  };
}

export type RenderBillPdfResult = {
  buffer: Buffer;
  inlined: string[];
  skipped: string[];
};

/**
 * Render one bill to a PDF buffer: fetch preview HTML → strip the Clio Payments
 * stub → inline the logo → render with the headless browser. Shared by both
 * render_bill_pdf and download_bills_pdf so the sanitization is identical.
 */
export async function renderBillPdf(
  billId: number,
  deps: Partial<RenderDeps> = {},
): Promise<RenderBillPdfResult> {
  const d = { ...defaultDeps(), ...deps };
  const html = await d.fetchPreviewHtml(billId);
  // Remove the payment stub (page-break divider + repeated header + QR block)
  // before inlining images, so the QR placeholder is gone with its container.
  const { html: strippedHtml, removed } = stripPaymentStub(html);
  const { html: inlinedHtml, inlined, skipped } = await inlineBillAssets(strippedHtml, d.fetchAsset);
  const buffer = await d.renderPdf(inlinedHtml);
  return { buffer, inlined, skipped: [...removed, ...skipped] };
}
