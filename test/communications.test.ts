import { describe, it, expect } from "vitest";
import { formatCommunication } from "../src/tools/communications";

describe("formatCommunication", () => {
  it("maps Clio's type enum to the friendly phone/email label", () => {
    expect(formatCommunication({ type: "PhoneCommunication" }).type).toBe("phone");
    expect(formatCommunication({ type: "EmailCommunication" }).type).toBe("email");
  });

  it("passes an unknown type through unchanged", () => {
    expect(formatCommunication({ type: "Something" }).type).toBe("Something");
  });

  it("surfaces participants, matter, and the body", () => {
    const c = formatCommunication({
      id: 3,
      type: "EmailCommunication",
      subject: "Re: settlement",
      body: "Confirming the call.",
      date: "2026-08-01",
      matter: { id: 9, display_number: "00012-Smith" },
      user: { id: 5, name: "N. Noe" },
      senders: [{ id: 5, type: "User" }],
      receivers: [{ id: 42, type: "Contact" }],
      time_entries_count: 1,
    });
    expect(c.subject).toBe("Re: settlement");
    expect(c.matter).toEqual({ id: 9, display_number: "00012-Smith" });
    expect(c.senders).toEqual([{ id: 5, type: "User" }]);
    expect(c.receivers).toEqual([{ id: 42, type: "Contact" }]);
    expect(c.time_entries_count).toBe(1);
  });

  it("tolerates an empty object", () => {
    expect(formatCommunication({}).id).toBeUndefined();
  });

  it("returns the full body by default (single-record view)", () => {
    const long = "x".repeat(2000);
    const c = formatCommunication({ body: long });
    expect(c.body).toBe(long);
    expect(c).not.toHaveProperty("body_truncated");
  });

  it("truncates the body and flags it in preview (list) mode", () => {
    const long = "x".repeat(2000);
    const c = formatCommunication({ body: long }, true);
    expect(c.body).toHaveLength(500);
    expect(c.body_truncated).toBe(true);
  });

  it("does not flag a short body as truncated in preview mode", () => {
    const c = formatCommunication({ body: "short" }, true);
    expect(c.body).toBe("short");
    expect(c).not.toHaveProperty("body_truncated");
  });
});
