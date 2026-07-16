# Tool Expansion Scope — Clio API v4 vs. Current MCP Server

Gap analysis of the full Clio Manage API v4 OpenAPI spec (165 paths, 300 operations,
~80 resource groups) against this server's current tool surface (86 registered MCP
tools). Written 2026-07-16.

## Where we stand today

The 86 current tools are deep, not broad: they concentrate on **billing operations,
time/expense capture, and firm financial reporting**, built on roughly 15 of the
API's ~80 resource groups.

| Clio resource | Coverage today | Notes |
|---|---|---|
| Activities (time & expenses) | Full CRUD | create/update/delete, audit, convert-to-expense, on-behalf-of guard |
| Bills | Read + state changes + line-item surgery | draft audit, discount/merge/split, delete draft, PDF via preview/report fallback |
| Line Items | GET/PATCH/DELETE | via bill review workflows |
| Matters | GET/POST/PATCH | incl. custom-field search, rates, financial summary |
| Contacts | GET/POST/PATCH | |
| Tasks | Full CRUD | plain tasks only |
| Notes | GET/POST only | `search_notes`; no update/delete |
| Calendars / Calendar Entries | Full CRUD on entries; list calendars | |
| Users | list + who_am_i | |
| Reports / Report Presets | Generate, download, preset CRUD (partial) | heavy use for revenue/scorecard tooling |
| Allocations | GET | powers `get_payments` |
| Custom Fields | create/list/set values | matter + contact values |
| Expense Categories | GET | |
| Bank Accounts / Bank Transactions / Trust Line Items | GET | read-only trust balances |
| Documents | none (debug probe only) | `/documents` is only queried inside `debug_bill_fields` |

Everything else in the spec is currently untouched.

## Gaps, prioritized

Priorities assume this firm's profile: US civil litigation practice, Outlook/Microsoft
365 shop, existing custom AR/reporting stack in this server.

### Tier 1 — high value, low-to-medium effort

1. **Documents & Folders** (13 ops: `/documents` CRUD + download + copy, `/folders`
   CRUD + list). Biggest single gap. Tools: `list_documents`, `get_document`,
   `download_document` (S3 redirect flow), `upload_document` (multipart, the server
   already ships `multer`/`form-data`), `list_folders`, `create_folder`,
   `move_document`. Unlocks "pull the engagement letter for matter X" and saving
   generated deliverables (bill PDFs, reports) back into the matter file.
2. **Communications** (`/communications` CRUD). Log emails/phone calls to matters —
   pairs directly with the Outlook integration this stack already has (log an email
   thread to the matter from the morning-report workflow). Tools:
   `log_communication`, `get_communications`, `update_communication`.
3. **Reminders** (`/reminders` CRUD). Calendar tooling exists but reminders don't.
   Natural extension of `create_calendar_entry` / task tools.
4. **Timers** (`GET/POST/DELETE /timer`). Start/stop/read the running timer —
   "start a timer on matter X" is the most-asked-for time capture verb and it's
   3 small endpoints.
5. **Matter relationship subresources** (read-only, 5 ops):
   `/matters/{id}/client`, `/matters/{id}/contacts`, `/matters/{id}/related_contacts`,
   `/contacts/{id}/email_addresses`, `/contacts/{id}/phone_numbers`. Cheap GETs that
   remove multi-step lookups the model currently has to improvise.
6. **Notes update/delete** (`PATCH/DELETE /notes/{id}`). Rounds out an existing tool
   family; trivial.
7. **Outstanding Client Balances** (`GET /outstanding_client_balances.json`). A
   first-party AR endpoint that can cross-check (or simplify) the hand-rolled
   `get_ar_aging` logic.

### Tier 2 — high value, more design work

8. **Clio Payments** (`/clio_payments/links` CRUD, `/clio_payments/payments` GET).
   Generate and send payment links for outstanding bills; reconcile received online
   payments. Complements `set_bill_state` and the AR tooling. Write-side needs the
   same confirmation guards used elsewhere (cf. `on_behalf_of`).
