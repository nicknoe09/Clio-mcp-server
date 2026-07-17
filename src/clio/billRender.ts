// ============================================================
// Clio bill → PDF, rendered from the invoice preview HTML
// ============================================================
// Clio's OAuth API does not serve rendered bill PDFs (see billPdf.ts for the
// exhaustive probe), but GET /bills/{id}/preview returns the invoice as
// self-contained HTML (inline CSS + DOCTYPE). This module turns that HTML into
// a faithful PDF with a headless browser:
//   1. Fetch the preview HTML (authorized Clio call).
//   2. Inline external <img> assets so the render needs no network:
//        - the firm logo (a presigned S3 URL) is fetched and base64-embedded;
//        - the Clio Payments QR placeholder is STRIPPED, not embedded, so the
//          client-facing PDF carries no broken-image box (by product decision:
//          the payment QR is deliberately kept out of the rendered invoice).
//   3. Render to PDF with Chromium via puppeteer-core, with request
//      interception aborting ALL network so the render is hermetic and fast
//      (webfonts fall back to system fonts; nothing hangs on a dead asset).
//
// Everything is injected through `RenderDeps` so the orchestration and the
// asset-inlining logic are unit-testable without a real browser or HTTPS.
// ============================================================
import axios from "axios";
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

/** Chromium executable path for puppeteer-core, from the environment. */
export function resolveChromiumPath(): string {
  const p =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROMIUM_PATH ||
    process.env.CHROME_PATH ||
    "";
  if (!p) {
    throw new Error(
      "No Chromium available for PDF rendering. Set PUPPETEER_EXECUTABLE_PATH " +
        "(or CHROMIUM_PATH) to a Chromium/Chrome binary. On Railway, install " +
        "chromium via nixpacks.toml and point the env var at it.",
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
 * Render one bill to a PDF buffer: fetch preview HTML → inline the logo /
 * strip the QR → render with the headless browser.
 */
export async function renderBillPdf(
  billId: number,
  deps: Partial<RenderDeps> = {},
): Promise<RenderBillPdfResult> {
  const d = { ...defaultDeps(), ...deps };
  const html = await d.fetchPreviewHtml(billId);
  const { html: inlinedHtml, inlined, skipped } = await inlineBillAssets(html, d.fetchAsset);
  const buffer = await d.renderPdf(inlinedHtml);
  return { buffer, inlined, skipped };
}
