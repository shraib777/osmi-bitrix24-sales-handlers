# Client return review and linked billing requests

Both additions are opt-in and limited to RPA type 57. They reuse the existing
service, archive folder and distributed lease. No AI provider or credentials are
needed. Invoice/act files, stamps, email and EDO remain manual.

## Returned client documents

Enable `LEGAL_CLIENT_REVIEW_ENABLED=true` and set
`LEGAL_CLIENT_REVIEW_STAGE_ID=343` only after creating the matching
`client_review` stage and six optional CLIENT_RETURN/CLIENT_REVIEW fields.
Native client rejection actions must point to that stage. The worker requires
previous stage 321, a verified frozen outgoing version and a new returned file.
It stores both originals, then writes and downloads two working copies before
routing Other to 313 and named contract types to lawyer review 319.

The working DOCX retains client revision nodes and comment parts. Previously
untracked text differences are added as actual Word insertion/deletion revisions
with author `Автоматическое сравнение`. The accepted visible client text must
remain unchanged. There is no automatic acceptance/rejection or legal judgement.

Formatting-only changes always require lawyer inspection. Restructured tables,
ambiguous paragraph changes, intersections with protected client revisions,
textboxes, changed document-part structure, unsupported Word namespaces, PDF,
scans and unsafe/overlarge packages explicitly require manual comparison; the
working copy then contains the unmodified client original. A technical error
keeps the request waiting and retryable. An absent/newly unused return file
routes to the lawyer for comments in the feed without changing the project.
Prior client/head consent and version readiness are cleared for a new round.

## Request an invoice, act, or both

Enable `LEGAL_BILLING_APP_ENABLED=true` to expose the static local-app frontend
at `/legal/billing` and install handler `/legal/billing/install`. The server
never persists or logs OAuth request bodies. Install the app on the intended
Bitrix portal with `rpa,user_basic,placement`; register `REST_APP_URI` from app
context. Set `LEGAL_BILLING_APP_CODE` to the actual public `local.*` client ID
so the worker can populate the optional `BILLING_ACTION_URL` action field.

The SDK reads and creates requests as the currently authenticated employee,
never through the admin webhook. It rechecks the parent version, current
client and manager-head approvals, contract type and stage before creation.
Counterparty, contact, project/channel and parent link are reused; amount,
period/grounds, desired date and task are supplied by the employee. No parent
approvals or files are copied. The standalone billing route obtains fresh
manager-head approval. Duplicate/lost-response recovery uses a unique request
key. The parent contract does not change stage.

Eligible contract stages: 325,327,337,339,315. Supported source types:
2403,2405,2407,2409,2411,2415. NDA, guarantee and billing requests have no action.

## Verification

`npm test` covers the original service, archive, redlines, cancellation, retry
and user-authenticated request creation. Live validation uses synthetic files
only; never send a client email, create a signature or issue a real invoice to
exercise this feature. Keep `LEGAL_ROLE_SUMMARIES_ENABLED=false`.
