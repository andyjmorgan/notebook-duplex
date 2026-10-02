import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { startServer, until } from './test-helpers.mjs'

const channel = z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string()) }) })
const document = () => ({ type: 'doc', content: [
  { type: 'heading', attrs: { id: 'h', level: 2 }, content: [{ type: 'text', text: 'Notes' }] },
  { type: 'paragraph', attrs: { id: 'p', }, content: [{ type: 'text', text: 'A draft paragraph.' }] },
  { type: 'paragraph', attrs: { id: 'q' }, content: [{ type: 'text', text: 'Another paragraph.' }] },
] })
const text = result => JSON.parse(result.content[0].text)

async function connect(url, apiKey, notifications) {
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} })
  client.setNotificationHandler(channel, event => notifications.push(event.params))
  const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + apiKey } } })
  await client.connect(transport)
  return { client, transport }
}

test('rejects requests without the API key', async t => {
  const { url } = await startServer(t)
  assert.equal((await fetch(url + '/api/state')).status, 401)
  assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await fetch(url + '/healthz')).status, 200)
})

test('remote MCP session receives channel notifications and the full review cycle works', async t => {
  const { url, apiKey, request } = await startServer(t)
  const notifications = []
  const { client } = await connect(url, apiKey, notifications)
  t.after(() => client.close())
  assert.deepEqual(client.getServerCapabilities().experimental['claude/channel'], {})
  await client.callTool({ name: 'identify_session', arguments: { name: 'Integration test', repo: '/tmp/repo' } })
  const session = await until(async () => (await request('/api/state')).data.sessions.find(s => s.name === 'Integration test'))
  assert.equal(session.connected, true)
  assert.equal(session.repo, '/tmp/repo')
  assert.equal((await request('/api/sync', { json: document(), markdown: '', title: 'Test', expectedRevision: 0 })).ok, true)

  const { data: job } = await request('/api/jobs', { instruction: 'Improve this paragraph.', blockIds: ['p'], sessionId: session.id })
  const event = await until(() => notifications.find(n => n.meta.job_id === job.id))
  assert.match(event.content, /Improve this paragraph/)
  assert.equal(event.meta.kind, 'command')

  const claim = text(await client.callTool({ name: 'claim_job', arguments: { jobId: job.id } }))
  const block = claim.snapshot.blocks.find(b => b.id === 'p')
  let state = (await request('/api/state')).data
  assert.equal(state.activity[0].state, 'reading', 'claiming marks the scope as being read')

  await client.callTool({ name: 'set_block_status', arguments: { jobId: job.id, state: 'writing', progress: 40, message: 'Rewriting' } })
  state = (await request('/api/state')).data
  assert.deepEqual(state.activity[0].blockIds, ['p'])
  assert.equal(state.activity[0].progress, 40)

  const replace = text(await client.callTool({ name: 'propose_changes', arguments: { jobId: job.id, type: 'replace', blockId: 'p', blockRevision: block.revision, before: block.text, after: 'A clearer paragraph.', explanation: 'More direct.' } }))
  const insert = text(await client.callTool({ name: 'propose_changes', arguments: { jobId: job.id, type: 'insert', anchorBlockId: 'p', placement: 'after', markdown: 'New *content*.', explanation: 'Adds a missing point.' } }))
  const bad = await client.callTool({ name: 'propose_changes', arguments: { jobId: job.id, type: 'replace', blockId: 'q', blockRevision: 'x', before: 'Another paragraph.', after: 'Nope', explanation: 'out of scope' } })
  assert.equal(bad.isError, true)
  assert.equal((await request('/api/state')).data.document.json.content[1].content[0].text, 'A draft paragraph.', 'proposals never change canonical text')

  const reconsidered = await request('/api/review', { id: replace.id, decision: 'reconsider', feedback: 'Keep the word draft.' })
  assert.equal(reconsidered.data.proposal.status, 'reconsidered')
  const followUp = await until(() => notifications.find(n => n.meta.job_id === reconsidered.data.job.id))
  assert.match(followUp.content, /reconsider/)
  const followClaim = text(await client.callTool({ name: 'claim_job', arguments: { jobId: reconsidered.data.job.id } }))
  assert.equal(followClaim.context.feedback, 'Keep the word draft.')
  assert.match(followClaim.instruction, /Keep the word draft/)
  const revised = text(await client.callTool({ name: 'propose_changes', arguments: { jobId: followClaim.id, type: 'replace', blockId: 'p', blockRevision: block.revision, before: block.text, after: 'A clearer draft paragraph.', explanation: 'Kept draft.' } }))

  const accepted = await request('/api/review', { id: revised.id, decision: 'accept', text: 'A clearer draft paragraph, edited by the writer.' })
  assert.equal(accepted.data.document.json.content[1].content[0].text, 'A clearer draft paragraph, edited by the writer.')
  const insertAccepted = await request('/api/review', { id: insert.id, decision: 'accept', nodes: [{ type: 'paragraph', content: [{ type: 'text', text: 'New ' }, { type: 'text', text: 'content', marks: [{ type: 'italic' }] }, { type: 'text', text: '.' }] }] })
  const content = insertAccepted.data.document.json.content
  assert.equal(content.length, 4)
  assert.equal(content[2].content[1].text, 'content')
  assert.ok(content[2].attrs.id, 'inserted blocks receive stable IDs')

  const reread = text(await client.callTool({ name: 'get_document_snapshot', arguments: { jobId: job.id } }))
  assert.equal(reread.blocks.find(b => b.id === 'p').text, 'A draft paragraph.', 'job snapshots stay immutable')
  await client.callTool({ name: 'report_job_status', arguments: { jobId: job.id, status: 'completed', message: 'Done' } })
  state = (await request('/api/state')).data
  assert.equal(state.jobs.find(j => j.id === job.id).status, 'completed')
  assert.equal(state.activity.some(a => a.jobId === job.id), false, 'finishing clears activity')
  const tools = await client.listTools()
  assert.equal(tools.tools.some(tool => /accept|review/.test(tool.name)), false)
})

test('queued jobs are re-notified and sessions disappear on disconnect', async t => {
  const { url, apiKey, request } = await startServer(t)
  const notifications = []
  const { client } = await connect(url, apiKey, notifications)
  const session = await until(async () => (await request('/api/state')).data.sessions[0])
  assert.equal(session.name, 'Claude Code')
  await request('/api/sync', { json: document(), expectedRevision: 0 })
  const { data: job } = await request('/api/jobs', { instruction: 'Hello', blockIds: [], sessionId: session.id })
  await until(() => notifications.some(n => n.meta.job_id === job.id))
  const listed = text(await client.callTool({ name: 'list_jobs', arguments: {} }))
  assert.equal(listed.jobs[0].id, job.id)
  await client.close()
  await until(async () => (await request('/api/state')).data.sessions.length === 0)
  const rejected = await request('/api/jobs', { instruction: 'Hello again', blockIds: [], sessionId: session.id })
  assert.equal(rejected.status, 400)
})

test('local fixture produces a replace and an insert proposal without a session', async t => {
  const { request } = await startServer(t)
  await request('/api/sync', { json: document(), expectedRevision: 0 })
  const { data } = await request('/api/demo', { blockId: 'p' })
  const state = (await request('/api/state')).data
  assert.equal(state.proposals.length, 2)
  assert.equal(data.type, 'replace')
  assert.equal(state.proposals[1].type, 'insert')
  assert.equal(state.proposals[1].anchorBlockId, 'p')
})
