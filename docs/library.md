# Library, identity and storage: design and API contract

Status: being built (October 2026). This document is the contract between the server and the web app. Both sides implement it exactly; change it here first.

## Decisions

- **Private libraries.** Every document and folder belongs to exactly one account (`owner`); all reads, writes, search, tags, links and MCP tools are scoped to the caller. Sharing is deliberately not a feature. Unowned rows from a legacy import go to the sole account at import time, or to the first account that signs in.
- **Identity is Keycloak** (realm `Agents` at `https://auth.donkeywork.dev`). The web app signs in with OpenID Connect, Authorization Code + PKCE, public client `notebook-duplex`. The server verifies the access token (RS256, issuer `https://auth.donkeywork.dev/realms/Agents`, JWKS fetched from the in-cluster Keycloak address) on every `/api` request. The old static notebook key is gone.
- **Agent sessions authenticate with a personal access token** minted in the UI (`ndp_…`, shown once, stored hashed). The MCP endpoint and the stdio shim use it. Every job records which user asked.
- **Documents live in SeaweedFS** (the lab's central S3 on attic, bucket `notebook-duplex`): one object per document holding the editor state (Tiptap JSON plus jobs, proposals and activity), written on every save, plus an archived copy per accepted revision. **Postgres holds the catalogue**: metadata, folder path, front matter, tags, full-text index, links, tokens. Postgres is `pgvector/pgvector:pg17`; an `embedding vector(1024)` column exists but nothing fills it yet.
- **Folders are paths** on the document (`/`, `/projects/lab`), not rows. Creating a folder is creating a document inside it or an empty folder marker. Moving a document is changing its path.
- **Front matter is the document's properties.** Markdown import reads a leading YAML block; export writes one. Known keys: `title`, `tags`, `folder`, `aliases`, `created`, `updated`; unknown keys are kept verbatim in `frontmatter`.
- **Tags link documents.** Tags are lowercase slugs. Two documents sharing a tag are related. Wikilinks (`[[Title]]`) are parsed into `links` rows as well and render as links to `/d/<id>` when the title resolves.
- **Search is Postgres full text** (`websearch_to_tsquery`, `ts_rank_cd`, `ts_headline`) over title, tags and body text, with trigram similarity on titles as a fallback for typos.

## Postgres schema (migrations in `server/db.mjs`)

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

create table users (
  sub text primary key,            -- Keycloak subject
  email text, name text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table documents (
  id uuid primary key,
  title text not null,
  folder text not null default '/',           -- normalised: leading slash, no trailing slash, '/' for root
  slug text not null,                         -- url-safe title, unique within folder
  tags text[] not null default '{}',
  frontmatter jsonb not null default '{}',    -- full front matter including unknown keys
  body_text text not null default '',         -- plain text for search and snippets
  word_count int not null default 0,
  revision int not null default 0,
  state_key text not null,                    -- S3 object key of the current state blob
  owner text references users(sub),
  updated_by text references users(sub),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(tags_tsvector(tags), 'B') ||             -- immutable wrapper: to_tsvector('simple', array_to_string(tags, ' '))
    setweight(to_tsvector('english', coalesce(body_text,'')), 'C')) stored,
  embedding vector(1024),
  unique (folder, slug)
);
create index documents_search on documents using gin (search);
create index documents_tags on documents using gin (tags);
create index documents_title_trgm on documents using gin (title gin_trgm_ops);
create index documents_folder on documents (folder) where deleted_at is null;

create table folders (                       -- empty folders only; folders with documents are implied
  path text primary key,
  created_by text references users(sub),
  created_at timestamptz not null default now()
);

create table links (                         -- explicit links parsed from the document
  from_id uuid references documents(id) on delete cascade,
  to_id uuid references documents(id) on delete cascade,
  kind text not null,                        -- 'wikilink' | 'url'
  primary key (from_id, to_id, kind)
);

create table access_tokens (
  id uuid primary key,
  user_sub text not null references users(sub),
  name text not null,
  token_hash text not null unique,           -- sha256 of the full token
  prefix text not null,                      -- first 10 chars for display
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table revisions (                     -- archive index; bodies are in S3
  document_id uuid references documents(id) on delete cascade,
  revision int not null,
  state_key text not null,
  author text,
  created_at timestamptz not null default now(),
  primary key (document_id, revision)
);
```

## S3 layout (bucket `notebook-duplex`)

- `docs/<id>/state.json` current state blob: `{ document: { id, revision, json, title }, jobs, proposals, activity }` (the existing Store state).
- `docs/<id>/rev/<n>.json` archived state at revision `n`, written when a proposal is accepted or every 50 revisions.
- `docs/<id>/export.md` latest Markdown export with front matter (rewritten on save, used by `get_document` and downloads).

## Environment

| Variable | Purpose | Lab default |
| --- | --- | --- |
| `DATABASE_URL` | Postgres | `postgres://notebook:<pw>@postgres.notebook-duplex.svc.cluster.local:5432/notebook` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | SeaweedFS | `http://192.168.10.11:30833`, `notebook-duplex`, from secret, `us-east-1`; path-style |
| `OIDC_ISSUER` | token `iss` | `https://auth.donkeywork.dev/realms/Agents` |
| `OIDC_JWKS_URL` | where the server fetches keys | `http://keycloak.infrastructure.svc.cluster.local:8080/realms/Agents/protocol/openid-connect/certs` |
| `OIDC_CLIENT_ID` | expected `azp` | `notebook-duplex` |
| `OIDC_AUTHORITY_PUBLIC` | what the browser uses (served by `/api/config`) | `https://auth.donkeywork.dev/realms/Agents` |
| `DATA_DIR` | legacy single-document `state.json` to import on first boot | `/data` |

Local development without Keycloak: `AUTH_DEV_USER=dev@example.com` makes the server accept any request as that user and the UI skip sign-in. Never set in the cluster.

## HTTP API

All routes except `/healthz`, `/api/config` and static files require `Authorization: Bearer <keycloak access token>` or `Authorization: Bearer ndp_<token>`. Responses carry `X-Build`.

Auth and config
- `GET /api/config` → `{ authority, clientId, build }` (no auth).
- `GET /api/me` → `{ sub, email, name, mcpUrl }`.
- `GET /api/tokens` → `[{ id, name, prefix, createdAt, lastUsedAt }]`; `POST /api/tokens { name }` → `{ id, name, token }` (token shown once); `DELETE /api/tokens/:id`.

Library
- `GET /api/library` → `{ folders: ['/', '/projects', …], documents: [{ id, title, folder, slug, tags, wordCount, updatedAt, updatedBy }] }` (not deleted, sorted by folder then title).
- `POST /api/documents { title?, folder?, markdown?, tags? }` → document summary. `markdown` may carry front matter which wins over the other fields.
- `GET /api/documents/:id` → `{ id, title, folder, slug, tags, frontmatter, revision, updatedAt, updatedBy, owner, related: [{ id, title, folder, sharedTags: ['tag', …] }], links: { out: [...], in: [...] } }` (`related` is sorted by the number of shared tags).
- `PATCH /api/documents/:id { title?, folder?, tags?, frontmatter? }` → summary. Renames update `slug`; folder moves update `folder`.
- `DELETE /api/documents/:id` → soft delete (sets `deleted_at`). `POST /api/documents/:id/restore`.
- `GET /api/documents/:id/export.md` → Markdown with front matter (download).
- `POST /api/folders { path }` → `{ path }`; `DELETE /api/folders?path=` (only if empty).
- `GET /api/search?q=&folder=&tag=&limit=` → `{ results: [{ id, title, folder, tags, snippet, rank, updatedAt }] }`.
- `GET /api/tags` → `[{ tag, count }]`; `GET /api/tags/:tag` → documents with that tag.

Document editing (the existing routes, now per document; `:id` is the document id)
- `GET /api/d/:id/state?lite=1`, `POST /api/d/:id/sync`, `POST /api/d/:id/jobs`, `POST /api/d/:id/cancel`, `POST /api/d/:id/review`, `POST /api/d/:id/demo`, `POST /api/tts`, `POST /api/describe`.
- `sync` additionally accepts `frontmatter` and `title`; the server updates the catalogue row (title, tags, folder from front matter if present, body_text, word_count) in the same request.

MCP (`/mcp`, bearer `ndp_` token only)
- Existing tools gain document awareness: `claim_job` returns `documentId` and `documentTitle`; `get_document_snapshot({ documentId })` reads any document; `propose_changes` and `set_block_status` take the document from the job.
- New tools: `list_documents({ folder? })`, `search_documents({ query, tag?, limit? })`, `get_document({ documentId })` → Markdown with front matter, `create_document({ title, folder?, markdown })` (creates a new document directly; this is the one write that needs no acceptance because it does not alter existing text, and the writer sees it appear in the library).
- Channel notifications include `document_id` and `document_title` in `meta`.

## Server notes and additions (October 2026 implementation)

Where the server differs from or adds to the text above:

- **Schema**: Postgres rejects `array_to_string` in a generated column (not immutable), so the migration defines `tags_tsvector(text[])` as an immutable SQL wrapper with the same result and uses it in the `search` column. Migrations are tracked in `schema_migrations (version, applied_at)` under an advisory lock.
- **Front matter storage**: `title`, `tags` and `folder` are catalogue columns; the `frontmatter` column holds every other key (`aliases`, `created`, custom keys). `GET /api/documents/:id` and the `document` in `/api/d/:id/state` return the composed full front matter (`title`, `tags`, `folder`, `aliases`, custom keys, `created`, `updated`). Sending `frontmatter` on `PATCH` or `sync` is authoritative for tags (omit `tags` to clear them) and for custom keys; `title`/`folder` inside it update the columns; `created`/`updated` are ignored on write (`updated` is always `updated_at`).
- **`sync`** returns the Store document plus `folder`, `slug`, `tags`, `frontmatter`, `updatedAt`, `updatedBy`. The `document` object in `/api/d/:id/state` carries the same extra fields.
- **Deleted documents** answer 404 on `/api/d/:id/*`; `GET /api/documents/:id` and `export.md` still work so a restore UI can show them. Restoring re-derives the slug if the name was taken meanwhile.
- **`GET /api/config`** also returns `devUser` (the email) when `AUTH_DEV_USER` is set, so the UI can skip sign-in; it is absent otherwise. **`GET /api/me`** adds `via` (`oidc` | `token` | `dev`). Sessions in `state` carry `user` (display name of the token owner). Jobs carry `requestedBy: { sub, name }` and `documentTitle`.
- **Search results** add `match: 'text' | 'title'` (`title` is the trigram fallback, used only when the tsquery matches nothing). Snippets wrap hits in `<mark>`. `limit` is clamped to 1–100 (default 20). `GET /api/tags/:tag` returns document summaries (same shape as `/api/library` documents).
- **Markdown export** is produced server-side with the same Tiptap Markdown parser the editor uses (`@tiptap/markdown` headless), so imports and exports match the browser. `[[Wikilinks]]` are kept unescaped. `export.md` in S3 is rewritten on every save; the HTTP route renders from memory when the document is loaded.
- **MCP**: `claim_job`, `get_blocks`, `set_block_status`, `propose_changes`, `report_job_status` accept an optional `documentId`; jobs are found among loaded documents, and the id (present in every notification's `meta`) lets the agent claim a job after a server restart before anyone reopens that document. `get_document_snapshot` takes `jobId` or `documentId`. `list_documents({ folder })` includes subfolders. `identify_session` returns `user`. Per-document `Store`s live in an LRU of 50; documents with active jobs are never evicted.
- **Revisions**: `docs/<id>/rev/<n>.json` is written when a proposal is accepted (`author` = the reviewer) and when `revision % 50 == 0`; `GET /api/documents/:id` does not list them yet (the `revisions` table does).
- **Tokens**: `last_used_at` is updated at most once a minute per token. `DELETE /api/tokens/:id` is a soft revoke (`revoked_at`).
- **Legacy import** keeps the old document's id (it is already a UUID), so existing job and proposal `documentId`s stay valid.

## Web app

- Routes (history API): `/` → last opened or first document, `/d/:id`, `/d/:id?rev=`, `/tags/:tag`, `/search?q=`, `/settings/tokens`.
- Sign-in: `oidc-client-ts` with PKCE against `authority`/`clientId` from `/api/config`; silent renew; the gate replaces the old key screen. A user menu (avatar initials) at the top right: name, "Agent access tokens", sign out.
- Left column becomes the **Library**: search box (live results with snippets), folder tree (collapsible, documents under folders, counts), tag cloud, New document / New folder. The current document's outline sits below the library, collapsible. The read-aloud player stays at the bottom.
- Document header: title (editable), breadcrumb folder (click to move), tag chips (type to add, backspace to remove), "Properties" disclosure with a YAML editor for the full front matter.
- Related documents (shared tags) and backlinks appear at the end of the document.
- Everything that is document-scoped today (sync, jobs, proposals, read-aloud, tk, comments) is unchanged but keyed by the current document id. Switching documents flushes, stops reading, and loads the new state.
