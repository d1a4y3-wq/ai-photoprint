# Security policy

## Reporting a vulnerability

Please report security issues **privately** using GitHub's *Report a vulnerability* feature (Security tab of this repository). Do not open a public issue. Include steps to reproduce and the affected file. We aim to acknowledge within 3 working days.

## Supported versions

Only the latest commit on the default branch is supported (pre-1.0 demo).

## Security model in one paragraph

The agent reads and prepares; a human decides. Access is checked **before** retrieval, so forbidden material never reaches the model. Untrusted text (documents, letters, transcripts, uploads) is treated as data, scanned for injections, fenced, and never executed. Secrets are masked before prompts and journal. Every outgoing action goes through a confirmation queue that only leadership can release. All actions are journaled append-only.

## Controls and the tests that enforce them

| Control | Test group (tests/demo-evals.ts and tests/evals.ts) |
|---|---|
| Permission filter before search, leak guard | core suite, groups on access and leak |
| Closed document equals non-existent (404, no title) | document and job groups |
| Injection patterns, Unicode normalisation, tainted flag | groups 36 and injection groups |
| DLP: secrets masked in queries, model context and journal | group 29, 36 |
| Confirmation only by leadership; idempotent sends | groups 25, 28, 36 |
| Only the model host in outbound code; closed dependency list | group 29 |
| Security headers, path traversal, rate limit | group 36 and manual probes |
| Atomic writes with owner-only permissions | group 36 |

## Production hardening checklist

**Identity and access**
- SSO (OIDC) with server-issued sessions; never trust a client-supplied user id.
- Map roles from the identity provider; deny by default; review access quarterly.

**Secrets and transport**
- Secrets only in a secret manager; rotate on a schedule and on suspicion.
- TLS everywhere; HSTS; mTLS between internal services.
- Disk encryption; backups encrypted and tested.

**Telegram connection**
- Use the Bot API with a webhook and verify `X-Telegram-Bot-Api-Secret-Token`.
- Keep an allow-list of chat and user ids; ignore everything else.
- Leave bot privacy mode on; never read groups or channels.
- Never send documents or protocols through the bot; send short notifications and deep links that require sign-in.
- Do not log message bodies; log ids and outcomes only.

**Email connection (Gmail or IMAP)**
- OAuth with the narrowest scopes: `gmail.readonly` and `gmail.compose` (drafts). No `mail.google.com` full access.
- Treat every message as untrusted text: same scan, fence and `tainted` flag as documents.
- Never send automatically: replies are drafts released by a human from the confirmation queue.
- Strip tracking pixels and remote images; never auto-follow links.
- Per-user mailbox only; no shared access tokens.

**Data**
- Raw audio retention limit (delete after protocol approval); documented retention for transcripts and journal.
- Insert-only audit table with hash chaining; restricted read access.
- Data residency: host in your jurisdiction and confirm legal requirements for personal data with counsel.

**Model providers**
- Contractual terms: no training on your data, retention limits, region.
- Send only permission-filtered, DLP-masked fragments; never audio.
- Provider fallback chain with health checks; log which provider answered.

**Operations**
- CI with tests, type check, dependency audit, secret scanning, SBOM.
- Incident runbook: revoke keys, review the journal, quarantine a poisoned document, notify affected users.

## Known gaps

See "Known limitations" in `README.md`. The largest is the absence of real authentication in the demo, which is acceptable only because the server listens on `127.0.0.1`.
