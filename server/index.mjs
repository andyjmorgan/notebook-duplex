import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Db } from './db.mjs'
import { storageFromEnv } from './storage.mjs'
import { authFromEnv } from './auth.mjs'
import { Library } from './library.mjs'
import { createMcpServer, channelNotification } from './mcp.mjs'
import { describeDiagramFallback, describeCodeFallback, diagramUtterance, codeUtterance, spokenText } from '../shared/narration.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const dataDir = resolve(process.env.DATA_DIR ?? join(root, '.runtime'))
const distDir = resolve(process.env.STATIC_DIR ?? join(root, 'dist'))
const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'
const sessionGrace = Number(process.env.SESSION_GRACE_MS ?? 20000)
const oidc = { authority: process.env.OIDC_AUTHORITY_PUBLIC ?? process.env.OIDC_ISSUER ?? null, clientId: process.env.OIDC_CLIENT_ID ?? null }
// Read-aloud: Kokoro TTS (in-cluster service first, GPU host as fallback) and an LLM for describing diagrams and code.
const kokoro = { urls: [process.env.KOKORO_URL ?? 'http://kokoro-tts.kokoro-tts.svc.cluster.local:8000', process.env.KOKORO_FALLBACK_URL ?? 'http://192.168.69.28:30882'].filter(Boolean).map(u => u.replace(/\/$/, '')), voice: process.env.KOKORO_VOICE || 'af_heart', active: 0 }
const describeLlm = { url: (process.env.DESCRIBE_LLM_URL ?? 'http://192.168.69.28:11434').replace(/\/$/, ''), model: process.env.DESCRIBE_LLM_MODEL || 'gemma4:26b', timeout: Number(process.env.DESCRIBE_LLM_TIMEOUT_MS ?? 20000) }

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2) }
const db = new Db(process.env.DATABASE_URL)
await db.migrate()
const storage = storageFromEnv()
await storage.ensureBucket()
const auth = authFromEnv(db)
await auth.start()
if (auth.dev) console.log(`AUTH_DEV_USER: every request acts as ${auth.dev.email} (development only)`)
const sessions = new Map()
const transports = new Map()
const library = new Library({ db, storage, isLiveSession: id => sessions.has(id) || id === 'local-test' })
await library.importLegacy(dataDir)

function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Build': buildId }); res.end(JSON.stringify(data)) }
function readBody(req) {
  return new Promise((ok, fail) => { let body = ''; req.on('data', c => { body += c; if (body.length > 4_000_000) { req.destroy(); fail(new Error('Body too large')) } }); req.on('end', () => ok(body)); req.on('error', fail) })
}
const sessionView = () => [...sessions.values()].map(s => ({ id: s.id, name: s.name, repo: s.repo, user: s.user?.name, connectedAt: s.connectedAt, lastSeen: s.lastSeen, connected: true, streaming: s.streams > 0 }))

class MemoryEventStore {
  constructor() { this.events = []; this.limit = 500 }
  async storeEvent(streamId, message) { const eventId = `${streamId}|${randomUUID()}`; this.events.push({ eventId, streamId, message }); if (this.events.length > this.limit) this.events.shift(); return eventId }
  async replayEventsAfter(lastEventId, { send }) {
    const index = this.events.findIndex(e => e.eventId === lastEventId)
    if (index === -1) return ''
    const streamId = this.events[index].streamId
    for (const e of this.events.slice(index + 1)) if (e.streamId === streamId) await send(e.eventId, e.message)
    return streamId
  }
}

