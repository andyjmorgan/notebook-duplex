import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Store } from './store.mjs'
import { createMcpServer, channelNotification } from './mcp.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const dataDir = resolve(process.env.DATA_DIR ?? join(root, '.runtime'))
const distDir = resolve(process.env.STATIC_DIR ?? join(root, 'dist'))
const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'
const apiKey = process.env.NOTEBOOK_API_KEY || (() => { const k = randomBytes(24).toString('base64url'); console.log('NOTEBOOK_API_KEY not set. Using a generated key for this run:\n  ' + k); return k })()
const keyBuffer = Buffer.from(apiKey)
const sessionGrace = Number(process.env.SESSION_GRACE_MS ?? 20000)

await mkdir(dataDir, { recursive: true, mode: 0o700 })
let saved
try { saved = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
const sessions = new Map()
const store = new Store(saved, { isLiveSession: id => sessions.has(id) || id === 'local-test' })
const transports = new Map()

let saveTimer, saving = Promise.resolve(), waiters = []
async function writeState() {
  const tmp = join(dataDir, 'state.tmp')
  await writeFile(tmp, JSON.stringify(store.state), { mode: 0o600 })
  await rename(tmp, join(dataDir, 'state.json'))
}
// Debounced, but every caller's promise resolves once the next write completes.
function save() {
  return new Promise(done => {
    waiters.push(done)
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const batch = waiters; waiters = []
      saving = saving.then(writeState).catch(e => console.error('save failed: ' + e.message)).finally(() => batch.forEach(d => d()))
    }, 50)
  })
}

function authorized(req) {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  return given.length === keyBuffer.length && timingSafeEqual(given, keyBuffer)
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Build': buildId }); res.end(JSON.stringify(data)) }
function readBody(req) {
  return new Promise((ok, fail) => { let body = ''; req.on('data', c => { body += c; if (body.length > 4_000_000) { req.destroy(); fail(new Error('Body too large')) } }); req.on('end', () => ok(body)); req.on('error', fail) })
}

const sessionView = () => [...sessions.values()].map(s => ({ id: s.id, name: s.name, repo: s.repo, connectedAt: s.connectedAt, lastSeen: s.lastSeen, connected: true, streaming: s.streams > 0 }))

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
  // Jobs orphaned by a restart or disconnect go to a live session of the same name (same repo), else wait for list_jobs.
  for (const job of store.orphans()) { const heir = [...sessions.values()].find(s => s.name === job.sessionName); if (heir) { store.reassign(job, heir.id); void save() } }
  store.expireOrphans(Number(process.env.ORPHAN_MAX_AGE_MS ?? 600000))
  for (const job of store.state.jobs) if (job.status === 'queued' && sessions.has(job.sessionId) && Date.now() - (job.notifiedAt ?? 0) > 20000 && (job.notifyCount ?? 0) < 30) void notify(job)
}, Math.min(5000, sessionGrace)).unref()

async function handleMcp(req, res) {
  const sessionId = req.headers['mcp-session-id']
  let transport = sessionId ? transports.get(sessionId) : undefined
  if (req.method === 'POST' && !transport) {
    const body = await readBody(req)
    let parsed
    try { parsed = JSON.parse(body) } catch { return json(res, 400, { error: 'Invalid JSON' }) }
    const isInit = (Array.isArray(parsed) ? parsed : [parsed]).some(m => m?.method === 'initialize')
    if (!isInit) return json(res, sessionId ? 404 : 400, { jsonrpc: '2.0', error: { code: -32000, message: sessionId ? 'Session not found. Reconnect to start a new session.' : 'Missing session. Send initialize first.' }, id: null })
    const session = { id: '', name: 'Claude', repo: '', connectedAt: Date.now(), lastSeen: Date.now(), streams: 0 }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore: new MemoryEventStore(),
      onsessioninitialized: id => {
        session.id = id
        sessions.set(id, session); transports.set(id, transport)
        console.log(`session ${id.slice(0, 8)} connected (${session.name})`)
      },
      onsessionclosed: id => dropSession(id),
    })
    transport.onclose = () => { if (session.id) dropSession(session.id) }
    session.mcp = createMcpServer(session, store, save)
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

async function handleApi(req, res, path) {
  const body = req.method === 'POST' ? await readBody(req) : ''
  const data = body ? JSON.parse(body) : {}
  return serial(async () => {
    try {
      let result
      if (req.method === 'GET' && path === '/api/state') {
        result = { ...store.view(), sessions: sessionView() }
        if (new URL(req.url, 'http://localhost').searchParams.has('lite')) result.document = { ...result.document, json: undefined, markdown: undefined }
      }
      else if (req.method === 'GET' && path === '/api/me') result = { ok: true, mcpUrl: publicUrl(req) + '/mcp' }
      else if (req.method === 'POST' && path === '/api/sync') result = store.sync(data)
      else if (req.method === 'POST' && path === '/api/jobs') {
        const session = sessions.get(data.sessionId)
        if (!session) throw new Error('Choose a connected Claude session first.')
        const job = store.enqueue({ ...data, sessionName: session.name })
        void notify(job)
        const { snapshot, ...view } = job
        result = view
      }
      else if (req.method === 'POST' && path === '/api/cancel') { store.cancel(data.id); result = { ok: true } }
      else if (req.method === 'POST' && path === '/api/review') {
        result = store.review(data.id, data.decision, data)
        if (result.job) { void notify(result.job); const { snapshot, ...view } = result.job; result = { ...result, job: view } }
      }
      else if (req.method === 'POST' && path === '/api/demo') {
        const block = store.snapshot().blocks.find(b => b.id === data.blockId && b.plain && b.text)
        if (!block) throw new Error('Place the caret in a plain-text paragraph for the local test.')
        const job = store.enqueue({ instruction: 'Local approval test — no agent involved', blockIds: [block.id], sessionId: 'local-test', sessionName: 'Local test' })
        store.claim(job.id, 'local-test')
        store.activity(job.id, 'local-test', { state: 'writing', progress: 60, message: 'Drafting a fixture' })
        result = store.propose({ jobId: job.id, type: 'replace', blockId: block.id, blockRevision: block.revision, before: block.text, after: block.text.replace(/\s+$/, '') + ' This sentence is a local test suggestion.', explanation: 'A fixture for trying accept, reject, reconsider and stale detection. No model was called.' }, 'local-test')
        store.propose({ jobId: job.id, type: 'insert', anchorBlockId: block.id, placement: 'after', markdown: '> A local insert fixture. Edit this text, then accept or reject it.\n\n- It can carry lists\n- and other Markdown', explanation: 'Shows how inserted content is reviewed. No model was called.' }, 'local-test')
        store.status(job.id, 'local-test', 'completed', 'Local fixture generated')
      }
      else return json(res, 404, { error: 'Not found' })
      if (req.method === 'POST') void save()
      json(res, 200, result)
    } catch (e) { json(res, 400, { error: e.message }) }
  })
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
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/healthz') return json(res, 200, { ok: true, sessions: sessions.size })
    if (path.startsWith('/api/') || path === '/mcp') {
      if (!authorized(req)) { res.setHeader('WWW-Authenticate', 'Bearer realm="notebook-duplex"'); return json(res, 401, { error: 'Unauthorized' }) }
      if (path === '/mcp') return await handleMcp(req, res)
      return await handleApi(req, res, path)
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
server.listen(port, host, () => console.log(`Notebook Duplex listening on http://${host}:${server.address().port} (data: ${dataDir})`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); for (const id of [...sessions.keys()]) dropSession(id); saving.then(() => process.exit(0)) })
