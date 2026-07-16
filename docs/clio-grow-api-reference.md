# Clio Grow API v2 — Reference Digest

Source: https://docs.developers.clio.com/clio-grow/api-reference/ (OpenAPI spec
vendored verbatim at [`docs/clio-grow.openapi.yaml`](./clio-grow.openapi.yaml),
captured 2026-07-16).

This is a **new API surface**. Until recently the only public Clio Grow
integration point was the single Lead Inbox POST (`https://grow.clio.com/inbox_leads`)
authenticated with a per-account inbox token. The v2 API is a proper regional REST
API with read access to Grow contacts, matters, notes, users, leads, and sources,
plus a handful of writes. It is separate from the Clio Manage API v4 this server
already integrates with.

## Base URLs

| Region | Base URL |
|---|---|
| US | `https://api.clio.com/grow` |
| EU | `https://eu.api.clio.com/grow` |
| Canada | `https://ca.api.clio.com/grow` |
| Australia | `https://au.api.clio.com/grow` |

Developer portal: `https://developers.api.clio.com` (also region-prefixed:
`eu.` / `ca.` / `au.`).

## Authentication

The spec declares no `securitySchemes` block. The working model (Clio unified
login) has two layers:

- **Clio Identity** (`account.clio.com`, OIDC) is the sign-in layer shared by
  all Clio products. Identity tokens are for SSO only — Clio's own docs note
  Identity access tokens are not used for API calls.