async function notify(job) {
  const session = sessions.get(job.sessionId)
  if (!session) return false
  try { await session.mcp.notification(channelNotification(job)); job.notifiedAt = Date.now(); job.notifyCount = (job.notifyCount ?? 0) + 1; return true }
  catch (e) { console.error('notify failed: ' + e.message); return false }
}
setInterval(() => {
  for (const session of sessions.values()) if (session.streams === 0 && Date.now() - Math.max(session.streamClosedAt ?? 0, session.connectedAt, session.lastSeen) > sessionGrace) dropSession(session.id)
  for (const { id, store } of library.stores()) {
    // Jobs orphaned by a restart or disconnect go to a live session of the same name (same repo), else wait for list_jobs.
    for (const job of store.orphans()) { const heir = [...sessions.values()].find(s => s.name === job.sessionName); if (heir) { store.reassign(job, heir.id); void library.save(id) } }
    store.expireOrphans(Number(process.env.ORPHAN_MAX_AGE_MS ?? 600000))
    for (const job of store.state.jobs) if (job.status === 'queued' && sessions.has(job.sessionId) && Date.now() - (job.notifiedAt ?? 0) > 20000 && (job.notifyCount ?? 0) < 30) void notify(job)
  }
}, Math.min(5000, sessionGrace)).unref()

async function handleMcp(req, res, user) {
  const sessionId = req.headers['mcp-session-id']
  let transport = sessionId ? transports.get(sessionId) : undefined
  if (req.method === 'POST' && !transport) {
    const body = await readBody(req)
    let parsed
    try { parsed = JSON.parse(body) } catch { return json(res, 400, { error: 'Invalid JSON' }) }
    const isInit = (Array.isArray(parsed) ? parsed : [parsed]).some(m => m?.method === 'initialize')
    if (!isInit) return json(res, sessionId ? 404 : 400, { jsonrpc: '2.0', error: { code: -32000, message: sessionId ? 'Session not found. Reconnect to start a new session.' : 'Missing session. Send initialize first.' }, id: null })
    const session = { id: '', name: 'Claude', repo: '', user, connectedAt: Date.now(), lastSeen: Date.now(), streams: 0 }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore: new MemoryEventStore(),
      onsessioninitialized: id => {
        session.id = id
        sessions.set(id, session); transports.set(id, transport)
        console.log(`session ${id.slice(0, 8)} connected (${session.name}, ${user.name})`)
      },
      onsessionclosed: id => dropSession(id),
    })
    transport.onclose = () => { if (session.id) dropSession(session.id) }
    session.mcp = createMcpServer(session, library, user)
    session.mcp.oninitialized = () => {
      const client = session.mcp.getClientVersion()
      if (client?.name && session.name === 'Claude') session.name = client.name === 'claude-code' ? 'Claude Code' : client.name.slice(0, 80)
    }
    await session.mcp.connect(transport)
    return transport.handleRequest(req, res, parsed)
  }
  if (!transport) return json(res, 404, { jsonrpc: '2.0', error: { code: -32000, message: 'Session not found. Reconnect to start a new session.' }, id: null })
  const session = sessions.get(sessionId)
  if (session) session.lastSeen = Date.now()
  if (req.method === 'GET' && session) { session.streams++; res.once('close', () => { session.streams = Math.max(0, session.streams - 1); session.streamClosedAt = Date.now() }) }
  return transport.handleRequest(req, res)
}
function dropSession(id) {
  const session = sessions.get(id)
  sessions.delete(id); transports.delete(id)
  if (session) { console.log(`session ${id.slice(0, 8)} disconnected`); session.mcp?.close().catch(() => {}) }
}

let sequence = Promise.resolve()
function serial(fn) { const run = sequence.then(fn, fn); sequence = run.catch(() => {}); return run }
class HttpError extends Error { constructor(status, message) { super(message); this.status = status } }
const notFound = () => { throw new HttpError(404, 'Not found') }

