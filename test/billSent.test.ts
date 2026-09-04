import { describe, it, expect } from "vitest";
import {
  SUBMISSION_MARKER,
  buildSubmissionBody,
  buildSubmissionSubject,
  parseSubmissionBody,
  parseSubmissionCommunication,
  indexSubmissions,
  lookupSubmission,
  interpretSentWriteError,
  type ParsedSubmission,
} from "../src/tools/billSent";

const record = {
  bill_id: 1203846574,
  bill_number: "19796",
  sent_at: "2026-09-02",
  method: "email",
  recipient: "Harris County Probate Court No. 3",
  note: null,
  outlook_message_id: null,
};

describe("submission entry format — written and read by one definition", () => {
  it("round-trips a record through the body it writes", () => {
    expect(parseSubmissionBody(buildSubmissionBody(record))).toEqual(record);
  });

  it("round-trips the optional fields too", () => {
    const full = { ...record, note: "Fee application invoice", outlook_message_id: "AAMkAD-123" };
    expect(parseSubmissionBody(buildSubmissionBody(full))).toEqual(full);
  });

  it("writes a subject a human can read on the matter's Communications tab", () => {
    expect(buildSubmissionSubject("19796", "2026-09-02", "email")).toBe(
      "BILLSENT Invoice 19796 sent 2026-09-02 via email",
    );
    expect(buildSubmissionSubject(null, "2026-09-02", "mail")).toContain("Invoice unknown");
  });

  it("ignores a matter's ordinary logged emails and calls", () => {
    expect(parseSubmissionBody("Called the client about the hearing date.")).toBeNull();
    expect(parseSubmissionBody(undefined)).toBeNull();
    expect(parseSubmissionBody(null)).toBeNull();
  });

  it("rejects an entry that names no bill — it cannot be matched to one", () => {
    expect(parseSubmissionBody(`${SUBMISSION_MARKER}\nsent_at=2026-09-02\nmethod=email`)).toBeNull();
  });

  it("accepts an entry identified by invoice number alone", () => {
    const parsed = parseSubmissionBody(`${SUBMISSION_MARKER}\nbill_number=19796\nsent_at=2026-09-02\nmethod=mail`);
    expect(parsed).toMatchObject({ bill_id: null, bill_number: "19796", method: "mail" });
  });

  it("tolerates the CRLF bodies Clio returns for email communications", () => {
    const parsed = parseSubmissionBody(buildSubmissionBody(record).replace(/\n/g, "\r\n"));
    expect(parsed).toEqual(record);
  });

  it("keeps Clio's attribution on the parsed communication", () => {
    const parsed = parseSubmissionCommunication({
      id: 55,
      body: buildSubmissionBody(record),
      created_at: "2026-09-02T14:00:00Z",
      user: { id: 7, name: "Kenneth Sumner" },
      matter: { id: 900, display_number: "03081-In the Interest of James Young" },
    });
    expect(parsed).toMatchObject({
      communication_id: 55,
      bill_number: "19796",
      logged_by: "Kenneth Sumner",
      logged_at: "2026-09-02T14:00:00Z",
    });
  });
});

describe("indexing the ledger for the unsent-invoice report", () => {
  const entry = (over: Partial<ParsedSubmission>): ParsedSubmission => ({
    ...record,
    communication_id: 1,
    logged_by: "Kenneth Sumner",
    logged_at: "2026-09-02T14:00:00Z",
    matter: null,
    ...over,
  });

  it("finds a bill by id and by invoice number", () => {
    const index = indexSubmissions([entry({})]);
    expect(lookupSubmission(index, { id: 1203846574, number: null })).not.toBeNull();
    expect(lookupSubmission(index, { id: null, number: "19796" })).not.toBeNull();
    expect(lookupSubmission(index, { id: 999, number: "00000" })).toBeNull();
  });

  it("keeps the latest send when a bill was sent twice", () => {
    const index = indexSubmissions([
      entry({ communication_id: 1, sent_at: "2026-07-01" }),
      entry({ communication_id: 2, sent_at: "2026-09-02" }),
    ]);
    expect(lookupSubmission(index, { id: 1203846574 })).toMatchObject({
      communication_id: 2,
      sent_at: "2026-09-02",
    });
  });

  it("does not let one bill's entry clear another bill", () => {
    const index = indexSubmissions([entry({})]);
    expect(lookupSubmission(index, { id: 1203848929, number: "19798" })).toBeNull();
  });
});

describe("interpreting what Clio rejected on a last_sent_at write", () => {
  it("reads a rejected attribute as not writable", () => {
    for (const msg of [
      { error: { type: "ArgumentError", message: "unknown attribute 'last_sent_at' for Bill" } },
      { error: { message: "found unpermitted parameter: :last_sent_at" } },
      { error: { message: "last_sent_at is read-only" } },
    ]) {
      const v = interpretSentWriteError(400, msg);
      expect(v.writable).toBe(false);
      expect(v.verdict).toContain("not writable");
    }
  });

  it("reads a rejected value as an accepted attribute", () => {
    const v = interpretSentWriteError(422, { error: { message: "Last sent at is not a valid datetime" } });
    expect(v.writable).toBe(true);
    expect(v.verdict).toContain("writable");
  });

  it("says so plainly when Clio's message settles nothing", () => {
    const v = interpretSentWriteError(500, "<html>Something went wrong</html>");
    expect(v.writable).toBeNull();
    expect(v.status).toBe(500);
  });

  it("handles a string error body without throwing", () => {
    expect(interpretSentWriteError(400, "found unpermitted parameter: :last_sent_at").writable).toBe(false);
  });
});
