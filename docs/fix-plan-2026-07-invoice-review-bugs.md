# Fix Plan — Invoice-Review Connector Bugs (reported 2026-07-02)

Source: Kenneth Sumner's bug report from the June draft-bill review run
(359 tool calls / ~75 min where ~110 / ~15 min should have sufficed).
Report was made against `main` @ `c665cf9` — the same SHA this analysis
was performed on, so all findings below are against the exact code he ran.

Three bugs reported:

| # | Symptom | Root cause (confirmed in code) | Risk | Priority |
|---|---------|-------------------------------|------|----------|
| 1a | `get_bill_line_items` silently returns a **different bill's** data under parallel load | JSON-RPC request-id collision in the shared per-session `StreamableHTTPServerTransport` — responses are routed by message id, and concurrent clients on one session overwrite each other's id→stream mapping | **Wrong-client edits** | P0 |
| 1b | `get_bill_line_items` times out on bills with more than ~50–60 lines | N unbounded parallel per-activity GETs to resolve timekeepers → Clio 429s → backoff pushes total time past the gateway timeout | Tool unusable on large bills | P0 |
| 2 | `get_time_entries(billed="false")` returns 0 entries for matters with a populated draft bill | `billed="false"` is mapped server-side to Clio `status="unbilled"`, which **excludes** `status="draft"` entries; the client-side `billed !== true` filter excludes them a second time | Broke the documented draft-bill pull path | P1 |
| 3 | `audit_draft_bills` counts 94 draft bills where per-matter scoping finds 95 | Client-side join drops bills: only `bill.matters[0]` is checked, and only **open** matters are in the join set | Silent undercount; audit can't be trusted | P2 |

---

## Bug 1a — cross-wired responses (the dangerous one)

### Root cause

`src/index.ts:182-253` keeps **one** `StreamableHTTPServerTransport` per MCP
session and routes every POST for that session through it. Inside the SDK
(`@modelcontextprotocol/sdk` 1.27.1, `webStandardStreamableHttp.js`), each
incoming JSON-RPC request is registered as:

```js
this._requestToStreamMapping.set(message.id, streamId);   // no collision check
```

and each outgoing response is routed by:

```js
const streamId = this._requestToStreamMapping.get(message.id);
```

The map is **session-global and keyed only by the JSON-RPC message id**.
When several clients share one session — exactly what happens when claude.ai
runs multiple subagents against a single connector session — each client
numbers its requests independently (1, 2, 3, …). Two in-flight requests with
the same id make the second `set()` silently overwrite the first mapping, so
request A's response is written to request B's HTTP stream. Because the id on
the delivered response matches what that client expected, the client accepts
it — **no error anywhere, just the wrong bill's data**. This matches every
observed repro (`22893→22776/Bui`, `22945→Peacock`, `22835→Owens`,
`22821→Mormino`, `22775→Whitlock`), all of which were sibling requests in the
same parallel batch, and matches Kenny's own suspicion ("multiple subagents
… getting each other's data").

No fix is possible in the tool payload: the entire JSON-RPC response is
swapped as a unit (which is why the returned `bill` metadata was
self-consistent with the wrong line items).

### Fix

**Primary: make POST handling stateless (per-request transport).**
This server is a pure request/response tool server — no server-initiated
sampling, no push notifications — so it does not need a long-lived shared
transport per session:

1. In `src/index.ts`, for each POST create a fresh
   `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` and a
   fresh `McpServer` via the existing `createMcpServer()` factory, connect,
   handle, and let both be garbage-collected with the request.
   Request-id collisions become structurally impossible — every request has
   its own transport with its own single-entry mapping.
2. `GET /mcp` (standalone SSE notification stream) returns 405; `DELETE /mcp`
   returns 405 or 200 no-op. The Streamable HTTP spec explicitly supports
   sessionless servers and claude.ai connectors work against them.
3. Keep the existing per-request auth (`authenticate`) and
   `als.run(ctx, …)` wrapping unchanged — per-user token isolation already
   works and is not implicated.

Watch-out: `createMcpServer()` registers ~23 tool modules per instance. That
is pure in-memory registration (no I/O), but measure it once; if it shows up
in latency, build the tool registry once and reuse it behind a factory.

**Defense-in-depth (belt and suspenders):**
- Log a distinctive line whenever a POST body's request id was seen and is
  still in flight for the same session **before** the stateless cutover ships,
  so we can confirm the diagnosis in production logs against Kenny's live
  repro offer. (After the cutover this becomes moot.)