// Document editing routes, now per document: /api/d/:id/<action>.
async function handleDocument(req, id, action, data, user, url) {
  if (req.method === 'GET' && action === 'state') return { ...(await library.view(id, { lite: url.searchParams.has('lite') })), sessions: sessionView() }
  if (req.method !== 'POST') notFound()
  const store = await library.open(id)
  let result
  if (action === 'sync') return library.sync(id, data, user)
  else if (action === 'jobs') {
    const session = sessions.get(data.sessionId)
    if (!session) throw new Error('Choose a connected Claude session first.')
    const job = store.enqueue({ ...data, sessionName: session.name, requestedBy: { sub: user.sub, name: user.name } })
    void notify(job)
    const { snapshot, ...view } = job
    result = view
  }
  else if (action === 'cancel') { store.cancel(data.id); result = { ok: true } }
  else if (action === 'review') {
    result = store.review(data.id, data.decision, data)
    if (result.job) { void notify(result.job); const { snapshot, ...view } = result.job; result = { ...result, job: view } }
    if (result.proposal?.status === 'accepted') { await library.index(id, store, user); void library.archive(id, user.sub) }
  }
  else if (action === 'demo') {
    const block = store.snapshot().blocks.find(b => b.id === data.blockId && b.plain && b.text)
    if (!block) throw new Error('Place the caret in a plain-text paragraph for the local test.')
    const job = store.enqueue({ instruction: 'Local approval test — no agent involved', blockIds: [block.id], sessionId: 'local-test', sessionName: 'Local test', requestedBy: { sub: user.sub, name: user.name } })
    store.claim(job.id, 'local-test')
    store.activity(job.id, 'local-test', { state: 'writing', progress: 60, message: 'Drafting a fixture' })
    result = store.propose({ jobId: job.id, type: 'replace', blockId: block.id, blockRevision: block.revision, before: block.text, after: block.text.replace(/\s+$/, '') + ' This sentence is a local test suggestion.', explanation: 'A fixture for trying accept, reject, reconsider and stale detection. No model was called.' }, 'local-test')
    store.propose({ jobId: job.id, type: 'insert', anchorBlockId: block.id, placement: 'after', markdown: '> A local insert fixture. Edit this text, then accept or reject it.\n\n- It can carry lists\n- and other Markdown', explanation: 'Shows how inserted content is reviewed. No model was called.' }, 'local-test')
    store.status(job.id, 'local-test', 'completed', 'Local fixture generated')
  }
  else notFound()
  void library.save(id, user.sub)
  return result
}

