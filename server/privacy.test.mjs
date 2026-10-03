import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer, freshBackend } from './test-helpers.mjs'

test('libraries are private: another account cannot see, read, search, edit or reach a document through MCP', async t => {
  const backend = await freshBackend()
  const alice = await startServer(t, { AUTH_DEV_USER: 'alice@example.com' }, { backend })
  const bob = await startServer(t, { AUTH_DEV_USER: 'bob@example.com' }, { backend })
  const { data: doc } = await alice.request('/api/documents', { title: 'Alice private', folder: '/alice', tags: ['secret'], markdown: 'Only Alice should read this sentence.' })
  await alice.request('/api/folders', { path: '/alice/drafts' })
  assert.equal((await alice.request('/api/library')).data.documents.length, 1)

  const lib = (await bob.request('/api/library')).data
  assert.deepEqual(lib.documents, [])
  assert.deepEqual(lib.folders, ['/'], 'folders are per account too')
  assert.notEqual((await bob.request('/api/documents/' + doc.id)).status, 200)
  assert.notEqual((await bob.request('/api/d/' + doc.id + '/state')).status, 200)
  assert.notEqual((await bob.request('/api/d/' + doc.id + '/sync', { json: { type: 'doc', content: [] }, expectedRevision: 0 })).status, 200)
  assert.notEqual((await bob.request('/api/documents/' + doc.id + '/export.md')).status, 200)
  assert.deepEqual((await bob.request('/api/search?q=Alice')).data.results, [])
  assert.deepEqual((await bob.request('/api/tags')).data, [])
  assert.deepEqual((await bob.request('/api/tags/secret')).data, [])
  const patched = await fetch(bob.url + '/api/documents/' + doc.id, { method: 'PATCH', headers: bob.headers, body: JSON.stringify({ title: 'Hijacked' }) })
  assert.notEqual(patched.status, 200)
  const deleted = await fetch(bob.url + '/api/documents/' + doc.id, { method: 'DELETE', headers: bob.headers })
  assert.notEqual(deleted.status, 200)
  assert.equal((await alice.request('/api/documents/' + doc.id)).data.title, 'Alice private', 'nothing changed for the owner')

  // Bob's own document with the same title in the same folder path is fine: names are unique per account, not globally.
  const { data: bobDoc } = await bob.request('/api/documents', { title: 'Alice private', folder: '/alice' })
  assert.equal(bobDoc.slug, doc.slug)

  // MCP as Bob cannot reach Alice's document either.
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(bob.url + '/mcp'), { requestInit: { headers: bob.headers } }))
  t.after(() => client.close())
  const listed = JSON.parse((await client.callTool({ name: 'list_documents', arguments: {} })).content[0].text)
  assert.deepEqual(listed.documents.map(d => d.id), [bobDoc.id])
  assert.equal((await client.callTool({ name: 'get_document', arguments: { documentId: doc.id } })).isError, true)
  assert.equal((await client.callTool({ name: 'get_document_snapshot', arguments: { documentId: doc.id } })).isError, true)
  const found = JSON.parse((await client.callTool({ name: 'search_documents', arguments: { query: 'Alice' } })).content[0].text)
  assert.deepEqual(found.results.map(r => r.id), [bobDoc.id])
})
