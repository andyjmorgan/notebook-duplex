import pg from 'pg'
import { randomUUID } from 'node:crypto'

// Catalogue: metadata, folders, tags, links, tokens and the full-text index. Document bodies live in S3 (storage.mjs).
const migrations = [
  `create extension if not exists vector;
   create extension if not exists pg_trgm;
   create extension if not exists unaccent;
   create or replace function tags_tsvector(text[]) returns tsvector language sql immutable as $$ select to_tsvector('simple', array_to_string($1, ' ')) $$;
   create table if not exists users (
     sub text primary key, email text, name text,
     created_at timestamptz not null default now(), last_seen_at timestamptz not null default now());
   create table if not exists documents (
     id uuid primary key, title text not null, folder text not null default '/', slug text not null,
     tags text[] not null default '{}', frontmatter jsonb not null default '{}', body_text text not null default '',
     word_count int not null default 0, revision int not null default 0, state_key text not null,
     owner text references users(sub), updated_by text references users(sub),
     created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
     search tsvector generated always as (
       setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
       setweight(tags_tsvector(tags), 'B') ||
       setweight(to_tsvector('english', coalesce(body_text,'')), 'C')) stored,
     embedding vector(1024),
     unique (folder, slug));
   create index if not exists documents_search on documents using gin (search);
   create index if not exists documents_tags on documents using gin (tags);
   create index if not exists documents_title_trgm on documents using gin (title gin_trgm_ops);
   create index if not exists documents_folder on documents (folder) where deleted_at is null;
   create table if not exists folders (path text primary key, created_by text references users(sub), created_at timestamptz not null default now());
   create table if not exists links (
     from_id uuid references documents(id) on delete cascade, to_id uuid references documents(id) on delete cascade,
     kind text not null, primary key (from_id, to_id, kind));
   create table if not exists access_tokens (
     id uuid primary key, user_sub text not null references users(sub), name text not null, token_hash text not null unique,
     prefix text not null, created_at timestamptz not null default now(), last_used_at timestamptz, revoked_at timestamptz);
   create table if not exists revisions (
     document_id uuid references documents(id) on delete cascade, revision int not null, state_key text not null,
     author text, created_at timestamptz not null default now(), primary key (document_id, revision));`,
]