9. **Court Rules / Matter Dockets** (`/court_rules/*`: jurisdictions, triggers,
   matter dockets + preview, service types — 12 ops). Deadline calculation from
   court rules is extremely high value for litigation, but the create-docket flow
   is multi-step (jurisdiction → trigger → preview → create) and deserves a guided
   tool design, not thin wrappers.
10. **Task Templates / Task Template Lists / Task Types** (15 ops). Apply a task
    checklist to a matter ("apply the new-probate-matter checklist"). List/apply
    first; template authoring later.
11. **Credit Memos & Interest Charges** (`GET /credit_memos*`, `GET/DELETE
    /interest_charges*`). Completes the billing picture — audits currently can't see
    credits or interest.
12. **Trust Requests & Bank Transfers** (`POST /trust_requests`, `GET
    /bank_transfers/{id}`). Write side of trust: request a trust deposit from a
    client. Read-only trust already exists, so this is a natural next step — with
    strong confirmation guards.
13. **Webhooks** (`/webhooks` CRUD). Infrastructure rather than a chat tool:
    event-driven flows (bill state changed → notify; new document → index) instead
    of polling. Needs a receiver endpoint in `src/routes/`.

### Tier 3 — situational / niche

14. **Activity Descriptions & Activity Rates** (10 ops) — billing-code and rate-card
    management; useful for admin workflows, rarely for attorneys day-to-day.
15. **Conversations / Conversation Messages** (6 ops) — Clio secure client messaging;
    only if the firm uses Clio for Clients messaging.
16. **Document Templates / Automations / Categories / Versions / Archives** (~16 ops)
    — document generation from templates is powerful but the firm already generates
    documents in this server via `docx`; scope after core Documents lands.
17. **Practice Areas, Matter Stages, Groups, Relationships** (12 ops) — mostly
    read-only lookups that improve `create_matter`/`get_matters` ergonomics
    (e.g. validate practice area names). Add lazily as needed.
18. **Report Schedules** (5 ops) — the platform already schedules its own reports.
19. **UTBMS Codes/Sets, Tax Rate Configurations, Bill Themes, Billing Settings,
    Currencies, Text Snippets, Custom Actions, Log Entries, Allocations detail** —
    add opportunistically if a workflow demands them.

### Not worth scoping

- **LAUK rates, Grants/Grant Funding Sources, Safe Custody** — UK legal aid /
  UK-specific features.
- **Damages, Medical Bills/Records** (14 ops) — personal-injury module; skip unless
  the firm takes on PI work.
- **Internal Notifications (My Events / Event Metrics)** — Clio UI plumbing.
- **`DELETE /matters`, `DELETE /contacts`** — destructive with heavy cascade;
  deliberately keep these out of an AI-facing tool surface.

## Cross-cutting notes for implementation

- The existing plumbing (`src/clio/pagination.ts` `fetchAllPages`, rate limiting,
  per-user token context, `on_behalf_of`-style write guards) generalizes to all of
  the above; new tool files follow the `src/tools/*.ts` + `server.tool()` pattern.
- Document download/upload is the only new transport shape (S3 redirect on GET,
  multipart POST); `billPdf.ts` already handles a redirect flow to crib from.
- Keep destructive verbs (delete matter/contact/document) either omitted or behind
  explicit-confirmation parameters, consistent with current design.
- Tool-count budget: MCP clients degrade with very large tool lists. Tier 1 adds
  ~15 tools (≈100 total). Before Tier 2, consider consolidating (e.g. one
  `manage_reminder` with an `action` param) or gating admin/debug tools behind
  `ENABLE_DIAGNOSTIC_TOOLS` as already done for probes.

## Suggested sequencing

1. **PR 1 — Documents & Folders** (read + download first, upload second).
2. **PR 2 — Quick wins**: notes update/delete, reminders, timers, matter/contact
   subresource lookups, outstanding client balances.
3. **PR 3 — Communications** (email/call logging, wired to Outlook workflows).
4. **PR 4 — Clio Payments links** + credit memos/interest charges for complete AR.
5. **PR 5 — Court rules & matter dockets** (guided deadline workflow).
6. **PR 6 — Task templates**; webhooks infrastructure as a separate track.
