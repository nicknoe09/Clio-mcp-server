# The bill `sent` flag — what Clio's API will and will not do

Answers the question in KES's 2026-09-02 request (`mark_bill_sent`): can the
server set a bill's sent flag?

## Finding: no. Clio v4 will not let anything but Clio set it.

Probed against the live firm account on 2026-09-02 (`probe_bill_pdf_apis`,
bill 1203846574):

| Route | Result |
| --- | --- |
| `POST /bills/{id}/send` | 404 — no such route |
| `POST /bills/{id}/share` | 404 — no such route |
| `POST /bills/{id}/deliveries` | 404 — no such route |
| `POST /bill_deliveries` | 404 — no such route |
| `POST /outbound_shares` | 404 — no such route |
| `POST /bill_printings` | 404 — no such route |
| `GET /bills/{id}.pdf` | 200, but returns JSON — no rendered PDF |

There is no send endpoint at all, and `last_sent_at` is read-only on the Bill
schema (`PATCH /bills/{id}` takes `state`, `due_at`, `memo`, `bill_theme`,
`number`, `discount`, `interest`, `tax_rate`, `use_grace_period`). The web
UI's "Send bill" flow is the only thing that writes the flag, and that flow is
not exposed to the API. So `sent` is not "has this invoice gone out" — it is
"did Clio email it," and a bill delivered any other way stays `sent=false`
permanently.

`mark_bill_sent` still attempts the native write on every run and reports
verbatim what Clio said, and `mark_bill_sent(dry_run=true)` asks the question
without writing anything (it PATCHes an intentionally invalid `last_sent_at`
and reads Clio's error). If Clio ever opens the field up, the tool starts
using it with no code change. Until then the ledger below is the record.

## Why this mattered

Mental health commitment invoices are billed to the court and emailed from
Outlook, so every one of them reads `sent=false` forever. The monthly
unsent-invoice report handled that with a matter-name rule: any unsent bill on
an "In the Interest of" matter was classified as court-submitted and dropped
from the report. Nothing verified it, so an invoice could be generated, never
sent, never paid, and never appear.

At the time of writing that rule was clearing **67 bills, $35,891.00** in
`awaiting_payment` — 17 of them ($8,679.00) more than 180 days out, 8
($4,610.00) more than a year.

## The replacement: a per-bill submission ledger

`mark_bill_sent` records a submission as a Clio Communication on the bill's
matter. That keeps it in Clio — no spreadsheet to keep in sync — puts it on
the matter's Communications tab, and carries Clio's own user attribution and
timestamp.

Subject (human-readable):

```
BILLSENT Invoice 19796 sent 2026-09-02 via email
```

Body (parsed by the report; `buildSubmissionBody` writes it,
`parseSubmissionBody` reads it, so the format has one definition):

```
BILLSENT
bill_id=1203846574
bill_number=19796
sent_at=2026-09-02
method=email
recipient=Harris County Probate Court No. 3
outlook_message_id=AAMkAD...
```

Pass `outlook_message_id` when the invoice went out by email: it points the
entry at a real sent message instead of a bare assertion.

`mark_bill_sent` is idempotent — a bill that already has an entry is returned
unchanged unless `force=true` (a genuine re-send).

## Evidentiary weight — pass the message id

A ledger entry is a tracking record, not proof of transmission. If the court
or the county auditor later disputes receipt, an internal log reads as evidence
of office practice rather than evidence that this invoice was actually
transmitted; the sent email, with its attachment, is the primary record, and a
reply or a signed fee order is stronger still. So:

- Always pass `outlook_message_id` for an emailed invoice — that is what ties
  the entry to a retained message.
- Keep the sent email and its attachment; the ledger points at it, it does not
  replace it.
- Don't assume a stale never-submitted invoice stays collectible. Chapter 574
  may set no statewide billing deadline, but the appointing court's standing
  order, county auditor procedure, and fiscal-year processing all cut against a
  very old request that nobody can show was ever submitted. That is the real
  cost of the 8 invoices now more than a year out.

## Wiring the report

Replace the "In the Interest of" rule with the verified field:

- `get_bills(verify_submissions=true)` adds `submitted_at`,
  `submission_method`, `submission_recipient`, `submission_logged_by` and
  `sent_or_submitted` to every bill, plus `unverified_count` and
  `unverified_balance` at the top level. `sent_or_submitted=false` is the
  action list: nobody can show those invoices went out.
- `get_bill_submissions(bill_id | bill_number | matter_id | sent_since |
  sent_before)` reads the ledger directly.

A bill on an "In the Interest of" matter with no ledger entry now stays on the
report until someone sends it and says so, which is the point.
