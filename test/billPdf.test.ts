import { describe, it, expect } from "vitest";
import {
  looksLikePdf,
  looksLikeBillResource,
  extractDownloadUrl,
  interpretBillPdfResponse,
  downloadBillPdfBuffer,
  downloadBillPdfBuffers,
  BillPdfDeps,
  BinaryResult,
} from "../src/clio/billPdf";

const PDF = Buffer.from("%PDF-1.7\n%fake bill pdf bytes");
const pdfResult: BinaryResult = { buffer: PDF, contentType: "application/pdf" };
const json = (body: any): BinaryResult => ({
  buffer: Buffer.from(JSON.stringify(body)),
  contentType: "application/json; charset=utf-8",
});

describe("looksLikePdf", () => {
  it("accepts by content-type", () => {
    expect(looksLikePdf(Buffer.from("x"), "application/pdf")).toBe(true);
  });
  it("accepts by magic bytes even with wrong content-type", () => {
    expect(looksLikePdf(PDF, "application/octet-stream")).toBe(true);
  });
  it("rejects JSON", () => {
    expect(looksLikePdf(Buffer.from('{"a":1}'), "application/json")).toBe(false);
  });
});

describe("looksLikeBillResource", () => {
  // The live 2026-07-13 shape: GET /bills/{id}.pdf returning the bill's
  // default fields instead of a render-job status.
  it("recognizes the bill default-field envelope", () => {
    expect(
      looksLikeBillResource({ data: { id: 1323892745, etag: '"abc"', number: 22386, state: "awaiting_payment" } })
    ).toBe(true);
  });
  it("does not flag a generation-job status", () => {
    expect(looksLikeBillResource({ data: { id: 5, state: "in_progress" } })).toBe(false);
    expect(looksLikeBillResource({ data: { state: "queued" } })).toBe(false);
  });
});

describe("extractDownloadUrl", () => {
  it("finds a nested presigned URL", () => {
    const url = "https://clio-bills.s3.amazonaws.com/abc?X-Amz-Signature=sig";
    expect(extractDownloadUrl({ data: { url } })).toBe(url);
  });
  it("finds a download_url key", () => {
    expect(extractDownloadUrl({ data: { download_url: "https://files.clio.com/bill" } })).toBe(
      "https://files.clio.com/bill"
    );
  });
  it("ignores .json self-links", () => {
    expect(extractDownloadUrl({ data: { url: "https://app.clio.com/api/v4/bills/1.json" } })).toBeNull();
  });
  it("prefers a pdf/download key over a generic url key", () => {
    const body = { url: "https://a.example.com/thing", pdf_url: "https://b.example.com/bill.pdf" };
    expect(extractDownloadUrl(body)).toBe("https://b.example.com/bill.pdf");
  });
  it("walks arrays", () => {
    const body = { data: [{ links: { href: "https://c.example.com/bill.pdf" } }] };
    expect(extractDownloadUrl(body)).toBe("https://c.example.com/bill.pdf");
  });
  it("accepts a bare string body", () => {
    expect(extractDownloadUrl("https://d.example.com/bill.pdf")).toBe("https://d.example.com/bill.pdf");
  });
  it("returns null for status-only bodies", () => {
    expect(extractDownloadUrl({ data: { state: "in_progress" } })).toBeNull();
    expect(extractDownloadUrl({ data: { id: 123, state: "queued" } })).toBeNull();
  });
});

