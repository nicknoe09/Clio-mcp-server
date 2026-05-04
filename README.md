# Clio MCP Server

Model Context Protocol server integrating Claude.ai with Clio Manage API v4 via Server-Sent Events (SSE) transport.

## Prerequisites

- Node.js 18+
- A Clio developer account with an API application registered
- Your Clio app must have **Redirect URI** set to `http://localhost:3000/oauth/callback` (no trailing slash)

## Clio App Registration

1. Go to [Clio Developer Portal](https://app.clio.com/nc/#/settings/developer_applications)
2. Create a new application
3. Set the **Redirect URI** to `http://localhost:3000/oauth/callback`
4. Copy the **Client ID** and **Client Secret**

## Setup

```bash
cd clio-mcp-server
npm install
```

Copy `.env.example` to `.env` and fill in your Clio credentials:

```bash
cp .env.example .env
```

```
PORT=3000
CLIO_BASE_URL=https://app.clio.com
CLIO_API_BASE_URL=https://app.clio.com/api/v4
CLIO_CLIENT_ID=your_client_id
CLIO_CLIENT_SECRET=your_client_secret
CLIO_REDIRECT_URI=http://localhost:3000/oauth/callback
CLIO_ACCESS_TOKEN=
CLIO_REFRESH_TOKEN=
```

## OAuth Bootstrap

1. Start the server: `npm run dev`
2. Open `http://localhost:3000/oauth/start` in your browser
3. Authorize the application in Clio
4. Tokens are automatically written to your `.env` file
5. Verify by checking that `CLIO_ACCESS_TOKEN` and `CLIO_REFRESH_TOKEN` are populated in `.env`

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
4. **Set all environment variables in the Railway dashboard** — Railway does NOT read `.env` files
5. Deploy
6. Test: `curl https://your-railway-url.up.railway.app/health`

## Claude.ai Integration

1. Go to Claude.ai → **Settings** → **Integrations**
2. Click **Add MCP Server**
3. Enter URL: `https://your-railway-url.up.railway.app/sse`
4. Save and verify connection

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
| **Wrong redirect URI** | Must match Clio app registration exactly — no trailing slash |
| **Empty/null nested data** | Every API call must include explicit `fields` parameter |
| **Missing records** | Pagination is required — without it, only first 200 records return |
| **Hours look wrong** | Clio stores time on `/activities` as seconds, but on `/line_items` as decimal hours — see `lineItems.ts:88-107` for the routing-aware conversion. `test_update_line_item` writes hours directly. |
| **Need to add a line to an existing draft bill** | Clio's API does not support `POST /line_items` (this was attempted in #28–#29 and removed in #30 after Clio rejected every shape). Line items are auto-generated when an activity is billed. To add work to an existing draft, log a new time entry via `create_time_entry` (it will appear on the matter's *next* draft, not the current one), or void the current draft via `set_bill_state(target_state="void")` and re-create it once the new activity is logged. |
| **`discount_line_item` returns 400 "discount{total}, discount{kind} are not valid fields"** | The current implementation in `lineItems.ts:418` sends `{ discount: { total } }`, which Clio's `PATCH /line_items` endpoint rejects. The correct field shape is unknown — Clio's auth-walled docs need consulting. Until fixed, line-item discounts must be applied through the Clio UI. |
| **Claude.ai won't connect** | Must use SSE transport (`/sse` endpoint), not plain REST |
| **Token not refreshing** | Verify `CLIO_REFRESH_TOKEN` is set; check Clio app credentials |
| **SSE connection drops** | Check Railway logs; ensure no proxy/firewall is terminating SSE connections |
| **Railway env vars** | Railway ignores `.env` files — set every variable in the Railway dashboard |
