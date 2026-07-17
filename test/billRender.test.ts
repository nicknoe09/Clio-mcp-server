import { describe, it, expect } from "vitest";
import { inlineBillAssets, renderBillPdf, findChromium, type AssetResult } from "../src/clio/billRender";

const LOGO_URL =
  "https://s3.amazonaws.com/documents.goclio.com/logos/100660/Firm%20Logo.jpg?X-Amz-Signature=abc&amp;X-Amz-Expires=300";
const QR_TAG = `<img src="/images/clio_payments/qr-code-preview.svg" class="qr-code-preview"/>`;

function fakeAsset(bytes = "PNGDATA", contentType = "image/jpeg"): AssetResult {
  return { buffer: Buffer.from(bytes), contentType };
}

describe("inlineBillAssets", () => {
  it("embeds the firm logo as a base64 data URI and decodes &amp; in the URL", async () => {
    const html = `<html><img src="${LOGO_URL}" style="height:5em"/><p>body</p></html>`;
    const fetched: string[] = [];
    const res = await inlineBillAssets(html, async (url) => {
      fetched.push(url);
      return fakeAsset();
    });

    // The URL passed to the fetcher must be entity-decoded (real &, not &amp;).
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain("X-Amz-Signature=abc&X-Amz-Expires=300");
    expect(fetched[0]).not.toContain("&amp;");

    // The <img> now carries a data: URI, not the S3 link.
    expect(res.html).toContain(`src="data:image/jpeg;base64,${Buffer.from("PNGDATA").toString("base64")}"`);
    expect(res.html).not.toContain("s3.amazonaws.com");
    // Other attributes on the tag are preserved.
    expect(res.html).toContain('style="height:5em"');
    expect(res.inlined).toEqual([expect.stringContaining("s3.amazonaws.com")]);
  });

  it("strips the payment QR instead of inlining it, and never fetches it", async () => {
    const html = `<div>${QR_TAG}</div>`;
    const fetched: string[] = [];
    const res = await inlineBillAssets(html, async (url) => {
      fetched.push(url);
      return fakeAsset();
    });

    expect(fetched).toHaveLength(0); // QR was never fetched
    expect(res.html).not.toContain("qr-code-preview");
    expect(res.html).toBe("<div></div>");
    expect(res.skipped.some((s) => s.includes("payment-qr"))).toBe(true);
  });

  it("leaves data: URIs and unresolvable relative images untouched", async () => {
    const html = `<img src="data:image/png;base64,AAAA"/><img src="/relative/pic.png"/>`;
    const res = await inlineBillAssets(html, async () => {
      throw new Error("should not fetch");
    });
    expect(res.html).toBe(html);
    expect(res.inlined).toHaveLength(0);
    expect(res.skipped).toContain("already-data-uri");
    expect(res.skipped.some((s) => s.includes("unresolvable-relative"))).toBe(true);
  });

  it("keeps the original tag (does not fail the render) when an asset fetch throws", async () => {
    const html = `<img src="${LOGO_URL}"/>`;
    const res = await inlineBillAssets(html, async () => {
      throw new Error("boom");
    });
    expect(res.html).toContain("s3.amazonaws.com"); // untouched
    expect(res.inlined).toHaveLength(0);
    expect(res.skipped.some((s) => s.includes("fetch-failed"))).toBe(true);
  });
});

describe("findChromium", () => {
  it("prefers an explicit env var when the file exists", () => {
    const found = findChromium({
      env: { PUPPETEER_EXECUTABLE_PATH: "/custom/chrome", PATH: "/usr/bin" },
      exists: (p) => p === "/custom/chrome" || p === "/usr/bin/chromium",
    });
    expect(found).toBe("/custom/chrome");
  });

  it("falls through to a PATH scan when the explicit path does not exist", () => {
    const found = findChromium({
      env: { PUPPETEER_EXECUTABLE_PATH: "/stale/missing", PATH: "/nix/x/bin:/usr/bin" },
      exists: (p) => p === "/usr/bin/chromium",
    });
    expect(found).toBe("/usr/bin/chromium");
  });

  it("scans $PATH for a Chromium-like binary (nixpacks store path)", () => {
    const found = findChromium({
      env: { PATH: "/nix/store/abc-chromium/bin:/usr/bin" },
      exists: (p) => p === "/nix/store/abc-chromium/bin/chromium",
    });
    expect(found).toBe("/nix/store/abc-chromium/bin/chromium");
  });

  it("falls back to a well-known location when nothing is on PATH", () => {
    const found = findChromium({
      env: { PATH: "/empty" },
      exists: (p) => p === "/usr/bin/google-chrome-stable",
    });
    expect(found).toBe("/usr/bin/google-chrome-stable");
  });

  it("returns null when no browser is found anywhere", () => {
    expect(findChromium({ env: { PATH: "/nowhere" }, exists: () => false })).toBeNull();
  });
});

describe("renderBillPdf orchestration", () => {
  it("fetches preview → inlines assets → renders, passing inlined HTML to the renderer", async () => {
    const previewHtml = `<html><img src="${LOGO_URL}"/>${QR_TAG}</html>`;
    let renderedHtml = "";
    const result = await renderBillPdf(123, {
      fetchPreviewHtml: async (id) => {
        expect(id).toBe(123);
        return previewHtml;
      },
      fetchAsset: async () => fakeAsset(),
      renderPdf: async (html) => {
        renderedHtml = html;
        return Buffer.from("%PDF-1.4 fake");
      },
    });

    // The HTML handed to the renderer has the logo embedded and the QR removed.
    expect(renderedHtml).toContain("data:image/jpeg;base64,");
    expect(renderedHtml).not.toContain("qr-code-preview");
    expect(renderedHtml).not.toContain("s3.amazonaws.com");

    expect(result.buffer.toString("utf8")).toContain("%PDF");
    expect(result.inlined).toHaveLength(1);
    expect(result.skipped.some((s) => s.includes("payment-qr"))).toBe(true);
  });
});
