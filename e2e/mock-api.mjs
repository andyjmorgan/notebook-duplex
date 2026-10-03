// An in-memory implementation of the library contract (docs/library.md) for browser tests.
// Installed with page.route('**/api/**'); per-document editing reuses the real Store so sync, review and the
// local fixture behave exactly as the server does. Swap this for the real server once it lands (AUTH_DEV_USER).
import { randomUUID } from 'node:crypto'
import { Store, textOf } from '../server/store.mjs'

const now = () => new Date().toISOString()
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'
const normaliseFolder = p => '/' + String(p ?? '/').split('/').map(s => s.trim()).filter(Boolean).join('/')
const tagSlug = t => String(t).trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9/_-]+/g, '-').replace(/^-+|-+$/g, '')

/** Minimal front matter reader: `key: value`, `key: [a, b]`, and `- item` lists. Enough for tests. */
export function parseFrontMatter(markdown) {
  const m = markdown.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { data: {}, body: markdown }
  const data = {}; let key
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) {
      key = kv[1]; const v = kv[2].trim()
      if (!v) data[key] = []
      else if (v.startsWith('[')) data[key] = v.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      else data[key] = v.replace(/^['"]|['"]$/g, '')
    } else { const item = line.match(/^\s*-\s+(.*)$/); if (item && key) { if (!Array.isArray(data[key])) data[key] = []; data[key].push(item[1].trim().replace(/^['"]|['"]$/g, '')) } }
  }
  return { data, body: markdown.slice(m[0].length) }
}
const toYaml = fm => Object.entries(fm).map(([k, v]) => Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`).join('\n')

export function createMockApi({ devUser = 'dev@example.com', build = 'mock-build' } = {}) {
  const user = { sub: 'dev:' + devUser, email: devUser, name: devUser.split('@')[0] }
  const db = { documents: new Map(), folders: new Set(['/']), tokens: [], stores: new Map(), log: [] }

  const bodyOf = doc => { const s = db.stores.get(doc.id); const json = s?.state.document.json; return json ? (json.content ?? []).map(n => textOf(n)).join('\n') : (doc.markdown ?? '') }
  const summary = doc => ({ id: doc.id, title: doc.title, folder: doc.folder, slug: doc.slug, tags: doc.tags, wordCount: doc.wordCount, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy })
  const live = () => [...db.documents.values()].filter(d => !d.deletedAt)
  const refreshDerived = doc => { const text = bodyOf(doc); doc.bodyText = text; doc.wordCount = text.trim().split(/\s+/).filter(Boolean).length; doc.updatedAt = now() }
  const linksOut = doc => { const out = []; for (const m of (doc.bodyText ?? '').matchAll(/\[\[([^\[\]|\n]+?)(?:\|[^\]]*)?\]\]/g)) { const t = live().find(d => d.title.trim().toLowerCase() === m[1].trim().toLowerCase()); if (t && t.id !== doc.id && !out.some(o => o.id === t.id)) out.push({ id: t.id, title: t.title, folder: t.folder }) } return out }
  const applyFrontmatter = (doc, fm) => {
    const { title, tags, folder, ...rest } = fm ?? {}
    if (typeof title === 'string' && title.trim()) doc.title = title.trim()
    if (tags !== undefined) doc.tags = (Array.isArray(tags) ? tags : String(tags).split(',')).map(tagSlug).filter(Boolean)
    if (typeof folder === 'string') doc.folder = normaliseFolder(folder)
    doc.frontmatter = { ...rest, title: doc.title, tags: doc.tags, folder: doc.folder }
    doc.slug = slugify(doc.title)
  }

  function create({ title, folder, markdown, tags } = {}) {
    const id = randomUUID()
    const doc = { id, title: (title ?? '').trim() || 'Untitled', folder: normaliseFolder(folder), tags: (tags ?? []).map(tagSlug), frontmatter: {}, revision: 0, wordCount: 0, owner: user.sub, updatedBy: user.sub, createdAt: now(), updatedAt: now(), deletedAt: null, markdown: undefined }
    if (typeof markdown === 'string') { const { data, body } = parseFrontMatter(markdown); applyFrontmatter(doc, { ...data }); doc.markdown = body }
    else applyFrontmatter(doc, {})
    db.folders.add(doc.folder)
    db.documents.set(id, doc)
    db.stores.set(id, new Store({ document: { id, revision: 0, json: null, markdown: doc.markdown ?? null, title: doc.title }, jobs: [], proposals: [], activity: {} }, { isLiveSession: s => s === 'local-test' }))
    refreshDerived(doc)
    return doc
  }
  const detail = doc => {
    const related = live().filter(d => d.id !== doc.id && d.tags.some(t => doc.tags.includes(t))).map(d => ({ id: d.id, title: d.title, folder: d.folder, sharedTags: d.tags.filter(t => doc.tags.includes(t)) }))
    const out = linksOut(doc)
    const inbound = live().filter(d => d.id !== doc.id && linksOut(d).some(l => l.id === doc.id)).map(d => ({ id: d.id, title: d.title, folder: d.folder }))
    return { ...summary(doc), frontmatter: doc.frontmatter, revision: db.stores.get(doc.id).state.document.revision, owner: doc.owner, related, links: { out, in: inbound } }
  }
  const search = (q, { folder, tag, limit = 20 } = {}) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const results = []
    for (const d of live()) {
      if (folder && d.folder !== folder) continue
      if (tag && !d.tags.includes(tag)) continue
      const hay = `${d.title}\n${d.tags.join(' ')}\n${d.bodyText}`.toLowerCase()
      const hits = words.filter(w => hay.includes(w))
      if (!hits.length) continue
      const at = d.bodyText.toLowerCase().indexOf(hits[0])
      const slice = at >= 0 ? d.bodyText.slice(Math.max(0, at - 40), at + 80) : d.bodyText.slice(0, 120)
      const snippet = slice.replace(new RegExp(`(${hits.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi'), '<b>$1</b>')
      results.push({ id: d.id, title: d.title, folder: d.folder, tags: d.tags, snippet, rank: hits.length + (d.title.toLowerCase().includes(words[0] ?? '') ? 1 : 0), updatedAt: d.updatedAt })
    }
    return results.sort((a, b) => b.rank - a.rank).slice(0, limit)
  }
  const tagCounts = () => { const c = new Map(); for (const d of live()) for (const t of d.tags) c.set(t, (c.get(t) ?? 0) + 1); return [...c].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)) }
  const library = () => ({ folders: [...db.folders].sort(), documents: live().sort((a, b) => a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title)).map(summary) })

  function handle(method, url, body) {
    const u = new URL(url, 'http://mock')
    const path = u.pathname
    db.log.push(`${method} ${path}${u.search}`)
    const ok = data => ({ status: 200, json: data })
    const bad = (status, error) => ({ status, json: { error } })
    try {
      if (path === '/api/config') return ok({ devUser, build })
      if (path === '/api/me') return ok({ ...user, mcpUrl: u.origin.replace('http://mock', 'http://localhost') + '/mcp' })
      if (path === '/api/tokens' && method === 'GET') return ok(db.tokens.filter(t => !t.revokedAt).map(({ token, ...t }) => t))
      if (path === '/api/tokens' && method === 'POST') { const token = 'ndp_' + randomUUID().replace(/-/g, ''); const t = { id: randomUUID(), name: body.name, prefix: token.slice(0, 10), createdAt: now(), lastUsedAt: null, token }; db.tokens.push(t); return ok({ id: t.id, name: t.name, token }) }
      let m
      if ((m = path.match(/^\/api\/tokens\/([^/]+)$/)) && method === 'DELETE') { const t = db.tokens.find(x => x.id === m[1]); if (!t) return bad(404, 'Not found'); t.revokedAt = now(); return ok({ ok: true }) }
      if (path === '/api/library') return ok(library())
      if (path === '/api/tags' && method === 'GET') return ok(tagCounts())
      if ((m = path.match(/^\/api\/tags\/([^/]+)$/))) { const tag = decodeURIComponent(m[1]); return ok(live().filter(d => d.tags.includes(tag)).map(summary)) }
      if (path === '/api/search') return ok({ results: search(u.searchParams.get('q') ?? '', { folder: u.searchParams.get('folder') || undefined, tag: u.searchParams.get('tag') || undefined, limit: Number(u.searchParams.get('limit') ?? 20) }) })
      if (path === '/api/folders' && method === 'POST') { const p = normaliseFolder(body.path); db.folders.add(p); let parent = p; while (parent !== '/') { parent = normaliseFolder(parent.split('/').slice(0, -1).join('/')); db.folders.add(parent) } return ok({ path: p }) }
      if (path === '/api/folders' && method === 'DELETE') { const p = normaliseFolder(u.searchParams.get('path')); if (live().some(d => d.folder === p || d.folder.startsWith(p + '/'))) return bad(409, 'Folder is not empty'); db.folders.delete(p); return ok({ ok: true }) }
      if (path === '/api/documents' && method === 'POST') return ok(summary(create(body ?? {})))
      if ((m = path.match(/^\/api\/documents\/([^/]+)(\/.*)?$/))) {
        const doc = db.documents.get(decodeURIComponent(m[1]))
        if (!doc) return bad(404, 'Document not found')
        const sub = m[2] ?? ''
        if (sub === '/restore' && method === 'POST') { doc.deletedAt = null; return ok(summary(doc)) }
        if (doc.deletedAt) return bad(404, 'Document not found')
        if (sub === '/export.md') { const s = db.stores.get(doc.id); const fm = { title: doc.title, tags: doc.tags, folder: doc.folder, ...Object.fromEntries(Object.entries(doc.frontmatter).filter(([k]) => !['title', 'tags', 'folder'].includes(k))) }; return { status: 200, text: `---\n${toYaml(fm)}\n---\n\n${s?.state.document.markdown || doc.bodyText}\n`, contentType: 'text/markdown' } }
        if (sub === '' && method === 'GET') return ok(detail(doc))
        if (sub === '' && method === 'PATCH') {
          if (body.frontmatter) applyFrontmatter(doc, body.frontmatter)
          if (typeof body.title === 'string') applyFrontmatter(doc, { ...doc.frontmatter, title: body.title })
          if (Array.isArray(body.tags)) applyFrontmatter(doc, { ...doc.frontmatter, tags: body.tags })
          if (typeof body.folder === 'string') { applyFrontmatter(doc, { ...doc.frontmatter, folder: body.folder }); db.folders.add(doc.folder) }
          const s = db.stores.get(doc.id); if (s) s.state.document.title = doc.title
          doc.updatedAt = now(); return ok(summary(doc))
        }
        if (sub === '' && method === 'DELETE') { doc.deletedAt = now(); return ok({ ok: true }) }
        return bad(404, 'Not found')
      }
      if ((m = path.match(/^\/api\/d\/([^/]+)\/(state|sync|jobs|cancel|review|demo)$/))) {
        const doc = db.documents.get(decodeURIComponent(m[1])); const store = doc && db.stores.get(doc.id)
        if (!doc || doc.deletedAt || !store) return bad(404, 'Document not found')
        const action = m[2]
        if (action === 'state') { const result = { ...store.view(), sessions: [] }; if (u.searchParams.has('lite')) result.document = { ...result.document, json: undefined, markdown: undefined }; return ok(result) }
        if (action === 'sync') { const saved = store.sync(body); if (typeof body.title === 'string' && body.title.trim()) applyFrontmatter(doc, { ...doc.frontmatter, title: body.title }); if (body.frontmatter) applyFrontmatter(doc, body.frontmatter); refreshDerived(doc); return ok(saved) }
        if (action === 'jobs') return bad(400, 'Choose a connected Claude session first.')
        if (action === 'cancel') { store.cancel(body.id); return ok({ ok: true }) }
        if (action === 'review') { const result = store.review(body.id, body.decision, body); if (result.job) { const { snapshot, ...view } = result.job; return ok({ ...result, job: view }) } refreshDerived(doc); return ok(result) }
        if (action === 'demo') {
          const block = store.snapshot().blocks.find(b => b.id === body.blockId && b.plain && b.text)
          if (!block) return bad(400, 'Place the caret in a plain-text paragraph for the local test.')
          const job = store.enqueue({ instruction: 'Local approval test — no agent involved', blockIds: [block.id], sessionId: 'local-test', sessionName: 'Local test' })
          store.claim(job.id, 'local-test')
          store.activity(job.id, 'local-test', { state: 'writing', progress: 60, message: 'Drafting a fixture' })
          const result = store.propose({ jobId: job.id, type: 'replace', blockId: block.id, blockRevision: block.revision, before: block.text, after: block.text.replace(/\s+$/, '') + ' This sentence is a local test suggestion.', explanation: 'A fixture.' }, 'local-test')
          store.propose({ jobId: job.id, type: 'insert', anchorBlockId: block.id, placement: 'after', markdown: '> A local insert fixture. Edit this text, then accept or reject it.\n\n- It can carry lists\n- and other Markdown', explanation: 'Shows how inserted content is reviewed.' }, 'local-test')
          store.status(job.id, 'local-test', 'completed', 'Local fixture generated')
          return ok(result)
        }
      }
      if (path === '/api/tts') return { status: 200, body: Buffer.alloc(44), contentType: 'audio/wav' }
      if (path === '/api/describe') return ok({ text: 'A chart or diagram.' })
      return bad(404, 'Not found')
    } catch (e) { return bad(400, e.message) }
  }

  async function install(page) {
    await page.route('**/api/**', async route => {
      const req = route.request()
      const method = req.method()
      let body
      try { body = req.postDataJSON() } catch { body = undefined }
      const result = handle(method, req.url(), body)
      const headers = { 'X-Build': build, 'Cache-Control': 'no-store' }
      if (result.json !== undefined) return route.fulfill({ status: result.status, json: result.json, headers })
      if (result.text !== undefined) return route.fulfill({ status: result.status, body: result.text, contentType: result.contentType ?? 'text/plain', headers })
      return route.fulfill({ status: result.status, body: result.body, contentType: result.contentType, headers })
    })
  }
  return { db, user, create, handle, install, library, detail, search, tagCounts, doc: id => db.documents.get(id), store: id => db.stores.get(id) }
}
