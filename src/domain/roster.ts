// ============================================================
// Firm roster + shared domain constants (single source of truth).
// Extracted from per-tool copies that had drifted into two distinct rosters.
// ============================================================

export type RosterMember = { initials: string; name: string; user_id: number };

// Full comp/dashboard roster (12) — used by download_dashboard_update and the
// Bonus Tracker. Includes the two Of-Counsel attorneys, Gus (KGV) and
// Courteney (CTD).
export const FIRM_ROSTER: RosterMember[] = [
  { initials: "PAR", name: "Paul Romano", user_id: 344117381 },
  { initials: "KES", name: "Kenny Sumner", user_id: 344134017 },
  { initials: "NRN", name: "Nicholas Noe", user_id: 348755029 },
  { initials: "NAF", name: "Nicholas Fernelius", user_id: 359380639 },
  { initials: "ACA", name: "Angela Alanis", user_id: 358528744 },
  { initials: "AFL", name: "Anna Lozano", user_id: 358108805 },
  { initials: "AKG", name: "Kaz Gonzalez", user_id: 358550509 },
  { initials: "TBS", name: "Tzipora Simmons", user_id: 359711375 },
  { initials: "MNH", name: "May Huynh", user_id: 359576660 },
  { initials: "JPB", name: "Jonathan Barbee", user_id: 360091325 },
  { initials: "KGV", name: "Gus Vlahadamis", user_id: 360049685 },
  { initials: "CTD", name: "Courteney Daniel", user_id: 359865560 },
];

// Development-meeting scorecard roster (10) — used by generate_firm_scorecard
// and download_firm_scorecard. Historically EXCLUDES the Of-Counsel attorneys
// (Gus/Courteney). This preserves the scorecard's existing membership exactly;
// whether it SHOULD also include them is a separate product question.
export const SCORECARD_ROSTER: RosterMember[] = FIRM_ROSTER.filter(
  (r) => r.initials !== "KGV" && r.initials !== "CTD",
);

// user_id -> initials, for the full firm roster.
export const INITIALS_BY_USER_ID: Record<number, string> = Object.fromEntries(
  FIRM_ROSTER.map((r) => [r.user_id, r.initials]),
);

export const MONTH_NAMES_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const MONTH_NAMES_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