- **API authorization** is a per-app OAuth grant. The app is *registered* in
  Clio's developer portal (`developers.api.clio.com`), but authorization runs
  through **Clio Identity at `account.clio.com`** — an Ory Hydra OAuth2 server:
  `https://account.clio.com/oauth2/auth` (authorize) and
  `https://account.clio.com/oauth2/token` (token). This is neither the portal
  domain nor the legacy Manage OAuth server (`app.clio.com/oauth/*`) — a Grow
  `client_id` is unknown to `app.clio.com` (it returns "client_id is
  incorrect"). Confirmed empirically: logging into `grow.clio.com` redirects to
  `account.clio.com/login?login_challenge=…`. The account host is global (not
  region-prefixed); the data region lives in `GROW_API_BASE_URL`. Defaults are
  overridable via `GROW_OAUTH_AUTHORIZE_URL` / `GROW_OAUTH_TOKEN_URL`, and
  `GROW_OAUTH_SCOPE` if Hydra requires an explicit scope.

This server integrates via a dedicated Clio Platform app (`GROW_CLIENT_ID` /
`GROW_CLIENT_SECRET`, created in the developer portal with redirect URL
`<PUBLIC_BASE_URL>/grow/oauth/callback`). Each attorney authorizes once at
`/grow/oauth/start`; the callback identifies them by calling Grow
`who_am_i` with the fresh token and matching the email to a provisioned
platform user, then stores the encrypted pair in the vault under provider
`clio_grow` (see `src/clio/growAuth.ts`). Grow calls prefer those tokens and
refresh them against `GROW_OAUTH_TOKEN_URL`; if none are stored, calls fall
back to the Manage token. `grow_who_am_i` reports which source was used
(`token_source`) and diagnoses failures.

Support: `api@clio.com` (API issues), `api.partnerships@clio.com` (partnerships).

## Conventions

- **Pagination:** cursor-based via `page_token`; list responses return
  `meta.paging.next` / `meta.paging.previous` URLs. (Manage v4 uses the same
  pattern, so `src/clio/pagination.ts` concepts carry over.)
- **Common list filters:** `created_since`, `updated_since` (ISO-8601),
  `ids[]` (max 50).
- **Envelope:** all payloads are wrapped in `{ "data": ... }`.
- **Errors:** `{ "error": { "status", "message" } }` with 400/401/403/404/422/429.

## Endpoints

| Method | Path | Operation | Notes |
|---|---|---|---|
| GET | `/contacts` | listContacts | `query` searches names/emails/phones |
| GET | `/contacts/{id}` | getContact | |
| GET | `/contacts/{contact_id}/notes` | listContactNotes | |
| POST | `/contacts/{contact_id}/notes` | createContactNote | `subject` (≤255) + `body` (≤65535) |
| GET | `/matters` | listMatters | filters: `inbox_lead_id`, `submitted_only` |
| GET | `/matters/{id}` | getMatter | |
| GET | `/matters/{matter_id}/notes` | listMatterNotes | |
| POST | `/matters/{matter_id}/notes` | createMatterNote | same shape as contact notes |
| GET | `/inbox_leads` | listInboxLeads | `state` **required**: `untriaged` \| `ignored`; `query` search |
| GET | `/inbox_leads/{id}` | getInboxLead | |
| POST | `/inbox_leads` | createInboxLead | required: `first_name`, `last_name`, `from_message`, `referring_url`, `from_source`; optional `email`, `phone_number`, `marketing_source.id` |
| GET | `/sources` | listSources | lead/marketing sources |
| POST | `/sources` | createSource | `name` unique per account (case-insensitive) |
| GET | `/users` | listUsers | |
| GET | `/users/who_am_i` | whoAmI | current user + account/firm name |
| GET | `/custom_actions` | listCustomActions | |
| POST | `/custom_actions` | createCustomAction | `label` (6–32 chars), `target_url` (https), `ui_reference` — only `matters/show` supported |
| DELETE | `/custom_actions/{id}` | deleteCustomAction | |

## Key schemas

- **contact** — `id`, `global_id` (ULID), **`clio_id` (Clio Manage contact ID if
  synced — the bridge to this server's Manage data)**, `name`, `first_name`,
  `last_name`, `emails[]`, `phone_numbers[]`, `type` (`Person`|`Company`),
  `status` (default set: Unassigned / Intake / Hired / Did Not Hire; accounts can
  define custom statuses), `matters[] {id}`, `addresses[]`, timestamps.
- **matter** — `id`, `global_id`, **`clio_id` (Manage matter ID if synced)**,
  `description`, `inbox_lead_id`, `hired_date`, `is_locked` (locked = read-only),
  `location`, `type`, `status`, `status_category` (`intake`|`hired`|`declined`),
  `client` (client_summary), `primary_contact` (deprecated — use `client`),
  `matter_assignee_ids[]`, timestamps. `inbox_lead_id`/`hired_date` may be redacted.
- **inbox_lead** — `id`, `first_name`, `last_name`, `email`, `phone_number`,
  `state`, timestamps. The create response additionally echoes `from_message`,
  `from_source`, `referring_url`.
- **source** — `id`, `name`, `category` (`standard`|`clio_email_marketing`),
  `is_editable`, timestamps.
- **user** — `id`, `first_name`, `last_name`, `email`, `account {id, firm_name}`,
  timestamps.
- **custom_action** — `id`, `label`, `target_url`, `ui_reference`, timestamps.
  Custom-action clicks include a single-use `custom_action_nonce` (60s expiry)
  that must be echoed as a query parameter on the follow-up API call, else 403.

## Implementation in this MCP server

Implemented: `src/clio/grow.ts` (HTTP client — same per-user bearer tokens,
401 refresh, and 429 backoff as the Manage layer; cursor pagination over
`meta.paging.next`) and `src/tools/grow.ts` (MCP tools covering every endpoint,
plus `get_grow_pipeline_report` and the `grow_who_am_i` auth probe). Base URL
is `GROW_API_BASE_URL` (default `https://api.clio.com/grow`; set the `eu.` /
`ca.` / `au.` host if the firm's Grow account is in another region).

The Grow v2 API opens up intake/CRM data that Manage does not expose:

1. **Pipeline visibility** — lead → intake → hired/declined funnel
   (`inbox_leads`, `matters.status_category`, `hired_date`), enabling intake
   conversion reporting alongside the existing billing/collections dashboards.
2. **Cross-linking** — Grow contacts and matters carry `clio_id` referencing the
   synced Manage records, so Grow intake data can be joined to Manage matters
   already served by tools like `get_matter` / `get_matter_financial_summary`
   (e.g. "revenue by lead source").
3. **Lead capture** — `POST /inbox_leads` supersedes the legacy token-based
   `grow.clio.com/inbox_leads` form endpoint.
4. **Notes writeback** — intake follow-up notes can be written to Grow contacts
   and matters.

Remaining unknowns (verify with `grow_who_am_i` after deploy):

- Whether the firm's Clio OAuth app already has Grow API access enabled, or
  needs it granted in the developer portal first.
- Actual rate limits (429 is documented, limits are not) — handled by the
  shared exponential backoff either way.
