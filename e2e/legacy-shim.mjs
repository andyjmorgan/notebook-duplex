// Bridges the new library UI to the old single-document server for the pre-library e2e suites.
// Document-scoped routes (/api/d/:id/*) are forwarded to the old /api/* with the notebook key; the library
// catalogue is answered from a tiny in-memory record. Imports create a new id whose first state read carries
// the Markdown so the editor seeds it and syncs it into the one real document.
// TODO(integration): delete this file once server/index.mjs implements docs/library.md and run the suites with AUTH_DEV_USER.
export const LEGACY_DOC_ID = 'legacy-document'

export async function installLegacyShim(page, { url, apiKey, devUser = 'writer@example.com' }) {
  const docs = new Map([[LEGACY_DOC_ID, { id: LEGACY_DOC_ID, title: 'Working notes', folder: '/', slug: 'working-notes', tags: [], frontmatter: {}, wordCount: 0, updatedAt: new Date().toISOString(), updatedBy: devUser }]])
  const pendingImport = new Map()
  let counter = 0
  const summary = d => ({ id: d.id, title: d.title, folder: d.folder, slug: d.slug, tags: d.tags, wordCount: d.wordCount, updatedAt: d.updatedAt, updatedBy: d.updatedBy })
  // Errors here are teardown races (the server is gone while the page still polls); abort quietly rather than fail the test.
  const forward = async (route, path) => {
    const req = route.request()
    try {
      const response = await route.fetch({ url: url + path, headers: { ...req.headers(), authorization: 'Bearer ' + apiKey } })
      return await route.fulfill({ response })
    } catch { return route.abort().catch(() => {}) }
  }
  await page.route('**/api/**', async route => {
    try { await handle(route) } catch { await route.abort().catch(() => {}) }
  })
  async function handle(route) {
    const req = route.request()
    const u = new URL(req.url())
    const method = req.method()
    const json = (data, status = 200) => route.fulfill({ status, json: data, headers: { 'X-Build': 'legacy' } })
    let m
    if (u.pathname === '/api/config') return json({ devUser, build: 'legacy' })
    if (u.pathname === '/api/library') return json({ folders: ['/'], documents: [...docs.values()].map(summary) })
    if (u.pathname === '/api/tags') return json([])
    if (u.pathname === '/api/search') return json({ results: [] })
    if (u.pathname === '/api/tokens') return json(method === 'POST' ? { id: 't', name: req.postDataJSON()?.name ?? 'token', token: 'ndp_legacy' } : [])
    if (u.pathname === '/api/documents' && method === 'POST') {
      const body = req.postDataJSON() ?? {}
      const id = `imported-${++counter}`
      const title = body.markdown?.match(/^---\n[\s\S]*?\ntitle:\s*(.+)\n[\s\S]*?\n---/)?.[1]?.trim() || body.title || 'Untitled'
      docs.set(id, { id, title, folder: body.folder ?? '/', slug: id, tags: body.tags ?? [], frontmatter: {}, wordCount: 0, updatedAt: new Date().toISOString(), updatedBy: devUser })
      if (typeof body.markdown === 'string') pendingImport.set(id, body.markdown.replace(/^---\n[\s\S]*?\n---\n?/, ''))
      return json(summary(docs.get(id)))
    }
    if ((m = u.pathname.match(/^\/api\/documents\/([^/]+)(\/export\.md|\/restore)?$/))) {
      const doc = docs.get(m[1])
      if (!doc) return json({ error: 'Document not found' }, 404)
      if (m[2] === '/export.md') return json({ error: 'Export is not available on the legacy server' }, 404)
      if (method === 'PATCH') { const body = req.postDataJSON() ?? {}; Object.assign(doc, body.title !== undefined ? { title: body.title } : {}, body.tags ? { tags: body.tags } : {}, body.folder ? { folder: body.folder } : {}); return json(summary(doc)) }
      if (method === 'DELETE') { docs.delete(doc.id); return json({ ok: true }) }
      return json({ ...summary(doc), frontmatter: doc.frontmatter, revision: 0, owner: devUser, related: [], links: { out: [], in: [] } })
    }
    if ((m = u.pathname.match(/^\/api\/d\/([^/]+)\/(state|sync|jobs|cancel|review|demo)$/))) {
      const id = m[1], action = m[2]
      if (action === 'state' && pendingImport.has(id) && !u.searchParams.has('lite')) {
        const markdown = pendingImport.get(id); pendingImport.delete(id)
        const res = await route.fetch({ url: url + '/api/state', headers: { ...req.headers(), authorization: 'Bearer ' + apiKey } })
        const state = await res.json()
        return json({ ...state, document: { ...state.document, json: null, markdown, title: docs.get(id)?.title ?? state.document.title } })
      }
      return forward(route, `/api/${action}${u.search}`)
    }
    // /api/me, /api/tts, /api/describe and anything else the old server already knows
    return forward(route, u.pathname + u.search)
  }
  return { docs }
}
