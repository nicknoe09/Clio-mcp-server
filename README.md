# Clio MCP Server

Model Context Protocol server integrating Claude with the Clio Manage API v4 over
**Streamable HTTP** (`/mcp`), with **per-user Microsoft OAuth identity** and
**per-user Clio tokens** read from the companion platform's shared Postgres vault.

Every Clio action is attributed to the **acting attorney's own Clio account** — there
is no shared bearer secret and no shared Clio identity.

## Architecture

- **Transport:** Streamable HTTP at a single `/mcp` endpoint (POST/GET/DELETE),
  stateful per `mcp-session-id`. (The deprecated `/sse` + `/messages` transport is gone.)
- **Auth:** each request must carry `Authorization: Bearer <Microsoft v2 JWT>`. The
  token is validated against Microsoft's JWKS (issuer/audience/scope), the email is
  extracted and checked against an onboarding allowlist, and the session is bound to
  that identity.
- **Clio tokens:** preloaded per request from the platform's Postgres vault
  (`user_integrations`, AES-256-GCM envelope-encrypted), decrypted in-process, and
  exposed to the unchanged Clio HTTP layer via an `AsyncLocalStorage` context.

## Prerequisites

- Node.js 18+
- The companion platform deployed, with each attorney's Clio token stored in the
  shared Postgres vault (attorneys connect Clio on the platform's `/setup` page).
- A Microsoft Entra app registration exposing an API scope (`MCP_AUDIENCE` +
  `MCP_SCOPE_NAME`).
- The **same** Clio OAuth app credentials the platform uses (to refresh tokens).

## Setup

```bash
cd clio-mcp-server
npm install
cp .env.example .env   # then fill in the values (see .env.example for the full list)
```

Key variables: `DATABASE_URL` (as the bounded `noe_app` role), `APP_KEK_B64` (identical
to the platform), `MS_TENANT_ID` / `MS_CLIENT_ID` / `MCP_AUDIENCE` / `MCP_SCOPE_NAME`,
`ALLOWED_EMAILS` and/or `ALLOWED_EMAIL_DOMAINS`, `CLIO_CLIENT_ID` / `CLIO_CLIENT_SECRET`,
and `PUBLIC_BASE_URL`.

## Running

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build
npm start
```

Verify the server is running:

```bash
curl http://localhost:3000/health
# → {"status":"ok","server":"clio-mcp","version":"1.0.0"}
```

## Railway Deployment

1. Push this repo to GitHub
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repo
4. **Set all environment variables in the Railway dashboard** — Railway does NOT read `.env` files.
   At minimum: `DATABASE_URL` (the `noe_app` public-proxy URL), `APP_KEK_B64` (identical to the platform),
   `MS_TENANT_ID`, `MS_CLIENT_ID` (+ `MS_CLIENT_SECRET` if confidential), `MCP_AUDIENCE`, `MCP_SCOPE_NAME`,
   `ALLOWED_EMAILS`/`ALLOWED_EMAIL_DOMAINS`, `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`, and `PUBLIC_BASE_URL`.
5. Deploy
6. Test: `curl https://your-railway-url.up.railway.app/health` (expect `"transport":"streamable-http"`)

## Claude.ai Integration

1. Go to Claude.ai → **Settings** → **Integrations**
2. Click **Add MCP Server**
3. Enter URL: `https://your-railway-url.up.railway.app/mcp`
4. Complete the Microsoft sign-in when prompted (the connector discovers the server
   via `/.well-known/oauth-protected-resource` and runs the OAuth flow through
   `/authorize` + `/token`).
5. Only allowlisted attorneys who have connected Clio on the platform can use the tools.

## Tool Reference

| Tool | Description |
|------|-------------|
| `get_matters` | List matters with status/attorney/client filters |
| `get_matter` | Get single matter by ID or search query |
| `get_matter_financial_summary` | Per-matter snapshot: trust balance, WIP, outstanding AR |
| `get_stale_matters` | Find open matters with no recent activity |
| `get_billing_gaps` | Matters with WIP but no recent bill issued |
| `get_time_entries` | Time entries with date/user/matter/billed filters |
| `get_unbilled_time` | Unbilled time grouped by matter with totals |
| `get_expenses` | Expense entries with filters |
| `get_unbilled_expenses` | Unbilled expenses grouped by matter |
| `get_contacts` | Search contacts by name or email |
| `get_tasks` | Tasks with status/assignee/due date filters |
| `get_bills` | Bills with state/date filters and aging flags |
| `get_ar_aging` | Full AR aging report with bucket grouping |
| `get_wip_report` | Work-in-progress report with aging flags |
| `get_trust_balances` | Trust/IOLTA balances with low-balance and dormancy flags |
| `get_user_productivity` | Timekeeper hours and top matters |
| `get_utilization_report` | Utilization % per timekeeper with weekly trends |
| `get_realization_rate` | Billed vs worked value by timekeeper and matter |
| `get_timekeeper_realization` | Deep per-attorney: worked, billed, collected, effective rate |
| `reconcile_statement` | Match bank transactions against Clio expenses |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **Calendar entries land on "NRN - Claude Created" instead of a user's personal calendar** | `calendar_owner` on a CalendarEntry is a **Calendar ID**, not a User ID — these are separate Clio resources. Passing a User ID where Clio expects a Calendar ID returns 404; the MCP then falls back to the NRN Claude default. To put an event on a user's personal calendar, either: (a) use `assign_to_user_id` on `create_calendar_entry` / `update_calendar_entry` (looks up the user's Calendar resource automatically); or (b) use `list_calendars(creator_user_id=N)` to find the right Calendar ID and pass it explicitly via `calendar_owner_id`. |
| **Empty/null nested data** | Every API call must include explicit `fields` parameter |
| **Missing records** | Pagination is required — without it, only first 200 records return |
| **Need to see exactly what's on a specific bill (invoice review)** | Use `get_bill_line_items(bill_id)` — it filters by bill_id directly via Clio's `/line_items?bill_id=X` and returns only the lines currently on that bill, ordered as they appear (group_ordering, then date, then id). Do NOT use `get_time_entries(matter_id=X, billed="true")` for this — that filters by matter and sweeps in prior-bill entries plus unbilled activities, contaminating any per-bill review. |
| **Hours look wrong** | Clio stores time on `/activities` as seconds, but on `/line_items` as decimal hours — see `lineItems.ts:88-107` for the routing-aware conversion. `test_update_line_item` writes hours directly. |
| **Need to add a line to an existing draft bill** | Clio's API does not support `POST /line_items` (this was attempted in #28–#29 and removed in #30 after Clio rejected every shape). `POST /bills` doesn't exist either, and there's no `/refresh` endpoint — verified against Clio's full OpenAPI. Line items are only created by Clio when activities are pulled into a (regenerated) draft. To add work to an existing draft, log a new time entry via `create_time_entry`, then in Clio UI either click "Regenerate Draft" on the bill, or — if your plan doesn't expose Regenerate — run `delete_draft_bill(bill_id)` and click "Generate Bill" on the matter. The fresh draft will include all unbilled activities. |
| **Splitting a block-billed entry into multiple sub-entries** | Use `prepare_line_split(line_item_id, splits_json)`. It creates N new activities (inheriting date/user/rate from the original) and DELETES the original activity. To finalize on the bill: open Clio UI → bill → "Regenerate Draft" if available (varies by Clio plan); otherwise run `delete_draft_bill(bill_id)` then click "Generate Bill" on the matter in Clio UI. Strict total: split hours must equal the original line's hours. |
| **Combining multiple entries on a draft bill into one** | Use `merge_line_items(primary_line_item_id, secondary_line_item_ids_csv, new_note?)`. It optionally rewrites the primary's note with a merged narrative, then applies a 100% discount to each secondary so they stay visible at $0 on the bill (firm rule: don't delete, preserve audit trail). All lines must be on the same draft bill. Note: hours don't roll up to the primary — Clio silently ignores quantity edits for ActivityLineItem (see next entry), so this is a soft-combine that preserves per-line hours but zeroes secondaries' dollar contribution. Per-secondary errors are isolated. |
| **Hour edits on billed entries silently no-op** | Clio's `PATCH /line_items/{id}` accepts the `quantity` field in the request body for ActivityLineItem types and returns 200 OK, but **silently does not apply the change** — the line's quantity is sourced from the underlying activity record, which is locked while billed. Detected empirically 2026-05-04 via direct probe on bill 22263. `patchTimeEntrySmart` now has a silent-noop guard: if `patch.hours` was specified and `after.quantity` doesn't match within tolerance, it rolls back any sibling fields that did apply (note/price) and throws a 422 with `context: "billed_quantity_silently_ignored"`. So `update_billed_time_entry`, `apply_entry_revision`, and any other tool that uses `patchTimeEntrySmart` will now fail loudly when an hour-change can't be applied. To actually change hours on a billed entry: use `prepare_hour_change` (next entry). |
| **Reducing/increasing hours on a billed line** | Use `prepare_hour_change(line_item_id, new_hours, new_note?)`. It removes the line from the draft (unbilling the activity, unlocking `/activities`), then PATCHes the activity with the new quantity. The line is gone from the bill until you finalize in Clio UI: "Regenerate Draft" on the bill if available, or `delete_draft_bill(bill_id)` + "Generate Bill" on the matter. Multiple `prepare_hour_change` calls can be batched before a single finalize step. |
| **Hard-combining multiple lines into one (sum hours into primary, delete secondaries)** | Use `prepare_hard_combine(primary_line_item_id, secondary_line_item_ids_csv, new_primary_hours, new_note?, secondary_treatment?)`. Composition: prepare_hour_change on the primary (with new hours + optional new note), then delete_activity (default) or discount-100% (`secondary_treatment="discount_100pct"`) on each secondary. Per-secondary errors are isolated. Use this when you want one line containing the consolidated work; use `merge_line_items` when you want all original lines preserved (firm rule for routine combines). Finalize via "Regenerate Draft" or `delete_draft_bill` + "Generate Bill" — see hour-change entry. |
| **Stale draft bill needs a fresh regenerate** | If your Clio UI doesn't expose a per-bill "Regenerate Draft" option (varies by plan/matter type), use `delete_draft_bill(bill_id)`. Refuses if the bill is not in 'draft' state. The underlying activities are NOT deleted — they revert to unbilled and you can immediately rebuild a clean draft via Clio UI ("Generate Bill" on the matter). The new draft includes all unbilled activities for the matter within the relevant date range. **Tradeoff**: any manual edits previously made to the deleted draft (note tweaks, line-level discounts, custom ordering) are lost; the new draft starts from raw activities. Use only when the manual-edit cost is acceptable. |
| **Claude.ai won't connect** | Use the Streamable HTTP endpoint (`/mcp`), not `/sse`. Confirm `PUBLIC_BASE_URL` matches the externally reachable origin so OAuth discovery resolves. |
| **401 with `WWW-Authenticate`** | The Microsoft JWT is missing/invalid, lacks the required scope, the email isn't on the allowlist, or the user isn't provisioned on the platform. |
| **`Clio not connected` on a tool call** | The authenticated attorney has no `clio` row in the vault — they must connect Clio on the platform's `/setup` page. |
| **Token not refreshing** | Verify `CLIO_CLIENT_ID`/`CLIO_CLIENT_SECRET` match the platform's Clio app; refreshed tokens are written back to the vault. |
| **`set_config`/RLS returns no rows** | Connect as the bounded `noe_app` role (not the superuser); the tenant context is set per transaction automatically. |
| **Railway env vars** | Railway ignores `.env` files — set every variable in the Railway dashboard |
