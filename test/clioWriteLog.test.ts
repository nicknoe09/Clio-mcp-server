import { describe, it, expect } from "vitest";
import { formatClioWriteLog } from "../src/clio/pagination";

describe("formatClioWriteLog — per-write audit line", () => {
  it("logs the signed-in attorney and the resolved Clio token owner", () => {
    expect(
      formatClioWriteLog(
        "POST",
        "/contacts",
        "kgonzalez@romanosumner.com",
        { id: 344134017, email: "kgonzalez@romanosumner.com" },
        "ok id=2537736530"
      )
    ).toBe(
      "[clio-write] POST /contacts signed_in=kgonzalez@romanosumner.com " +
        "clio_user=344134017 (kgonzalez@romanosumner.com) outcome=ok id=2537736530"
    );
  });

  it("marks the Clio user unverified when the identity guard failed open", () => {
    expect(formatClioWriteLog("POST", "/contacts", "kgonzalez@romanosumner.com", undefined, "ok")).toBe(
      "[clio-write] POST /contacts signed_in=kgonzalez@romanosumner.com clio_user=unverified outcome=ok"
    );
  });

  it("normalizes the signed-in email and tolerates a missing one", () => {
    expect(
      formatClioWriteLog("PATCH", "/tasks/1.json", "  Kenny@Firm.com ", { id: 1, email: "kenny@firm.com" }, "ok")
    ).toContain("signed_in=kenny@firm.com");
    expect(formatClioWriteLog("DELETE", "/tasks/1.json", undefined, undefined, "failed status=404")).toBe(
      "[clio-write] DELETE /tasks/1.json signed_in=unknown clio_user=unverified outcome=failed status=404"
    );
  });
});
