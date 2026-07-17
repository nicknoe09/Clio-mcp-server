import { describe, it, expect } from "vitest";
import { inlineBillAssets, renderBillPdf, stripPaymentStub, findChromium, scanNixStore, type AssetResult } from "../src/clio/billRender";

const LOGO_URL =
  "https://s3.amazonaws.com/documents.goclio.com/logos/100660/Firm%20Logo.jpg?X-Amz-Signature=abc&amp;X-Amz-Expires=300";
const QR_TAG = `<img src="/images/clio_payments/qr-code-preview.svg" class="qr-code-preview"/>`;

// A faithful shrink of the real Clio preview tail: the invoice header
// (FIRST .top-fold), the .footer, then the payment stub Clio appends — the
// page-break divider, a REPEATED .top-fold header, and the qr-code-page block.
const STUB_HTML = `<!DOCTYPE html><html><div class='invoice-paper'>
  <div class='top-fold'>
    <div class='header'><div class='firm'><div class='firm-address'>4610 Sweetwater Blvd</div></div></div>
  </div>
  <div class='body'><table><tbody><tr><td>work</td></tr></tbody></table></div>
  <div class='footer'>
    <div class='invoice-payable'>Please make all amounts payable to: Romano &amp; Sumner, PLLC</div>
    <div class='invoice-payment-profile'>Please pay within 15 days.</div>
  </div>
  <div class='qr-code-preview-page-break'>- - - Page Break - - -</div>
  <div class='top-fold'>
    <div class='header'><div class='firm'><div class='firm-address'>4610 Sweetwater Blvd</div></div></div>
    <div class='invoice-information'><label>Invoice #</label>11617</div>
  </div>
  <div class="qr-code-page">
    <div class="qr-code-preview"><span class="qr-code-preview-text">QR here</span>${QR_TAG}</div>
    <div class="text-container">
      <div class="pay-your-invoice-header">Pay your invoice online</div>
      <div class="click-link">Or, <a href='#0' class='link'>click here</a></div>
    </div>
  </div>
  </div>
<div class='paper-footer'>Page 1 of 1</div>
</html>`;

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

describe("stripPaymentStub", () => {
  it("removes the whole payment stub but keeps the real header and footer", () => {
    const { html, removed } = stripPaymentStub(STUB_HTML);

    // The stub is gone: no page-break, no qr-code-page, no "Pay online" text.
    expect(html).not.toContain("qr-code-preview-page-break");
    expect(html).not.toContain("Page Break");
    expect(html).not.toContain('class="qr-code-page"');
    expect(html).not.toContain("Pay your invoice online");
    expect(html).not.toContain("qr-code-preview.svg");

    // The real invoice header (first .top-fold) survives — exactly one remains,
    // and the repeated invoice-number header is gone with the stub.
    expect((html.match(/class='top-fold'/g) || []).length).toBe(1);
    expect(html).not.toContain("Invoice #");

    // The footer (payable-to / pay-within-15-days) must stay on the invoice.
    expect(html).toContain("Please make all amounts payable to");
    expect(html).toContain("Please pay within 15 days");

    // The document still ends on the paper-footer, with the stub excised.
    expect(html).toContain("Page 1 of 1");

    // skipped/removed accurately names each part that went, in document order.
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("stripped payment-stub");
    expect(removed[0]).toContain("qr-code-preview-page-break");
    expect(removed[0]).toContain("repeated header");
    expect(removed[0]).toContain("qr-code-page");
  });

  it("does not touch a single .top-fold when there is no repeated header", () => {
    const html = `<div class='top-fold'>real header</div><div class='footer'>pay within 15 days</div>`;
    const { html: out, removed } = stripPaymentStub(html);
    expect(out).toBe(html); // nothing to strip
    expect(removed).toHaveLength(0);
  });

  it("defensively removes an einvoice-qr-code-container if present", () => {
    const html = `<div class='footer'>foot</div><div class='einvoice-qr-code-container'><img src='x'/></div>`;
    const { html: out, removed } = stripPaymentStub(html);
    expect(out).not.toContain("einvoice-qr-code-container");
    expect(out).toContain("foot");
    expect(removed[0]).toContain("einvoice-qr-code-container");
  });

  it("is a no-op on HTML with no payment stub", () => {
    const html = `<div class='top-fold'>header</div><div class='body'>work</div><div class='footer'>foot</div>`;
    const { html: out, removed } = stripPaymentStub(html);
    expect(out).toBe(html);
    expect(removed).toHaveLength(0);
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

  it("falls back to scanning /nix/store when nothing else matches (the prod failure mode)", () => {
    // PUPPETEER_EXECUTABLE_PATH unset, Nix chromium bin dir not on $PATH nor at
    // any well-known location — but the binary is in /nix/store.
    const found = findChromium({
      env: { PATH: "/empty" },
      exists: (p) => p === "/nix/store/abc123-chromium-131.0/bin/chromium",
      readdir: (p) => (p === "/nix/store" ? ["abc123-chromium-131.0", "def-nodejs-20"] : []),
    });
    expect(found).toBe("/nix/store/abc123-chromium-131.0/bin/chromium");
  });

  it("returns null when no browser is found anywhere", () => {
    expect(
      findChromium({ env: { PATH: "/nowhere" }, exists: () => false, readdir: () => [] }),
    ).toBeNull();
  });
});

describe("scanNixStore", () => {
  it("prefers a full chromium over the headless-shell variant", () => {
    const found = scanNixStore({
      readdir: () => ["h-chromium-headless-shell-131/", "abc-chromium-131.0", "x-nodejs-20"],
      // Both variants have a bin/chromium; the full build must win.
      exists: (p) =>
        p === "/nix/store/abc-chromium-131.0/bin/chromium" ||
        p === "/nix/store/h-chromium-headless-shell-131//bin/chromium",
    });
    expect(found).toBe("/nix/store/abc-chromium-131.0/bin/chromium");
  });

  it("returns null when /nix/store is absent", () => {
    const found = scanNixStore({
      readdir: () => {
        throw new Error("ENOENT");
      },
      exists: () => true,
    });
    expect(found).toBeNull();
  });
});

describe("renderBillPdf orchestration", () => {
  it("fetches preview → strips the stub → inlines assets → renders", async () => {
    // Preview HTML that carries the firm logo AND the full payment stub.
    const previewHtml = STUB_HTML.replace(
      "<div class='body'>",
      `<div class='body'><img src="${LOGO_URL}"/>`,
    );
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

    // The HTML handed to the renderer has the logo embedded and the whole
    // payment stub removed (page-break, repeated header, qr-code-page).
    expect(renderedHtml).toContain("data:image/jpeg;base64,");
    expect(renderedHtml).not.toContain("s3.amazonaws.com");
    expect(renderedHtml).not.toContain("qr-code-page");
    expect(renderedHtml).not.toContain("Page Break");
    expect(renderedHtml).not.toContain("Pay your invoice online");
    // Real header + footer survive.
    expect((renderedHtml.match(/class='top-fold'/g) || []).length).toBe(1);
    expect(renderedHtml).toContain("Please pay within 15 days");

    expect(result.buffer.toString("utf8")).toContain("%PDF");
    expect(result.inlined).toHaveLength(1);
    expect(result.skipped.some((s) => s.includes("payment-stub"))).toBe(true);
  });
});
