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

The spec declares no `securitySchemes` block, but the Custom Actions
documentation references OAuth tokens, and access is provisioned through the
Clio developer portal (Clio Platform apps). Practically: OAuth bearer tokens
issued to a developer-portal application — the same model as Manage v4, but note
this server's existing tokens are minted against `CLIO_BASE_URL` (`app.clio.com`)
with Manage scopes; whether an existing Manage token is honored by
`api.clio.com/grow` or a separate grant/scope is required must be verified
empirically before building tools on it.

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

## Relevance to this MCP server

This server currently only speaks Clio Manage API v4. The Grow v2 API opens up
intake/CRM data that Manage does not expose:

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

Open questions to resolve before implementing Grow tools:

- Whether the firm's existing Clio OAuth app (`CLIO_CLIENT_ID`) can be granted
  Grow API access, and whether per-attorney tokens in the vault work against
  `api.clio.com/grow` or a separate authorization flow/scope is needed.
- Rate limits (429 is documented, limits are not) — reuse `src/clio/rateLimit.ts`
  handling.
- Whether the firm's Grow subscription/region matches `CLIO_BASE_URL` (US).
