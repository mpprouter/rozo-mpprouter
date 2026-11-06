# Direct provider response policy

Direct settlement relay responses carry a restrictive sandbox CSP and nosniff. JSON, structured JSON media types, plain text, and server-sent events retain their media types. Other or missing media types are returned as attachment downloads. Status, payment challenge/receipt headers, streaming body bytes, and settlement behavior are preserved. Provider headers that modify browser origin state or navigation are removed.

Clients that depend on inline HTML, PDF, image/audio rendering or a non-allowlisted Content-Type must treat the response as downloaded bytes. This policy applies across hosts serving the relay.

Validation: 25 focused isolated module checks passed; the corresponding production-bundle section passed the same 25 checks. These checks mock health and metrics persistence. They do not constitute browser end-to-end validation or a complete repository test run.

Release provenance: the initial rollout changed only the matching relay section in the active Worker module through the content-only API, preserving other module bytes and configuration. A later normal source build should incorporate this source change before replacing that rollout. The original source map was retained and may have shifted line mappings.

The source-sync commit intentionally skips dependency-installing CI under the owner's current restricted-execution instruction. The completed isolated checks and independent code/artifact review are the validation evidence for this narrow security change; no full CI pass is claimed.