async function handleApi(req, res, url, user) {
  const path = url.pathname
  const body = ['POST', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : ''
  let data = {}
  if (body) { try { data = JSON.parse(body) } catch { return json(res, 400, { error: 'Invalid JSON' }) } }
  const parts = path.split('/').slice(2).map(decodeURIComponent)   // ['documents', ':id', ...]
  const [head, a, b] = parts
  const m = req.method
  return serial(async () => {
    try {
      let result
      if (head === 'd' && a && b && parts.length === 3) result = await handleDocument(req, a, b, data, user, url)
      else if (m === 'GET' && path === '/api/me') result = { sub: user.sub, email: user.email, name: user.name, via: user.via, mcpUrl: publicUrl(req) + '/mcp' }
      else if (m === 'GET' && path === '/api/tokens') result = await db.tokens(user.sub)
      else if (m === 'POST' && path === '/api/tokens') result = await auth.mintToken(user.sub, data.name)
      else if (m === 'DELETE' && head === 'tokens' && a && parts.length === 2) { if (!(await db.revokeToken(a, user.sub))) notFound(); result = { ok: true } }
      else if (m === 'GET' && path === '/api/library') result = await library.library()
      else if (m === 'POST' && path === '/api/documents') result = await library.create(data, user)
      else if (head === 'documents' && a && parts.length === 2) {
        if (m === 'GET') result = await library.get(a)
        else if (m === 'PATCH') result = await library.patch(a, data, user)
        else if (m === 'DELETE') result = await library.remove(a)
        else notFound()
      }
      else if (m === 'POST' && head === 'documents' && a && b === 'restore' && parts.length === 3) result = await library.restore(a)
      else if (m === 'GET' && head === 'documents' && a && b === 'export.md' && parts.length === 3) {
        const doc = await db.document(a, { deleted: true }); if (!doc) notFound()
        const markdown = await library.exportMarkdown(a)
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${doc.slug}.md"`, 'Cache-Control': 'no-store', 'X-Build': buildId })
        return res.end(markdown)
      }
      else if (m === 'POST' && path === '/api/folders') result = { path: await db.createFolder(data.path, user.sub) }
      else if (m === 'DELETE' && path === '/api/folders') { await db.deleteFolder(url.searchParams.get('path') ?? data.path); result = { ok: true } }
      else if (m === 'GET' && path === '/api/search') result = { results: await library.search(url.searchParams.get('q'), { folder: url.searchParams.get('folder') || undefined, tag: url.searchParams.get('tag') || undefined, limit: url.searchParams.get('limit') || undefined }) }
      else if (m === 'GET' && path === '/api/tags') result = await db.tags()
      else if (m === 'GET' && head === 'tags' && a && parts.length === 2) result = (await db.byTag(a)).map(d => ({ id: d.id, title: d.title, folder: d.folder, slug: d.slug, tags: d.tags, wordCount: d.wordCount, updatedAt: d.updatedAt, updatedBy: d.updatedBy }))
      else notFound()
      json(res, 200, result)
    } catch (e) {
      const status = e.status ?? (/not found/i.test(e.message) ? 404 : 400)
      if (status >= 500) console.error(e)
      json(res, status, { error: e.message })
    }
  })
}
const unreachable = e => e.name === 'TimeoutError' || e.name === 'AbortError' || /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ETIMEDOUT/.test([e.cause?.code, e.cause?.message, e.message].join(' '))
async function handleTts(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })
  let data
  try { data = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'Invalid JSON' }) }
  const text = String(data.text ?? '').trim().slice(0, 2000)
  if (!text) return json(res, 400, { error: 'Nothing to speak' })
  const speed = Math.min(2, Math.max(0.5, Number(data.speed) || 1))
  const body = JSON.stringify({ input: text, voice: kokoro.voice, speed, response_format: 'wav' })
  // Stick with the base that last answered; move on to the next only when a request cannot reach it.
  for (let attempt = 0; attempt < kokoro.urls.length; attempt++) {
    const base = kokoro.urls[(kokoro.active + attempt) % kokoro.urls.length]
    try {
      const upstream = await fetch(base + '/v1/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(45000) })
      if (!upstream.ok) { const detail = await upstream.text().catch(() => ''); return json(res, 502, { error: `Text to speech failed (${upstream.status}): ${detail.slice(0, 200)}` }) }
      kokoro.active = (kokoro.active + attempt) % kokoro.urls.length
      const audio = Buffer.from(await upstream.arrayBuffer())
      res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') ?? 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store', 'X-Build': buildId, 'X-TTS-Voice': kokoro.voice })
      return res.end(audio)
    } catch (e) {
      if (!unreachable(e) || attempt === kokoro.urls.length - 1) return json(res, 502, { error: 'Text to speech is unreachable: ' + (e.cause?.message ?? e.message) })
    }
  }
}

