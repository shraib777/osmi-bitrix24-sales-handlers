# Legal RPA 57: role summaries and archive before handoff

The worker is restricted to the development process `Юридические документы — разработка` (RPA 57). AI generation and automatic email remain disabled. Native tasks retain all human approval decisions.

Successful native task actions enter the automatic stage `archive_handoff` (341). A priority worker captures original files and verified approval copies, writes an immutable receipt to the existing Bitrix Disk archive, prepares the next role's summary, then moves to the existing destination. It never completes an approval task on behalf of a person. Rejection and factual clarification routes remain native.

The next participant receives a task only after archival succeeds. While capture is pending the request remains on the automatic stage. Failures appear in the BP and are retried. Cancellation is checked again after capture. A timed-out successful move is reconciled by reading the item's stage instead of blindly replaying the business action.

Each receipt records the source and destination stages, actor, requested handoff time, input fingerprint, original file IDs, byte hashes and immutable Disk blob IDs. Existing document histories are retained. Periodic archival remains a recovery/reconciliation path; it is not the handoff completion condition.

Role summaries use existing request fields, explicitly labelled facts from the request, version-bound approval fields, and recent human comments. Amounts and legal conclusions are not inferred. Full details, documents and the feed remain accessible from the summary. No new required intake fields are introduced.

Required readonly RPA fields: `ROLE_SUMMARY`, `ROLE_SUMMARY_KEY`, `HANDOFF_RECEIPT_KEY` (all prefixed `UF_RPA_57_`). Add ROLE_SUMMARY to fields displayed by native tasks, without adding it to fields that users must fill.

Opt-in environment variables on the existing service:

```
LEGAL_ROLE_SUMMARIES_ENABLED=true
LEGAL_HANDOFF_ENABLED=true
LEGAL_HANDOFF_STAGE_ID=341
LEGAL_HANDOFF_POLL_MS=5000
```

Existing `LEGAL_ARCHIVE_*` settings, `LEGAL_PROCESS_FEEDBACK_ENABLED=true`, and `LEGAL_PROCESS_CANCELLATION_ENABLED=true` remain required. There is no new public endpoint, datastore or paid resource.

Before enabling, verify the stage code and type, preserve actual actors (manager author, structural head, lawyer U579, Anna U17, GD U1), and verify both client-entry origin guards accept 341. Test only synthetic files and requests. Email remains manual. A GD task represents the existing EDO step; this integration does not sign or upload documents to EDO.

AI/lawyer pair preservation remains a requirement of the future AI integration: the AI output must be archived before assigning lawyer review, and its generation ID must be carried to the corrected version. This update does not activate AI or fabricate a training pair from unrelated historical files.

Rollback must restore native successful action destinations together with disabling the handoff flag. Do not disable the processor while requests are still waiting on 341. Original routes and UI change evidence are retained in the local development project's `implementation/evidence/handoff-native-edit-result.json`.
