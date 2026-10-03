import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { startServer, until } from './test-helpers.mjs'
import { Db } from './db.mjs'

const channel = z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string()) }) })
const document = () => ({ type: 'doc', content: [
  { type: 'heading', attrs: { id: 'h', level: 2 }, content: [{ type: 'text', text: 'Notes' }] },
  { type: 'paragraph', attrs: { id: 'p', }, content: [{ type: 'text', text: 'A draft paragraph.' }] },
  { type: 'paragraph', attrs: { id: 'q' }, content: [{ type: 'text', text: 'Another paragraph.' }] },
] })
const text = result => JSON.parse(result.content[0].text)

async function connect(url, token, notifications) {
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} })
  client.setNotificationHandler(channel, event => notifications.push(event.params))
  const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } })
  await client.connect(transport)
  return { client, transport }
}

test('without a dev user, requests need a Keycloak or agent token; config and health stay public', async t => {
  const { url } = await startServer(t, { AUTH_DEV_USER: undefined, OIDC_ISSUER: 'https://auth.example/realms/x', OIDC_JWKS_URL: 'http://127.0.0.1:9/certs', OIDC_CLIENT_ID: 'notebook-duplex' })
  assert.equal((await fetch(url + '/api/library')).status, 401)
  assert.equal((await fetch(url + '/api/tts', { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(url + '/api/describe', { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await fetch(url + '/api/library', { headers: { Authorization: 'Bearer not.a.jwt' } })).status, 401)
  assert.equal((await fetch(url + '/healthz')).status, 200)
  const config = await fetch(url + '/api/config')
  assert.equal(config.status, 200)
  const { build, ...rest } = await config.json()
  assert.deepEqual(rest, { authority: 'https://auth.example/realms/x', clientId: 'notebook-duplex' }, 'no devUser is advertised')
  assert.equal(config.headers.get('x-build'), build)
})

test('remote MCP session receives channel notifications and the full review cycle works', async t => {
  const { url, apiKey, createDocument, backend } = await startServer(t)
  const { id, doc } = await createDocument({ title: 'Test' })
  const notifications = []
  const { client } = await connect(url, apiKey, notifications)
  t.after(() => client.close())
  assert.deepEqual(client.getServerCapabilities().experimental['claude/channel'], {})
  await client.callTool({ name: 'identify_session', arguments: { name: 'Integration test', repo: '/tmp/repo' } })
  const session = await until(async () => (await doc('state')).data.sessions.find(s => s.name === 'Integration test'))
  assert.equal(session.connected, true)
  assert.equal(session.repo, '/tmp/repo')
  assert.equal(session.user, 'dev')
  assert.equal((await doc('sync', { json: document(), markdown: '', title: 'Test', expectedRevision: 0 })).ok, true)

  const { data: job } = await doc('jobs', { instruction: 'Improve this paragraph.', blockIds: ['p'], sessionId: session.id })
  assert.equal(job.documentId, id)
  assert.deepEqual(job.requestedBy, { sub: 'dev:dev@example.com', name: 'dev' })
  const event = await until(() => notifications.find(n => n.meta.job_id === job.id))
  assert.match(event.content, /Improve this paragraph/)
  assert.equal(event.meta.kind, 'command')
  assert.equal(event.meta.document_id, id)
  assert.equal(event.meta.document_title, 'Test')

  const claim = text(await client.callTool({ name: 'claim_job', arguments: { jobId: job.id } }))
  assert.equal(claim.documentId, id)
  assert.equal(claim.documentTitle, 'Test')
  const block = claim.snapshot.blocks.find(b => b.id === 'p')
  let state = (await doc('state')).data
  assert.equal(state.activity[0].state, 'reading', 'claiming marks the scope as being read')

  await client.callTool({ name: 'set_block_status', arguments: { jobId: job.id, state: 'writing', progress: 40, message: 'Rewriting' } })
  state = (await doc('state')).data
  assert.deepEqual(state.activity[0].blockIds, ['p'])
  assert.equal(state.activity[0].progress, 40)

  const replace = text(await client.callTool({ name: 'propose_changes', arguments: { jobId: job.id, type: 'replace', blockId: 'p', blockRevision: block.revision, before: block.text, after: 'A clearer paragraph.', explanation: 'More direct.' } }))
  const insert = text(await client.callTool({ name: 'propose_changes', arguments: { jobId: job.id, type: 'insert', anchorBlockId: 'p', placement: 'after', markdown: 'New *content*.', explanation: 'Adds a missing point.' } }))
  const bad = await client.callTool({ name: 'propose_changes', arguments: { jobId: job.id, type: 'replace', blockId: 'q', blockRevision: 'x', before: 'Another paragraph.', after: 'Nope', explanation: 'out of scope' } })
  assert.equal(bad.isError, true)
  assert.equal((await doc('state')).data.document.json.content[1].content[0].text, 'A draft paragraph.', 'proposals never change canonical text')

  const reconsidered = await doc('review', { id: replace.id, decision: 'reconsider', feedback: 'Keep the word draft.' })
  assert.equal(reconsidered.data.proposal.status, 'reconsidered')
  const followUp = await until(() => notifications.find(n => n.meta.job_id === reconsidered.data.job.id))
  assert.match(followUp.content, /reconsider/)
  const followClaim = text(await client.callTool({ name: 'claim_job', arguments: { jobId: reconsidered.data.job.id, documentId: id } }))
  assert.equal(followClaim.context.feedback, 'Keep the word draft.')
  assert.match(followClaim.instruction, /Keep the word draft/)
  const revised = text(await client.callTool({ name: 'propose_changes', arguments: { jobId: followClaim.id, type: 'replace', blockId: 'p', blockRevision: block.revision, before: block.text, after: 'A clearer draft paragraph.', explanation: 'Kept draft.' } }))

  const accepted = await doc('review', { id: revised.id, decision: 'accept', text: 'A clearer draft paragraph, edited by the writer.' })
  assert.equal(accepted.data.document.json.content[1].content[0].text, 'A clearer draft paragraph, edited by the writer.')
  const insertAccepted = await doc('review', { id: insert.id, decision: 'accept', nodes: [{ type: 'paragraph', content: [{ type: 'text', text: 'New ' }, { type: 'text', text: 'content', marks: [{ type: 'italic' }] }, { type: 'text', text: '.' }] }] })
  const content = insertAccepted.data.document.json.content
  assert.equal(content.length, 4)
  assert.equal(content[2].content[1].text, 'content')
  assert.ok(content[2].attrs.id, 'inserted blocks receive stable IDs')

  const reread = text(await client.callTool({ name: 'get_document_snapshot', arguments: { jobId: job.id } }))
  assert.equal(reread.blocks.find(b => b.id === 'p').text, 'A draft paragraph.', 'job snapshots stay immutable')
  const live = text(await client.callTool({ name: 'get_document_snapshot', arguments: { documentId: id } }))
  assert.equal(live.blocks.find(b => b.id === 'p').text, 'A clearer draft paragraph, edited by the writer.')
  await client.callTool({ name: 'report_job_status', arguments: { jobId: job.id, status: 'completed', message: 'Done' } })
  state = (await doc('state')).data
  assert.equal(state.jobs.find(j => j.id === job.id).status, 'completed')
  assert.equal(state.activity.some(a => a.jobId === job.id), false, 'finishing clears activity')
  const tools = await client.listTools()
  assert.equal(tools.tools.some(tool => /accept|review/.test(tool.name)), false)
  // Accepted proposals archive a revision and refresh the catalogue.
  const detail = await until(async () => { const d = (await doc('state')).data.document; return d.revision === 3 && d })
  assert.equal(detail.title, 'Test')
  const search = await until(async () => (await (await fetch(url + '/api/search?q=clearer', { headers: { Authorization: 'Bearer dev' } })).json()).results.find(r => r.id === id))
  assert.match(search.snippet, /<mark>clearer<\/mark>/)
  const db = new Db(backend.databaseUrl)
  t.after(() => db.close())
  const revisions = await until(async () => { const rows = await db.revisions(id); return rows.length === 2 && rows })
  assert.deepEqual(revisions.map(r => [r.revision, r.stateKey, r.author]), [[3, `docs/${id}/rev/3.json`, 'dev:dev@example.com'], [2, `docs/${id}/rev/2.json`, 'dev:dev@example.com']])
})

test('queued jobs are re-notified and sessions disappear on disconnect', async t => {
  const { url, apiKey, createDocument } = await startServer(t)
  const { doc } = await createDocument()
  const notifications = []
  const { client } = await connect(url, apiKey, notifications)
  const session = await until(async () => (await doc('state')).data.sessions[0])
  assert.equal(session.name, 'Claude Code')
  await doc('sync', { json: document(), expectedRevision: 0 })
  const { data: job } = await doc('jobs', { instruction: 'Hello', blockIds: [], sessionId: session.id })
  await until(() => notifications.some(n => n.meta.job_id === job.id))
  const listed = text(await client.callTool({ name: 'list_jobs', arguments: {} }))
  assert.equal(listed.jobs[0].id, job.id)
  assert.equal(listed.jobs[0].documentTitle, 'Test document')
  await client.close()
  await until(async () => (await doc('state')).data.sessions.length === 0)
  const rejected = await doc('jobs', { instruction: 'Hello again', blockIds: [], sessionId: session.id })
  assert.equal(rejected.status, 400)
})

test('local fixture produces a replace and an insert proposal without a session', async t => {
  const { createDocument } = await startServer(t)
  const { doc } = await createDocument()
  await doc('sync', { json: document(), expectedRevision: 0 })
  const { data } = await doc('demo', { blockId: 'p' })
  const state = (await doc('state')).data
  assert.equal(state.proposals.length, 2)
  assert.equal(data.type, 'replace')
  assert.equal(state.proposals[1].type, 'insert')
  assert.equal(state.proposals[1].anchorBlockId, 'p')
})

test('jobs are per document and sessions span documents', async t => {
  const { url, apiKey, createDocument } = await startServer(t)
  const a = await createDocument({ title: 'Alpha' })
  const b = await createDocument({ title: 'Beta' })
  const notifications = []
  const { client } = await connect(url, apiKey, notifications)
  t.after(() => client.close())
  const session = await until(async () => (await a.doc('state')).data.sessions[0])
  await a.doc('sync', { json: document(), expectedRevision: 0 })
  await b.doc('sync', { json: document(), expectedRevision: 0 })
  const { data: jobA } = await a.doc('jobs', { instruction: 'In alpha', blockIds: ['p'], sessionId: session.id })
  const { data: jobB } = await b.doc('jobs', { instruction: 'In beta', blockIds: ['q'], sessionId: session.id })
  const listed = text(await client.callTool({ name: 'list_jobs', arguments: {} }))
  assert.deepEqual(listed.jobs.map(j => [j.documentTitle, j.instruction]).sort(), [['Alpha', 'In alpha'], ['Beta', 'In beta']])
  const claimB = text(await client.callTool({ name: 'claim_job', arguments: { jobId: jobB.id } }))
  assert.equal(claimB.documentId, b.id)
  assert.equal((await a.doc('state')).data.jobs.find(j => j.id === jobA.id).status, 'queued')
  assert.equal((await b.doc('state')).data.jobs.find(j => j.id === jobB.id).status, 'running')
  assert.equal((await a.doc('state')).data.jobs.some(j => j.id === jobB.id), false, 'a document only lists its own jobs')
  const unknown = await client.callTool({ name: 'claim_job', arguments: { jobId: 'nope' } })
  assert.equal(unknown.isError, true)
})