const descriptions = new Map()
const DESCRIBE_SYSTEM = 'You narrate documents aloud for a listener who cannot see the screen. Reply with plain spoken prose only: no markdown, no bullet points, no code, no preamble.'
async function describeWithLlm(kind, source, language) {
  const prompt = kind === 'diagram'
    ? `This Mermaid diagram appears in a document. Explain what the chart is showing in two or three short spoken sentences. Begin with a lowercase noun phrase that completes the sentence "A chart or diagram showing …" (for example: "a three-step flow from writing to review").\n\n\`\`\`mermaid\n${source}\n\`\`\``
    : `This ${language ? language + ' ' : ''}code block appears in a document. Summarise what the code does in one or two short spoken sentences for someone listening, without reading the code itself.\n\n\`\`\`${language ?? ''}\n${source}\n\`\`\``
  const upstream = await fetch(describeLlm.url + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(describeLlm.timeout),
    body: JSON.stringify({ model: describeLlm.model, stream: false, temperature: 0.2, max_tokens: 200, think: false, reasoning_effort: 'none', messages: [{ role: 'system', content: DESCRIBE_SYSTEM }, { role: 'user', content: prompt }] }),
  })
  if (!upstream.ok) throw new Error(`describe model returned ${upstream.status}`)
  const result = await upstream.json()
  return spokenText(String(result.choices?.[0]?.message?.content ?? ''))
}
async function handleDescribe(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })
  let data
  try { data = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'Invalid JSON' }) }
  const kind = data.kind === 'diagram' ? 'diagram' : 'code'
  const source = String(data.source ?? '').slice(0, 12000)
  const language = kind === 'diagram' ? 'mermaid' : String(data.language ?? '').trim().toLowerCase() || null
  if (!source.trim()) return json(res, 200, { text: kind === 'diagram' ? 'An empty diagram.' : codeUtterance(language, ''), source: 'fallback' })
  const key = createHash('sha256').update(`${kind}\n${language}\n${source}`).digest('hex')
  const cached = descriptions.get(key)
  if (cached) return json(res, 200, { text: cached, source: 'llm', cached: true })
  try {
    const spoken = await describeWithLlm(kind, source, language)
    if (!spoken) throw new Error('empty description')
    const text = kind === 'diagram' ? diagramUtterance(spoken) : codeUtterance(language, spoken)
    descriptions.set(key, text)
    if (descriptions.size > 500) descriptions.delete(descriptions.keys().next().value)
    return json(res, 200, { text, source: 'llm', cached: false })
  } catch (e) {
    console.error('describe failed: ' + (e.cause?.message ?? e.message))
    return json(res, 200, { text: kind === 'diagram' ? diagramUtterance(describeDiagramFallback(source)) : describeCodeFallback(language, source), source: 'fallback' })
  }
}
function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '')
  const proto = req.headers['x-forwarded-proto'] ?? 'http'
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`
}

let buildId = 'dev'
try { buildId = (await readFile(join(distDir, 'index.html'), 'utf8')).match(/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? 'dev' } catch {}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
async function serveStatic(res, path) {
  if (!existsSync(distDir)) { res.writeHead(503, { 'Content-Type': 'text/plain' }); return res.end('Run npm run build, or use the Vite dev server.') }
  let file = normalize(join(distDir, path === '/' ? 'index.html' : path))
  if (!file.startsWith(distDir)) { res.writeHead(403); return res.end() }
  try { if (!(await stat(file)).isFile()) throw new Error() } catch { file = join(distDir, 'index.html') }
  const immutable = file.includes('/assets/')
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' })
  createReadStream(file).pipe(res)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    if (path === '/healthz') return json(res, 200, { ok: true, sessions: sessions.size, documents: library.cache.size })
    if (path === '/api/config') return json(res, 200, { authority: oidc.authority, clientId: oidc.clientId, build: buildId, devUser: auth.dev ? auth.dev.email : undefined })
    if (path.startsWith('/api/') || path === '/mcp') {
      const user = await auth.authenticate(req, { mcpOnly: path === '/mcp' })
      if (!user) { res.setHeader('WWW-Authenticate', 'Bearer realm="notebook-duplex"'); return json(res, 401, { error: 'Unauthorized' }) }
      if (path === '/mcp') return await handleMcp(req, res, user)
      if (path === '/api/tts') return await handleTts(req, res)
      if (path === '/api/describe') return await handleDescribe(req, res)
      return await handleApi(req, res, url, user)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' })
    return await serveStatic(res, path)
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, 500, { error: e.message })
    else res.end()
  }
})
server.keepAliveTimeout = 65000
server.headersTimeout = 70000
server.listen(port, host, () => console.log(`Notebook Duplex listening on http://${host}:${server.address().port} (bucket: ${storage.bucket})`))
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return
  stopping = true
  server.close(); for (const id of [...sessions.keys()]) dropSession(id)
  library.flush().catch(() => {}).then(() => db.close()).finally(() => process.exit(0))
})
