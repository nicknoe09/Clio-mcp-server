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
});
