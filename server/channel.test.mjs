import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { startServer, until } from './test-helpers.mjs'

const channel = z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string()) }) })

test('stdio channel shim proxies tools and forwards channel notifications from the hosted server', async t => {
  const { url, apiKey, request } = await startServer(t)
  const notifications = []
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} })
  client.setNotificationHandler(channel, e => notifications.push(e.params))
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../agent/channel.mjs', import.meta.url)), '--url', url, '--key', apiKey, '--name', 'shim-test'], stderr: 'pipe' })
  await client.connect(transport)
  t.after(() => client.close())
  assert.deepEqual(client.getServerCapabilities().experimental['claude/channel'], {})
  const session = await until(async () => (await request('/api/state')).data.sessions.find(s => s.name === 'shim-test'))
  assert.equal(session.repo, process.cwd())
  const tools = (await client.listTools()).tools.map(t => t.name)
  assert.ok(tools.includes('claim_job') && tools.includes('propose_changes') && !tools.includes('identify_session'))
  await request('/api/sync', { json: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'p' }, content: [{ type: 'text', text: 'Hello.' }] }] }, expectedRevision: 0 })
  const { data: job } = await request('/api/jobs', { instruction: 'Say hi', blockIds: ['p'], sessionId: session.id })
  const event = await until(() => notifications.find(n => n.meta.job_id === job.id))
  assert.match(event.content, /Say hi/)
  const claim = JSON.parse((await client.callTool({ name: 'claim_job', arguments: { jobId: job.id } })).content[0].text)
  assert.equal(claim.id, job.id)
  const bad = await client.callTool({ name: 'claim_job', arguments: { jobId: 'nope' } })
  assert.equal(bad.isError, true)
})
