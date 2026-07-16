import { describe, it, expect } from "vitest";
import { formatReminder } from "../src/tools/reminders";
import { formatTimer } from "../src/tools/timers";

describe("formatReminder", () => {
  it("renames duration to duration_minutes and passes through nested refs", () => {
    const r = formatReminder({
      id: 5,
      duration: 30,
      next_delivery_at: "2026-08-01T09:00:00Z",
      state: "pending",
      notification_method: { id: 2, name: "Email" },
      subject: { id: 99, type: "Task" },
    });
    expect(r).toEqual({
      id: 5,
      duration_minutes: 30,
      next_delivery_at: "2026-08-01T09:00:00Z",
      state: "pending",
      notification_method: { id: 2, name: "Email" },
      subject: { id: 99, type: "Task" },
    });
  });

  it("tolerates an empty object", () => {
    expect(formatTimer({}).id).toBeUndefined();
  });
});

describe("formatTimer", () => {
  it("renames elapsed_time to elapsed_time_seconds and keeps the activity link", () => {
    const t = formatTimer({
      id: 7,
      start_time: "2026-08-01T10:00:00Z",
      elapsed_time: 1234,
      activity: { id: 555, type: "TimeEntry", note: "Drafting" },
    });
    expect(t).toEqual({
      id: 7,
      start_time: "2026-08-01T10:00:00Z",
      elapsed_time_seconds: 1234,
      activity: { id: 555, type: "TimeEntry", note: "Drafting" },
    });
  });
});
