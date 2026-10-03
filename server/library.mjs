import { randomUUID } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { Store, initialState, assignIds } from './store.mjs'
import { normaliseFolder, normaliseTags, summary } from './db.mjs'
import { markdownToJson, jsonToMarkdown, parseFrontMatter, withFrontMatter, plainText, wordCount, wikilinks, titleFrom } from './markdown.mjs'

const ACTIVE = ['queued', 'running', 'needs_permission']
const stateKey = id => `docs/${id}/state.json`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Front matter columns: title, tags and folder are catalogue columns; everything else is kept verbatim in `frontmatter`.
export function splitFrontMatter(fm = {}) {
  const { title, tags, folder, ...extras } = fm
  return { title: typeof title === 'string' && title.trim() ? title.trim() : undefined, tags: tags === undefined ? undefined : normaliseTags(tags), folder: typeof folder === 'string' ? normaliseFolder(folder) : undefined, extras }
}
export function composeFrontMatter(doc) {
  const { aliases, created, updated, ...rest } = doc.frontmatter ?? {}
  return { title: doc.title, tags: doc.tags?.length ? doc.tags : undefined, folder: doc.folder !== '/' ? doc.folder : undefined, aliases, ...rest, created: created ?? new Date(doc.createdAt).toISOString(), updated: new Date(doc.updatedAt).toISOString() }
}

export class Library {
  constructor({ db, storage, isLiveSession = () => true, cacheSize = 50 }) { this.db = db; this.storage = storage; this.isLiveSession = isLiveSession; this.cacheSize = cacheSize; this.cache = new Map() }

  // Per-document Store instances, loaded from S3 on first use and kept in a small LRU.
  // Every entry point checks that the document belongs to the caller; a document that is not yours does not exist.
  async assertOwner(id, user, opts = {}) {
    if (!UUID.test(String(id)) || !user?.sub) throw new Error('Document not found')
    const doc = await this.db.document(id, { ...opts, owner: user.sub })
    if (!doc) throw new Error('Document not found')
    return doc
  }
  async openFor(id, user) { await this.assertOwner(id, user); return this.open(id) }
  async open(id) {
    if (!UUID.test(String(id))) throw new Error('Document not found')
    let entry = this.cache.get(id)
    if (!entry) {
      const doc = await this.db.document(id)
      if (!doc) throw new Error('Document not found')
      const saved = await this.storage.getJson(stateKey(id))
      const store = new Store(saved ?? { ...initialState(), document: { ...initialState().document, id, title: doc.title } }, { isLiveSession: this.isLiveSession })
      store.state.document.id = id
      entry = { store, owner: doc.owner, saving: Promise.resolve(), waiters: [], timer: undefined, archived: store.state.document.revision }
      this.cache.set(id, entry)
      void this.evict()
    } else { this.cache.delete(id); this.cache.set(id, entry) }
    return entry.store
  }
  async evict() {
    for (const [id, entry] of this.cache) {
      if (this.cache.size <= this.cacheSize) return
      if (entry.store.state.jobs.some(j => ACTIVE.includes(j.status))) continue
      this.cache.delete(id); await this.flushEntry(id, entry)
    }
  }
  stores(owner) { return [...this.cache].filter(([, e]) => owner === undefined || e.owner === owner).map(([id, e]) => ({ id, store: e.store })) }
  // Jobs live with their document; find the store that holds one, loading the document when the caller names it.
  async storeForJob(jobId, documentId, user) {
    for (const { store } of this.stores(user?.sub)) if (store.state.jobs.some(j => j.id === jobId)) return store
    if (documentId) { const store = await this.openFor(documentId, user); if (store.state.jobs.some(j => j.id === jobId)) return store }
    throw new Error('Job not found; pass documentId from the notification if the server restarted')
  }