describe("interpretBillPdfResponse", () => {
  it("classifies PDF bytes", () => {
    const probe = interpretBillPdfResponse({ buffer: PDF, contentType: "binary/octet-stream" });
    expect(probe.kind).toBe("pdf");
  });
  it("classifies JSON with a URL", () => {
    const probe = interpretBillPdfResponse(json({ data: { download_url: "https://x.example.com/b.pdf" } }));
    expect(probe).toMatchObject({ kind: "url", url: "https://x.example.com/b.pdf" });
  });
  it("classifies status JSON as pending", () => {
    const probe = interpretBillPdfResponse(json({ data: { state: "generating" } }));
    expect(probe.kind).toBe("pending");
  });
  it("classifies Clio error bodies as error", () => {
    const probe = interpretBillPdfResponse(json({ error: { type: "NotFound", message: "no such bill" } }));
    expect(probe).toMatchObject({ kind: "error", message: "no such bill" });
  });
  it("classifies non-JSON non-PDF as unrecognized", () => {
    const probe = interpretBillPdfResponse({ buffer: Buffer.from("<html>nope</html>"), contentType: "text/html" });
    expect(probe.kind).toBe("unrecognized");
  });
});

/** Scripted deps: each getBinary call per path pops the next response. */
function scriptedDeps(script: Record<string, BinaryResult[]>, urlFiles: Record<string, BinaryResult> = {}) {
  const calls: string[] = [];
  const deps: BillPdfDeps = {
    getBinary: async (path) => {
      calls.push(path);
      const queue = script[path];
      if (!queue || queue.length === 0) throw new Error(`unexpected getBinary(${path})`);
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    fetchUrl: async (url) => {
      calls.push(`URL:${url}`);
      const file = urlFiles[url];
      if (!file) throw new Error(`unexpected fetchUrl(${url})`);
      return file;
    },
    sleep: async () => {},
  };
  return { deps, calls };
}

describe("downloadBillPdfBuffer", () => {
  it("polls through pending states, then follows the download URL", async () => {
    const url = "https://s3.amazonaws.com/bills/7.pdf?X-Amz-Signature=s";
    const { deps, calls } = scriptedDeps(
      {
        "/bills/7.pdf": [
          json({ data: { state: "queued" } }),
          json({ data: { state: "in_progress" } }),
          json({ data: { url } }),
        ],
      },
      { [url]: pdfResult }
    );
    const out = await downloadBillPdfBuffer(7, { deps, pollIntervalMs: 1, timeoutMs: 1000 });
    expect(out.buffer.equals(PDF)).toBe(true);
    expect(calls.filter((c) => c === "/bills/7.pdf").length).toBe(3);
    expect(calls[calls.length - 1]).toBe(`URL:${url}`);
  });

  it("returns immediately when Clio serves PDF bytes directly", async () => {
    const { deps } = scriptedDeps({ "/bills/8.pdf": [pdfResult] });
    const out = await downloadBillPdfBuffer(8, { deps });
    expect(out.contentType).toContain("pdf");
  });

  it("falls back to the Accept header when the .pdf suffix 404s", async () => {
    const notFound: any = new Error("Request failed with status code 404");
    notFound.response = { status: 404 };
    const { deps, calls } = scriptedDeps({ "/bills/9": [pdfResult] });
    const orig = deps.getBinary;
    deps.getBinary = async (path, params, headers) => {
      if (path === "/bills/9.pdf") throw notFound;
      expect(headers).toMatchObject({ Accept: "application/pdf" });
      return orig(path, params, headers);
    };
    const out = await downloadBillPdfBuffer(9, { deps });
    expect(out.buffer.equals(PDF)).toBe(true);
    expect(calls).toContain("/bills/9");
  });

  it("fails fast on a Clio error body", async () => {
    const { deps } = scriptedDeps({ "/bills/10.pdf": [json({ error: { message: "bill is secured" } })] });
    await expect(downloadBillPdfBuffer(10, { deps })).rejects.toThrow(/bill is secured/);
  });

  it("rejects when the download URL doesn't serve a PDF", async () => {
    const url = "https://s3.amazonaws.com/bills/11.pdf?X-Amz-Signature=s";
    const { deps } = scriptedDeps(
      { "/bills/11.pdf": [json({ data: { url } })] },
      { [url]: { buffer: Buffer.from("<Error>expired</Error>"), contentType: "application/xml" } }
    );
    await expect(downloadBillPdfBuffer(11, { deps })).rejects.toThrow(/instead of a PDF/);
  });

  it("times out with the last Clio response in the error", async () => {
    const { deps } = scriptedDeps({ "/bills/12.pdf": [json({ data: { state: "still_generating" } })] });
    await expect(downloadBillPdfBuffer(12, { deps, timeoutMs: 5, pollIntervalMs: 100 })).rejects.toThrow(
      /still generating.*still_generating/s
    );
  });

  it("falls through to the /download alternate when .pdf keeps returning the bill resource", async () => {
    const billEnvelope = json({ data: { id: 20, etag: '"e"', number: 22386, state: "awaiting_payment" } });
    const { deps, calls } = scriptedDeps({
      "/bills/20.pdf": [billEnvelope],
      "/bills/20": [billEnvelope], // Accept-header alternate also serves JSON
      "/bills/20/download": [pdfResult],
    });
    const out = await downloadBillPdfBuffer(20, { deps, pollIntervalMs: 1, timeoutMs: 1000 });
    expect(out.buffer.equals(PDF)).toBe(true);
    expect(calls).toContain("/bills/20/download");
  });

  it("fails fast with guidance when Clio returns the bill envelope (no API PDF support)", async () => {
    const billEnvelope = json({ data: { id: 21, etag: '"e"', number: 9, state: "awaiting_payment" } });
    const { deps, calls } = scriptedDeps({ "/bills/21.pdf": [billEnvelope] }); // alternates unscripted → fail → swallowed
    await expect(downloadBillPdfBuffer(21, { deps, timeoutMs: 60_000 })).rejects.toThrow(
      /does not expose rendered bill PDFs.*get_bill_line_items.*awaiting_payment/s
    );
    // Fail-fast: exactly one probe of the .pdf route, no 45s poll loop.
    expect(calls.filter((c) => c === "/bills/21.pdf").length).toBe(1);
  });
});

describe("downloadBillPdfBuffers", () => {
  it("resolves a mixed batch and captures per-bill failures", async () => {
    const url = "https://s3.amazonaws.com/bills/2.pdf?X-Amz-Signature=s";
    const { deps } = scriptedDeps(
      {
        "/bills/1.pdf": [pdfResult],
        "/bills/2.pdf": [json({ data: { state: "queued" } }), json({ data: { url } })],
        "/bills/3.pdf": [json({ error: { message: "no PDF for this bill" } })],
      },
      { [url]: pdfResult }
    );
    const results = await downloadBillPdfBuffers([1, 2, 3], { deps, pollIntervalMs: 1, timeoutMs: 1000 });
    expect(results.get(1)).toMatchObject({ ok: true });
    expect(results.get(2)).toMatchObject({ ok: true });
    expect(results.get(3)).toMatchObject({ ok: false, error: expect.stringContaining("no PDF for this bill") });
  });

  it("marks never-ready bills as timed out without sinking the batch", async () => {
    const { deps } = scriptedDeps({
      "/bills/1.pdf": [pdfResult],
      "/bills/2.pdf": [json({ data: { state: "queued" } })],
    });
    const results = await downloadBillPdfBuffers([1, 2], { deps, pollIntervalMs: 50, timeoutMs: 10 });
    expect(results.get(1)).toMatchObject({ ok: true });
    expect(results.get(2)).toMatchObject({ ok: false, error: expect.stringContaining("still generating") });
  });

  it("fails bill-envelope bills fast in bulk without polling", async () => {
    const billEnvelope = json({ data: { id: 2, etag: '"e"', number: 9, state: "paid" } });
    const { deps } = scriptedDeps({
      "/bills/1.pdf": [pdfResult],
      "/bills/2.pdf": [billEnvelope],
    });
    const results = await downloadBillPdfBuffers([1, 2], { deps, pollIntervalMs: 1, timeoutMs: 60_000 });
    expect(results.get(1)).toMatchObject({ ok: true });
    expect(results.get(2)).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not expose rendered bill PDFs"),
    });
  });
});