export const normaliseFolder = path => { const parts = String(path ?? '/').split('/').map(p => p.trim()).filter(Boolean); if (parts.some(p => p === '.' || p === '..')) throw new Error('Invalid folder path'); return '/' + parts.join('/') }
export const slugify = title => String(title ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled'
export const normaliseTag = tag => String(tag ?? '').toLowerCase().trim().replace(/^#/, '').replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
export const normaliseTags = tags => [...new Set((Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : []).map(normaliseTag).filter(Boolean))].slice(0, 50)
export const parentOf = path => path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/'

const row = r => r && ({ id: r.id, title: r.title, folder: r.folder, slug: r.slug, tags: r.tags, frontmatter: r.frontmatter, wordCount: r.word_count, revision: r.revision, stateKey: r.state_key, owner: r.owner, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at ?? undefined })
export const summary = d => d && ({ id: d.id, title: d.title, folder: d.folder, slug: d.slug, tags: d.tags, wordCount: d.wordCount, revision: d.revision, updatedAt: d.updatedAt, updatedBy: d.updatedBy, deletedAt: d.deletedAt })

export class Db {
  constructor(url) { this.pool = new pg.Pool({ connectionString: url, max: 8 }) }
  async query(text, params) { return (await this.pool.query(text, params)).rows }
  async one(text, params) { return (await this.query(text, params))[0] }
  async close() { await this.pool.end() }

  async migrate() {
    const client = await this.pool.connect()
    try {
      await client.query('select pg_advisory_lock(7342001)')
      await client.query('create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())')
      const applied = new Set((await client.query('select version from schema_migrations')).rows.map(r => r.version))
      for (const [i, sql] of migrations.entries()) {
        if (applied.has(i + 1)) continue
        await client.query('begin'); await client.query(sql); await client.query('insert into schema_migrations (version) values ($1)', [i + 1]); await client.query('commit')
      }
      return migrations.length
    } catch (e) { await client.query('rollback').catch(() => {}); throw e }
    finally { await client.query('select pg_advisory_unlock(7342001)').catch(() => {}); client.release() }
  }

  // Users
  async upsertUser({ sub, email, name }) {
    return this.one(`insert into users (sub, email, name) values ($1, $2, $3)
      on conflict (sub) do update set email = coalesce(excluded.email, users.email), name = coalesce(excluded.name, users.name), last_seen_at = now() returning *`, [sub, email ?? null, name ?? null])
  }
  async user(sub) { return this.one('select * from users where sub = $1', [sub]) }

  // Documents
  async uniqueSlug(folder, title, excludeId) {
    const base = slugify(title)
    const taken = new Set((await this.query('select slug from documents where folder = $1 and (slug = $2 or slug like $3) and id is distinct from $4', [folder, base, base + '-%', excludeId ?? null])).map(r => r.slug))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }
  async createDocument({ id = randomUUID(), title, folder = '/', tags = [], frontmatter = {}, bodyText = '', wordCount = 0, owner = null }) {
    folder = normaliseFolder(folder)
    const slug = await this.uniqueSlug(folder, title)
    return row(await this.one(`insert into documents (id, title, folder, slug, tags, frontmatter, body_text, word_count, state_key, owner, updated_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) returning *`, [id, title, folder, slug, normaliseTags(tags), frontmatter, bodyText, wordCount, `docs/${id}/state.json`, owner]))
  }
  async document(id, { deleted = false } = {}) { return row(await this.one(`select * from documents where id = $1 ${deleted ? '' : 'and deleted_at is null'}`, [id])) }
  async documents({ folder, deleted = false } = {}) {
    return (await this.query(`select * from documents where ${deleted ? 'deleted_at is not null' : 'deleted_at is null'} ${folder ? 'and folder = $1' : ''} order by folder, lower(title)`, folder ? [normaliseFolder(folder)] : [])).map(row)
  }
  async countDocuments() { return Number((await this.one('select count(*)::int as n from documents')).n) }
  async updateDocument(id, { title, folder, tags, frontmatter, bodyText, wordCount, revision, updatedBy }) {
    const current = await this.document(id, { deleted: true })
    if (!current) throw new Error('Document not found')
    const nextFolder = folder !== undefined ? normaliseFolder(folder) : current.folder
    const nextTitle = title !== undefined ? String(title).trim().slice(0, 300) || 'Untitled' : current.title
    const slug = nextFolder !== current.folder || nextTitle !== current.title ? await this.uniqueSlug(nextFolder, nextTitle, id) : current.slug
    return row(await this.one(`update documents set title = $2, folder = $3, slug = $4, tags = $5, frontmatter = $6, body_text = coalesce($7, body_text), word_count = coalesce($8, word_count),
      revision = coalesce($9, revision), updated_by = coalesce($10, updated_by), updated_at = now() where id = $1 returning *`,
      [id, nextTitle, nextFolder, slug, tags !== undefined ? normaliseTags(tags) : current.tags, frontmatter ?? current.frontmatter, bodyText ?? null, wordCount ?? null, revision ?? null, updatedBy ?? null]))
  }
  async softDelete(id) { return row(await this.one('update documents set deleted_at = now() where id = $1 and deleted_at is null returning *', [id])) }
  async restore(id) {
    const doc = await this.document(id, { deleted: true })
    if (!doc) throw new Error('Document not found')
    const slug = await this.uniqueSlug(doc.folder, doc.title, id)
    return row(await this.one('update documents set deleted_at = null, slug = $2 where id = $1 returning *', [id, slug]))
  }
  async findByTitle(title) { return row(await this.one('select * from documents where deleted_at is null and lower(title) = lower($1) order by updated_at desc limit 1', [title])) }
  async findByTitles(titles) {
    if (!titles.length) return []
    return (await this.query('select id, title, folder from documents where deleted_at is null and lower(title) = any($1)', [titles.map(t => t.toLowerCase())]))
  }

  // Folders: the ones documents imply, plus explicit empty markers, plus every ancestor.
  async folders() {
    const rows = await this.query('select folder as path from documents where deleted_at is null union select path from folders')
    const all = new Set(['/'])
    for (const { path } of rows) { let p = path; while (p && !all.has(p)) { all.add(p); p = parentOf(p) } }
    return [...all].sort()
  }
  async createFolder(path, by) { path = normaliseFolder(path); if (path === '/') return path; await this.query('insert into folders (path, created_by) values ($1, $2) on conflict do nothing', [path, by ?? null]); return path }
  async deleteFolder(path) {
    path = normaliseFolder(path)
    if (path === '/') throw new Error('The root folder cannot be deleted')
    const used = await this.one('select count(*)::int as n from documents where deleted_at is null and (folder = $1 or folder like $2)', [path, path + '/%'])
    const sub = await this.one('select count(*)::int as n from folders where path like $1', [path + '/%'])
    if (used.n || sub.n) throw new Error('Folder is not empty')
    await this.query('delete from folders where path = $1', [path])
  }

  // Tags and relations
  async tags() { return this.query('select tag, count(*)::int as count from documents, unnest(tags) as tag where deleted_at is null group by tag order by count desc, tag') }
  async byTag(tag) { return (await this.query('select * from documents where deleted_at is null and $1 = any(tags) order by folder, lower(title)', [normaliseTag(tag)])).map(row) }
  async related(id, limit = 10) {
    return this.query(`select d.id, d.title, d.folder, (select count(*)::int from unnest(d.tags) t where t = any(s.tags)) as "sharedTags"
      from documents d, documents s where s.id = $1 and d.id <> s.id and d.deleted_at is null and d.tags && s.tags order by "sharedTags" desc, d.updated_at desc limit $2`, [id, limit])
  }
  async setLinks(fromId, links) {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('delete from links where from_id = $1', [fromId])
      for (const { toId, kind } of links) await client.query('insert into links (from_id, to_id, kind) values ($1, $2, $3) on conflict do nothing', [fromId, toId, kind])
      await client.query('commit')
    } catch (e) { await client.query('rollback'); throw e } finally { client.release() }
  }
  async links(id) {
    const out = await this.query('select d.id, d.title, d.folder, l.kind from links l join documents d on d.id = l.to_id where l.from_id = $1 and d.deleted_at is null order by lower(d.title)', [id])
    const inbound = await this.query('select d.id, d.title, d.folder, l.kind from links l join documents d on d.id = l.from_id where l.to_id = $1 and d.deleted_at is null order by lower(d.title)', [id])
    return { out, in: inbound }
  }

  // Search: web-style query over title, tags and body, with a trigram pass on titles when the query matches nothing.
  async search(q, { folder, tag, limit = 20 } = {}) {
    const text = String(q ?? '').trim()
    if (!text) return []
    const where = ['d.deleted_at is null']; const params = [text]
    if (folder) { params.push(normaliseFolder(folder)); where.push(`d.folder = $${params.length}`) }
    if (tag) { params.push(normaliseTag(tag)); where.push(`$${params.length} = any(d.tags)`) }
    params.push(Math.max(1, Math.min(100, Number(limit) || 20)))
    const n = params.length
    const full = await this.query(`with q as (select websearch_to_tsquery('english', $1) as tsq)
      select d.id, d.title, d.folder, d.tags, d.updated_at as "updatedAt", ts_rank_cd(d.search, q.tsq) as rank,
        ts_headline('english', d.body_text, q.tsq, 'MaxWords=30, MinWords=12, StartSel=<mark>, StopSel=</mark>, MaxFragments=2, FragmentDelimiter=" … "') as snippet
      from documents d, q where ${where.join(' and ')} and d.search @@ q.tsq order by rank desc, d.updated_at desc limit $${n}`, params)
    if (full.length) return full.map(r => ({ ...r, rank: Number(r.rank), match: 'text' }))
    const fuzzy = await this.query(`select d.id, d.title, d.folder, d.tags, d.updated_at as "updatedAt", similarity(d.title, $1) as rank, left(d.body_text, 160) as snippet
      from documents d where ${where.join(' and ')} and similarity(d.title, $1) > 0.2 order by rank desc, d.updated_at desc limit $${n}`, params)
    return fuzzy.map(r => ({ ...r, rank: Number(r.rank), match: 'title' }))
  }

  // Access tokens
  async createToken({ sub, name, hash, prefix }) {
    return this.one('insert into access_tokens (id, user_sub, name, token_hash, prefix) values ($1, $2, $3, $4, $5) returning id, name, prefix, created_at as "createdAt"', [randomUUID(), sub, String(name ?? '').trim().slice(0, 100) || 'Agent token', hash, prefix])
  }
  async tokens(sub) { return this.query('select id, name, prefix, created_at as "createdAt", last_used_at as "lastUsedAt" from access_tokens where user_sub = $1 and revoked_at is null order by created_at desc', [sub]) }
  async tokenByHash(hash) { return this.one('select t.id, t.user_sub as sub, t.last_used_at as "lastUsedAt", u.email, u.name from access_tokens t join users u on u.sub = t.user_sub where t.token_hash = $1 and t.revoked_at is null', [hash]) }
  async touchToken(id) { await this.query('update access_tokens set last_used_at = now() where id = $1', [id]) }
  async revokeToken(id, sub) { return (await this.query('update access_tokens set revoked_at = now() where id = $1 and user_sub = $2 and revoked_at is null returning id', [id, sub])).length > 0 }

  // Revisions (bodies in S3)
  async addRevision(documentId, revision, stateKey, author) { await this.query('insert into revisions (document_id, revision, state_key, author) values ($1, $2, $3, $4) on conflict do nothing', [documentId, revision, stateKey, author ?? null]) }
  async revisions(documentId) { return this.query('select revision, state_key as "stateKey", author, created_at as "createdAt" from revisions where document_id = $1 order by revision desc', [documentId]) }
}