  // Debounced write of the state blob and the Markdown export; every caller resolves once the next write lands.
  save(id, author) {
    const entry = this.cache.get(id)
    if (!entry) return Promise.resolve()
    return new Promise(done => {
      entry.waiters.push(done)
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        const batch = entry.waiters; entry.waiters = []
        entry.saving = entry.saving.then(() => this.write(id, entry, author)).catch(e => console.error(`save ${id.slice(0, 8)} failed: ` + e.message)).finally(() => batch.forEach(d => d()))
      }, 50)
    })
  }
  async write(id, entry, author) {
    const state = entry.store.state
    await this.storage.putJson(stateKey(id), state)
    const doc = await this.db.document(id, { deleted: true })
    if (doc) await this.storage.putText(`docs/${id}/export.md`, this.markdownFor(doc, state), 'text/markdown; charset=utf-8')
    if (state.document.revision > 0 && state.document.revision % 50 === 0 && entry.archived !== state.document.revision) await this.archive(id, author)
  }
  async archive(id, author) {
    const entry = this.cache.get(id)
    if (!entry) return
    const revision = entry.store.state.document.revision
    if (entry.archived === revision) return
    entry.archived = revision
    const key = `docs/${id}/rev/${revision}.json`
    await this.storage.putJson(key, entry.store.state)
    await this.db.addRevision(id, revision, key, author ?? null)
  }
  // Write now rather than after the debounce; used on shutdown and before a document leaves the cache.
  flushEntry(id, entry) {
    if (entry.waiters.length) { clearTimeout(entry.timer); const batch = entry.waiters; entry.waiters = []; entry.saving = entry.saving.then(() => this.write(id, entry)).catch(e => console.error(`save ${id.slice(0, 8)} failed: ` + e.message)).finally(() => batch.forEach(d => d())) }
    return entry.saving
  }
  async flush() { for (const [id, entry] of this.cache) await this.flushEntry(id, entry) }

  markdownFor(doc, state) {
    const body = state.document.json ? jsonToMarkdown(state.document.json) : String(state.document.markdown ?? '')
    return withFrontMatter(composeFrontMatter(doc), body)
  }

  // Update the catalogue row from the live document: title, front matter, body text, links.
  async index(id, store, user, { frontmatter, title } = {}) {
    const known = frontmatter && typeof frontmatter === 'object' ? splitFrontMatter(frontmatter) : {}
    const json = store.state.document.json
    const body = json ? plainText(json) : ''
    const doc = await this.db.updateDocument(id, {
      title: title ?? known.title ?? store.state.document.title, folder: known.folder, tags: frontmatter ? known.tags ?? [] : undefined, frontmatter: frontmatter ? known.extras : undefined,
      bodyText: body, wordCount: wordCount(body), revision: store.state.document.revision, updatedBy: user?.sub,
    })
    store.state.document.title = doc.title
    await this.relink(id, body, doc.owner)
    return doc
  }
  async relink(id, body, owner) {
    const titles = wikilinks(body)
    const targets = await this.db.findByTitles(titles, owner)
    await this.db.setLinks(id, targets.filter(t => t.id !== id).map(t => ({ toId: t.id, kind: 'wikilink' })))
  }

  async sync(id, data, user) {
    const store = await this.openFor(id, user)
    const document = store.sync({ ...data, title: data.title ?? undefined })
    const doc = await this.index(id, store, user, { frontmatter: data.frontmatter, title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : undefined })
    void this.save(id, user?.sub)
    return this.decorate(document, doc)
  }
  decorate(document, doc) { return { ...document, title: doc.title, folder: doc.folder, slug: doc.slug, tags: doc.tags, frontmatter: composeFrontMatter(doc), updatedAt: doc.updatedAt, updatedBy: doc.updatedBy } }
  async view(id, { lite = false } = {}, user) {
    const doc = await this.assertOwner(id, user)
    const store = await this.open(id)
    const view = store.view()
    view.document = this.decorate(view.document, doc)
    if (lite) view.document = { ...view.document, json: undefined, markdown: undefined }
    return view
  }

  async create({ title, folder, markdown, tags, frontmatter } = {}, user, { allowUnowned = false } = {}) {
    if (!user?.sub && !allowUnowned) throw new Error('Sign in to create documents')
    const parsed = parseFrontMatter(markdown ?? '')
    const known = splitFrontMatter({ ...(frontmatter ?? {}), ...parsed.frontmatter })
    const body = parsed.body.trim()
    const json = body ? assignIds(markdownToJson(body), new Set()) : null
    const given = typeof title === 'string' ? title.trim() : ''
    const finalTitle = (known.title || given || (json ? titleFrom(json, '') : '') || 'Untitled').slice(0, 300)
    const text = json ? plainText(json) : ''
    const id = randomUUID()
    const doc = await this.db.createDocument({ id, title: finalTitle, folder: known.folder ?? folder ?? '/', tags: known.tags ?? tags ?? [], frontmatter: known.extras, bodyText: text, wordCount: wordCount(text), owner: user?.sub ?? null })
    const state = { ...initialState(), document: { id, revision: 0, json, markdown: body, title: doc.title } }
    await this.storage.putJson(stateKey(id), state)
    await this.storage.putText(`docs/${id}/export.md`, this.markdownFor(doc, state), 'text/markdown; charset=utf-8')
    await this.relink(id, text, doc.owner)
    this.cache.set(id, { store: new Store(state, { isLiveSession: this.isLiveSession }), owner: doc.owner, saving: Promise.resolve(), waiters: [], archived: 0 })
    void this.evict()
    return summary(doc)
  }
  async get(id, user) {
    const doc = await this.assertOwner(id, user, { deleted: true })
    const [related, links] = await Promise.all([this.db.related(id), this.db.links(id)])
    return { ...summary(doc), frontmatter: composeFrontMatter(doc), owner: doc.owner, createdAt: doc.createdAt, related, links }
  }
  async patch(id, { title, folder, tags, frontmatter } = {}, user) {
    await this.assertOwner(id, user, { deleted: true })
    const known = frontmatter && typeof frontmatter === 'object' ? splitFrontMatter(frontmatter) : {}
    const doc = await this.db.updateDocument(id, { title: title ?? known.title, folder: folder ?? known.folder, tags: tags ?? (frontmatter ? known.tags ?? [] : undefined), frontmatter: frontmatter ? known.extras : undefined, updatedBy: user?.sub })
    const entry = this.cache.get(id)
    if (entry) { entry.store.state.document.title = doc.title; void this.save(id, user?.sub) }
    else { const state = await this.storage.getJson(stateKey(id)); if (state) { state.document.title = doc.title; await this.storage.putJson(stateKey(id), state); await this.storage.putText(`docs/${id}/export.md`, this.markdownFor(doc, state), 'text/markdown; charset=utf-8') } }
    return summary(doc)
  }
  async remove(id, user) { await this.assertOwner(id, user); const doc = await this.db.softDelete(id); if (!doc) throw new Error('Document not found'); const entry = this.cache.get(id); if (entry) { this.cache.delete(id); await this.flushEntry(id, entry) } return summary(doc) }
  async restore(id, user) { await this.assertOwner(id, user, { deleted: true }); return summary(await this.db.restore(id)) }
  async exportMarkdown(id, user) {
    const doc = await this.assertOwner(id, user, { deleted: true })
    const entry = this.cache.get(id)
    if (entry) return this.markdownFor(doc, entry.store.state)
    return (await this.storage.getText(`docs/${id}/export.md`)) ?? this.markdownFor(doc, (await this.storage.getJson(stateKey(id))) ?? initialState())
  }
  async library(user) { const owner = user?.sub ?? null; const [folders, documents] = await Promise.all([this.db.folders(owner), this.db.documents({ owner })]); return { folders, documents: documents.map(summary) } }
  async search(q, options, user) { return this.db.search(q, { ...options, owner: user?.sub ?? null }) }

  // First boot on an existing deployment: the single-document state.json becomes the first library document.
  async importLegacy(dataDir) {
    if (await this.db.countDocuments() > 0) return null
    let saved
    try { saved = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
    const id = UUID.test(saved.document?.id ?? '') ? saved.document.id : randomUUID()
    const title = String(saved.document?.title ?? '').trim() || 'Imported notebook'
    const doc = await this.db.createDocument({ id, title, folder: '/', owner: await this.db.soleUser() })
    const state = { ...initialState(), ...saved, document: { ...saved.document, id, title } }
    await this.storage.putJson(stateKey(id), state)
    const store = new Store(state, { isLiveSession: this.isLiveSession })
    this.cache.set(id, { store, saving: Promise.resolve(), waiters: [], archived: state.document.revision })
    await this.index(id, store, null)
    await this.storage.putText(`docs/${id}/export.md`, this.markdownFor(await this.db.document(id), state), 'text/markdown; charset=utf-8')
    await rename(join(dataDir, 'state.json'), join(dataDir, 'state.imported.json'))
    console.log(`imported legacy state.json as document ${id} ("${doc.title}")`)
    return summary(doc)
  }
}
