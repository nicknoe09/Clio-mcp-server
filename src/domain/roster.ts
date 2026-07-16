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
  // Jonathan Barbee — terminated July 2026. KEEP through 2026 year-end (like
  // AFL) so his Jan–Jul dashboard rows stay updatable and collections on his
  // old invoices keep attributing to his 26 Compare row; drop for 2027. He is
  // already off the weekly goal sheets (see WEEKLY_GOALS_ROSTER).
  { initials: "JPB", name: "Jonathan Barbee", user_id: 360091325 },
  { initials: "KGV", name: "Gus Vlahadamis", user_id: 360049685 },
  { initials: "CTD", name: "Courteney Daniel", user_id: 359865560 },
  // Stacy A. Bakri — Kenny's new paralegal (replacing Anna Lozano/AFL), started
  // June/July 2026. Real Clio user_id (sbakri@romanosumner.com) — hours, nonbillable,
  // and collections all attribute normally.
  { initials: "SAB", name: "Stacy Bakri", user_id: 360383465 },
];

// Collections-only roster (27) — every timekeeper that has a row in the 26 Compare
// month blocks, including former/staff billers who still collect on old invoices.
// Used ONLY for collections attribution (col N "Collected Actual" / col V
// "Originating") so each biller's row is filled individually; hours/billed/bonus stay
// on FIRM_ROSTER. Initials match the sheet's col C; names match Clio's "User" /
// attorney fields. (Billers with collections but no sheet row — e.g. Merari Zambrano —
// are intentionally absent and fall into the "NRB" safety-net row.)
export const COLLECTIONS_ROSTER: RosterMember[] = [
  ...FIRM_ROSTER,
  { initials: "RT",  name: "Rachel Trevino",       user_id: 344119597 },
  { initials: "ASI", name: "Alejandra Iriarte",    user_id: 359650460 },
  { initials: "GKN", name: "Grace Noe",            user_id: 358992379 },
  { initials: "LAK", name: "Lauren Amy Kutac",     user_id: 357646654 },
  { initials: "CWW", name: "Christopher Winiecki", user_id: 359138569 }, // Rachel files Christopher's collections under "CWW"
  { initials: "JAD", name: "Joshua Dunegan",       user_id: 359110445 },
  { initials: "EDS", name: "Elissa Silguero",      user_id: 358180835 },
  { initials: "MBY", name: "Mackenzie Yeager",     user_id: 358071005 },
  { initials: "CJW", name: "Carrie Wawarosky",     user_id: 359400169 }, // ...and Carrie under "CJW" (initials swapped vs the Clio names)
  { initials: "NSJ", name: "Naiymah Jackson",      user_id: 359125955 },
  { initials: "SKH", name: "Sara Hebert",          user_id: 357416614 },
  { initials: "EAH", name: "Elizabeth Hagelstein", user_id: 357344674 },
  { initials: "ASC", name: "Amy Coli",             user_id: 350677369 },
  { initials: "SPR", name: "Silvana Romano",       user_id: 358076135 },
  { initials: "LSH", name: "Lindsey Hebert",       user_id: 347911669 },
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