- Add `get_server_version` deploy-SHA discipline to the rollout (Kenny
  already verifies fixes against `git_sha` — keep that working).

### Verification

- Unit/integration test: spin up the Express app in-process, open one
  session, fire two concurrent `tools/call` POSTs **with the same JSON-RPC
  id** for two different `get_server_version`-style echo tools (or a stub
  tool that echoes its argument), and assert each HTTP response body carries
  the payload for the argument it sent. This test fails on the current code
  and passes after the stateless cutover.
- Live confirmation: take Kenny up on his 5–10-bill live repro after deploy;
  each response's `bill.id` must equal the requested `bill_id`.

---

## Bug 1b — timeout on bills with >~50 lines

### Root cause

`src/tools/bills.ts:304-332`: after fetching line items, the tool resolves
each line's timekeeper with one `GET /activities/{id}` per unique activity,
all fired in a single unbounded `Promise.all`. For Beller (167 entries) that
is 167 concurrent Clio calls; Clio rate-limits, `withBackoff` sleeps
(retry-after × up to 4 attempts per call), and the aggregate blows through the
claude.ai gateway timeout. The comment in the code ("for a 50-line bill this
finishes in sub-second") matches the observed ~50–60-line failure threshold.

### Fix — delete the enrichment loop entirely

`/line_items` **already supports a top-level `user{id,name}` field**: the
draft-bill audit uses exactly that today
(`AUDIT_LINE_ITEM_FIELDS` in `src/tools/audit.ts:22-23`, protected by
`test/auditLineItemFields.test.ts`). PR #111 worked around the 2-level
nesting limit (`activity{id,user{…}}` → 400) by adding the per-activity
loop, but the 1-level `user{id,name}` selector makes the loop unnecessary:

1. Add `user{id,name}` to the `fields` in `get_bill_line_items`'s
   `/line_items` query (`src/tools/bills.ts:297`).
2. Map `timekeeper` from `li.user` and delete the `activityIds` /
   `userByActivityId` block (lines 304-332 and 354-357).

Result: a 167-line bill costs 1 bill GET + 1–2 paginated line-item GETs
(page size 200) — no fan-out, no rate-limit pressure, no timeout. This also
removes ~N API calls per bill from every invoice-review run.

### Verification

- Extend `test/auditLineItemFields.test.ts`'s pattern: assert
  `get_bill_line_items`'s field selector contains `user{id,name}` and does
  **not** contain 2-level nesting.
- Live: `get_bill_line_items(bill_id=22763)` (Beller, 167 entries) must
  return within normal latency with non-null timekeepers.

---

## Bug 2 — `billed="false"` no longer returns draft-bill entries

### Root cause

`src/tools/time.ts:41` maps `billed="false"` → Clio `status="unbilled"`.
Clio's `status` enum is `{billed, draft, unbilled, non_billable, billable,
written_off}` — entries sitting on a draft bill are `status="draft"`, so the
server-side filter excludes them before anything else runs. The client-side
filter at line 51 (`e.billed !== true`) excludes them a second time, because
Clio marks draft-bill entries `billed=true` (per the code's own comment at
lines 42-44). Kenny's remembered "billed=false returns draft entries"
behavior came from an older server that passed a `billed` param Clio simply
ignored (no filtering at all) — the current strict behavior is coded
deliberately but broke his workflow silently.

### Fix — give draft entries a first-class, documented path

Per Kenny's ask ("either restore it or bless the supported path"), do both
halves explicitly rather than quietly re-widening `billed="false"`:

1. **Add a `status` parameter** to `get_time_entries` exposing Clio's native
   enum (`draft | unbilled | billed | billable | non_billable | written_off`),
   passed straight through to `/activities`. `status="draft", matter_id=X`
   becomes the supported, single-call way to pull a draft bill's entries per
   matter — no date-bounding, no reconciliation step.
2. **Keep `billed="false"` = strictly unbilled** (current behavior), but fix
   the tool description to say exactly that: *"excludes entries on draft
   bills; use status='draft' for those"*. Reject the ambiguous combination
   (`billed="false"` + `status="draft"`) with a clear error.
3. Echo the applied filters (`applied_filters: {matter_id, status, …}`) in
   the response so batch callers can verify scope per Kenny's defensive
   pattern without extra calls.
4. Note for reviewers: `get_bill_line_items` (after Bug 1 fixes) remains the
   authoritative bill-scoped pull; `status="draft"` is matter-scoped (all
   draft bills on the matter), which is what his per-matter loop wants.

### Verification

- Unit test: `billed="false"` sets `status="unbilled"`; `status="draft"`
  passes through untouched and skips the `billed !== true` client filter;
  combination raises.
- Live: matter with a populated draft bill —
  `get_time_entries(matter_id, status="draft")` returns the same entry set
  and dollar total as the bill.

---

## Bug 3 — `audit_draft_bills` 94 vs 95

### Root cause

`src/tools/audit.ts:553-614` builds its bill list the opposite way from the
authoritative path Kenny compared against:

- It pulls **all firm-wide draft bills**, then keeps a bill only if
  `bill.matters?.[0]` — the **first** associated matter — is in the join set
  (`audit.ts:611-614`). A bill whose relevant matter is not in position 0 is
  silently dropped. Kenny's authoritative scan (`get_bills(matter_id=X,
  state="draft")` per matter) uses Clio's server-side `matter_id` filter,
  which matches the matter in any position.
- The join set itself contains only **`status: "open"`** matters
  (`audit.ts:559`). A draft bill on a pending/closed matter is dropped, while
  a per-matter scan over a wider matter list would find it.

Either mechanism (most likely the `matters[0]` join) silently eats exactly
one bill in his batch. The ~1 MB response size is unrelated to the count but
is worth capping while we're in the file.

### Fix

1. **Match on all associated matters**: replace the `matters?.[0]` check with
   `b.matters?.some((m) => matterIds.has(m.id))`, and when resolving
   `matterInfo` for a bill, pick the associated matter that is in the map
   (not blindly index 0). Apply the same change to the identical pull in
   `download_bill_audit` (`audit.ts:876-887`) — the code comment there says
   "identical data pull", keep it true.
2. **Make matter scope explicit**: add `matter_status` param (default
   `"open"`, allow `"all"`) so the audit can be run over the same universe as
   any external cross-check.
3. **Make the count self-auditing**: add to `summary`:
   `draft_bills_firmwide` (pre-join count), `draft_bills_matched`, and an
   `unmatched_sample` (first ~10 firm-wide draft bills that did not join,
   with their bill id + matters ids). A future 94-vs-95 becomes diagnosable
   from the response itself instead of requiring a 95-matter counter-scan.
4. **Response size**: add `flagged_by_bill` trimming (cap `note` length;
   optional `summary_only=true` param that omits per-entry detail). Keeps the
   response well under connector payload limits. This is opportunistic — the
   count bug is the deliverable.

### Verification

- Unit test for the join predicate: bill with the target matter at
  `matters[1]` must be included; bill with no matching matter excluded;
  `matterInfo` resolves to the matched matter, not `matters[0]`.
- Live: rerun for Kenny's responsible-attorney scope; `draft_bills_matched`
  must equal his per-matter count (95), or `unmatched_sample` must name the
  discrepancy explicitly.

---

## Sequencing & rollout

1. **PR 1 (P0): Bug 1b** — one-line field change + delete the enrichment
   loop. Small, zero-risk, immediately unblocks large bills. Ship first.
2. **PR 2 (P0): Bug 1a** — stateless transport cutover in `src/index.ts` +
   concurrency regression test. This is the wrong-client-edit risk; until it
   ships, Kenny's identity-check workaround stays mandatory guidance for all
   read paths. Coordinate the deploy and confirm via his live repro offer.
3. **PR 3 (P1): Bug 2** — `status` param + docs + filter-echo. Answers his
   "which path is supported going forward" question in the tool contract
   itself.
4. **PR 4 (P2): Bug 3** — join fix + self-auditing counts + size cap.
5. Each deploy is verifiable via `/health` `git_sha` / `get_server_version`
   (Kenny already uses this — reply to him with the SHA that carries each
   fix).

## Notes for the reply to Kenny

- Bug 1's mislabeling was **not** in the Clio query path at all — bill_id was
  always sent correctly; responses were swapped between concurrent requests
  at the MCP transport layer. His subagent theory was exactly right.
- His date-bounded `billed="all"` + matter.id verification workaround remains
  the right defensive pattern until PR 2 is deployed and confirmed live.
- After PR 3, the supported draft-bill pull is
  `get_time_entries(matter_id=…, status="draft")` (or `get_bill_line_items`
  for a specific bill once PR 1-2 are live) — no date-bounding needed.
