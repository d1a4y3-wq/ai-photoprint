# Architecture

## Request lifecycle

1. The browser calls `/api/...` with the acting user id (demo identity; production: a server session).
2. `server.ts` applies: rate limit, body size limit, JSON parse, security headers, then resolves the **Actor** (`id`, `role`, `scopes`) via `load.ts`.
3. Every domain function takes the `Actor` as its first argument. There is no data read that bypasses it.
4. Errors that carry a numeric `status` become that HTTP status with a human message. 403 and 404 caused by access checks are written to the journal as refusals.

## Modules

| Area | Files |
|---|---|
| Identity and rights | `types.ts`, `roles.ts`, `access.ts`, `load.ts` |
| Untrusted text defence | `injection.ts` (scan, fence, system prompt), `dlp.ts` (secret masking), `docs.ts` (upload and local-folder intake) |
| Model gateway | `model.ts` (live model with timeout, fallback to fixtures; the only network code) |
| Meetings | `meetings.ts`, `meeting-prep.ts`, `invitations.ts`, `recording.ts`, `audio.ts`, `protocol.ts`, `decisions.ts` |
| Tasks and Bitrix24 | `tasks.ts`, `bitrix.ts` (mock), `once.ts` and `journal.ts` (idempotency), `work.ts` |
| Documents and jobs | `docs.ts`, `doc-jobs.ts` (five job kinds, follow-up chat, persistence) |
| Confirmation | `outbox.ts` (invitations, replies, task batches), `connections.ts` (what each integration may see and do) |
| Control | `audit.ts`, `route.ts` (data route map), `overview.ts`, `settings.ts`, `team.ts`, `shares.ts`, `knowledge.ts` |
| Infrastructure | `atomic.ts` (atomic owner-only writes), `clock.ts`, `server.ts` |

## Retrieval (RAG)

* Documents are split by paragraph; each chunk inherits `allow`, `scope` and the document's `tainted` flag.
* `search(actor, docs, query)` first reduces the corpus to `visibleDocs(actor, docs)`, **then** scores chunks by whole-word overlap (no substring matches).
* Before anything is sent to a model: `assertNoLeak` re-checks every chunk against the actor, `maskChunks` masks secrets, `wrapForModel` fences each chunk and records injection findings.
* The model is asked to cite document and item; for protocols the code verifies citations and segment numbers.
* Production option: embeddings are acceptable only if the ACL filter is part of the **index query**; post-filtering is a design defect.

## Persistence

| What | Format | Writer |
|---|---|---|
| Journal | JSON Lines, append-only | `journal.append` (masks secrets, mode 0600) |
| Meetings state, shares, team, settings, outbox, jobs, Bitrix mock | JSON | `writeFileAtomic` (temp file + rename, mode 0600, dir 0700) |
| Recordings and protocols | files under `meetings/<id>/` | `writeFileAtomic` |
| Knowledge entries | JSON + Markdown | `writeFileAtomic` |

Idempotency: `createOnce(key, factory)` (key = hash of source and normalised content) returns the previously created object on a retry. Used for Bitrix tasks, invitations and replies.

## Prompt-injection defence, layer by layer

1. **Intake scan** (`scan`): patterns for instruction reset, role spoofing, tag spoofing, exfiltration through links, shell one-liners, secret requests, "hide this from the user"; Unicode normalised (NFKC) and invisible/bidi characters stripped first.
2. **Taint propagation**: one finding marks the whole document and every chunk.
3. **Fence**: chunks are wrapped in explicit markers; the system prompt states that text inside the markers is data and must not be obeyed.
4. **Capability limits**: the model has no tools, no network, no file access. It returns text; code decides what happens.
5. **Output verification**: citations and numbers are checked against the source; invented owners or dates are rejected.
6. **Human gate**: any outward action waits in the confirmation queue.
7. **Visibility**: the finding is shown to the user on the Decisions page and written to the journal.

## Secure connection design for Telegram and email (production)

Implemented today as mocks behind the same interfaces (`messenger.ts`, outbox, `connections.ts`). Requirements for the live version:

* **Least privilege**: Gmail `gmail.readonly` + `gmail.compose`; Bitrix24 `task` + `user`; Telegram bot with privacy mode on.
* **Authenticity**: Telegram webhook `secret_token` verified on every call; allow-listed chat ids; OAuth tokens per user, stored in a secret manager.
* **Untrusted content**: inbound mail and chat messages pass through the same scan, fence and taint pipeline as documents.
* **No autonomous sending**: every outgoing message is a preview in the confirmation queue; DLP runs on the outgoing text too.
* **No leakage through logs**: bodies are never logged; the journal stores ids and outcomes; secrets masked at the journal boundary.
* **Network**: one egress allow-list; TLS only; no redirects followed from message links.

## Single-file build

`scripts/build-standalone.mjs` bundles `src/server.ts` with esbuild into the browser, replacing Node modules (`fs`, `path`, `crypto`, `http`, `url`) with in-memory shims in `scripts/shims/`, embeds data and fonts, and rewrites path routing to hash routing. The same API code runs inside the page. The model is never called from this build: there is no API key inside a distributable file, so it always runs in code-only mode.
