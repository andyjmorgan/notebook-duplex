import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer, freshBackend, until } from './test-helpers.mjs'
import { Db, normaliseFolder, slugify, normaliseTags } from './db.mjs'
import { parseFrontMatter, withFrontMatter, markdownToJson, jsonToMarkdown, wikilinks } from './markdown.mjs'

const text = result => JSON.parse(result.content[0].text)
const paragraph = (id, body) => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: body }] })
const docJson = (...paragraphs) => ({ type: 'doc', content: paragraphs.map((p, i) => paragraph('p' + i, p)) })

test('normalisers: folders, slugs and tags', () => {
  assert.equal(normaliseFolder(''), '/'); assert.equal(normaliseFolder('a/b/'), '/a/b'); assert.equal(normaliseFolder(' /a//b '), '/a/b')
  assert.throws(() => normaliseFolder('/a/../b'))
  assert.equal(slugify('Hello, World! Ünïcode'), 'hello-world-unicode'); assert.equal(slugify('   '), 'untitled')
  assert.deepEqual(normaliseTags(['K3s', '#Lab Notes', 'lab-notes', 'ok_tag', '']), ['k3s', 'lab-notes', 'ok-tag'])
  assert.deepEqual(normaliseTags('a, B'), ['a', 'b'])
})

test('front matter parses, survives unknown keys and round-trips through Markdown', () => {
  const { frontmatter, body } = parseFrontMatter('---\ntitle: Plan\ntags: [a, b]\ncustom:\n  nested: true\n---\n\n# Plan\n\nText with [[Other Doc|alias]] and [[Third#section]].\n')
  assert.deepEqual(frontmatter, { title: 'Plan', tags: ['a', 'b'], custom: { nested: true } })
  assert.equal(body.trim().split('\n')[0], '# Plan')
  assert.deepEqual(wikilinks(body), ['Other Doc', 'Third'])
  const out = withFrontMatter({ title: 'Plan', tags: ['a'], folder: undefined, custom: { nested: true } }, body)
  assert.match(out, /^---\ntitle: Plan\ntags:\n  - a\ncustom:\n  nested: true\n---\n\n# Plan/)
  assert.deepEqual(parseFrontMatter(out).frontmatter, { title: 'Plan', tags: ['a'], custom: { nested: true } })
  const md = jsonToMarkdown(markdownToJson(body))
  assert.match(md, /^# Plan\n\nText with \[\[Other Doc\|alias\]\] and \[\[Third#section\]\]\.\n$/)
  assert.deepEqual(parseFrontMatter('no front matter\n---\nnot yaml\n---\n'), { frontmatter: {}, body: 'no front matter\n---\nnot yaml\n---\n' })
})

test('migrations are idempotent', async () => {
  const backend = await freshBackend()
  const db = new Db(backend.databaseUrl)
  try {
    assert.equal(await db.migrate(), 2)
    assert.equal(await db.migrate(), 2)
    assert.equal((await db.query('select count(*)::int as n from schema_migrations'))[0].n, 2)
    assert.equal((await db.query("select count(*)::int as n from information_schema.tables where table_name in ('users','documents','folders','links','access_tokens','revisions')"))[0].n, 6)
    const doc = await db.createDocument({ title: 'Same name' })
    const twin = await db.createDocument({ title: 'Same name' })
    assert.equal(doc.slug, 'same-name'); assert.equal(twin.slug, 'same-name-2')
  } finally { await db.close() }
})

test('documents: create, list, get, patch, move, delete, restore and export', async t => {
  const { request, createDocument } = await startServer(t)
  const a = await createDocument({ title: 'Lab notes', folder: 'projects/lab', tags: ['K3s', 'lab'] })
  assert.equal(a.folder, '/projects/lab'); assert.equal(a.slug, 'lab-notes'); assert.deepEqual(a.tags, ['k3s', 'lab'])
  const b = await createDocument({ title: 'Lab notes', folder: '/projects/lab' })
  assert.equal(b.slug, 'lab-notes-2', 'slugs are unique within a folder')
  const library = (await request('/api/library')).data
  assert.deepEqual(library.folders, ['/', '/projects', '/projects/lab'])
  assert.deepEqual(library.documents.map(d => d.id), [a.id, b.id])
  assert.equal(library.documents[0].updatedBy, 'dev:dev@example.com')

  await a.doc('sync', { json: docJson('First words here.', 'More words.'), title: 'Lab notes', expectedRevision: 0 })
  const detail = (await request('/api/documents/' + a.id)).data
  assert.equal(detail.wordCount, 5); assert.equal(detail.revision, 1); assert.equal(detail.owner, 'dev:dev@example.com')
  assert.equal(detail.frontmatter.title, 'Lab notes'); assert.deepEqual(detail.frontmatter.tags, ['k3s', 'lab']); assert.equal(detail.frontmatter.folder, '/projects/lab')

  const patched = (await request('/api/documents/' + a.id, { title: 'Office notes', folder: '/office' }, 'PATCH')).data
  assert.equal(patched.slug, 'office-notes'); assert.equal(patched.folder, '/office')
  assert.equal((await a.doc('state')).data.document.title, 'Office notes', 'the editor state follows the catalogue title')
  const withProps = (await request('/api/documents/' + a.id, { frontmatter: { title: 'Office notes', tags: ['Ops'], status: 'draft', aliases: ['Notes'] } }, 'PATCH')).data
  assert.deepEqual(withProps.tags, ['ops'])
  const props = (await request('/api/documents/' + a.id)).data.frontmatter
  assert.equal(props.status, 'draft'); assert.deepEqual(props.aliases, ['Notes']); assert.equal(props.folder, '/office')

  const exported = await request('/api/documents/' + a.id + '/export.md')
  assert.equal(exported.headers.get('content-type'), 'text/markdown; charset=utf-8')
  assert.match(exported.headers.get('content-disposition'), /office-notes\.md/)
  assert.match(exported.data, /^---\ntitle: Office notes\ntags:\n  - ops\nfolder: \/office\naliases:\n  - Notes\nstatus: draft\ncreated: .*\nupdated: .*\n---\n\nFirst words here\.\n\nMore words\.\n$/)

  const sync = (await a.doc('sync', { json: docJson('First words here.', 'More words.', 'Third.'), title: 'Office notes', frontmatter: { title: 'Office notes', tags: ['ops', 'k3s'], folder: '/office', status: 'final' }, expectedRevision: 1 })).data
  assert.deepEqual(sync.tags, ['ops', 'k3s']); assert.equal(sync.frontmatter.status, 'final'); assert.equal(sync.revision, 2)

  assert.equal((await request('/api/documents/' + a.id, undefined, 'DELETE')).data.deletedAt !== undefined, true)
  assert.equal((await request('/api/library')).data.documents.map(d => d.id).includes(a.id), false)
  assert.equal((await a.doc('state')).status, 404, 'deleted documents are not editable')
  const restored = (await request('/api/documents/' + a.id + '/restore', {})).data
  assert.equal(restored.deletedAt, undefined)
  assert.equal((await request('/api/library')).data.documents.map(d => d.id).includes(a.id), true)
  assert.equal((await a.doc('state')).data.document.revision, 2, 'state survives delete and restore')
  assert.equal((await request('/api/documents/00000000-0000-0000-0000-000000000000')).status, 404)
  assert.equal((await request('/api/d/not-a-uuid/state')).status, 404)

  assert.deepEqual((await request('/api/folders', { path: 'archive/2026' })).data, { path: '/archive/2026' })
  assert.ok((await request('/api/library')).data.folders.includes('/archive/2026'))
  assert.equal((await request('/api/folders?path=/office', undefined, 'DELETE')).status, 400, 'folders with documents cannot be deleted')
  assert.equal((await request('/api/folders?path=/archive/2026', undefined, 'DELETE')).status, 200)
  assert.equal((await request('/api/library')).data.folders.includes('/archive/2026'), false)
})

test('markdown import strips front matter which wins over the request fields', async t => {
  const { request, createDocument } = await startServer(t)
  const created = await createDocument({ title: 'Ignored', folder: '/ignored', tags: ['x'], markdown: '---\ntitle: From front matter\ntags: [Alpha, beta]\nfolder: /imports\nsource: obsidian\n---\n\n# Heading\n\nA paragraph with **bold**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n' })
  assert.equal(created.title, 'From front matter'); assert.equal(created.folder, '/imports'); assert.deepEqual(created.tags, ['alpha', 'beta'])
  const state = (await created.doc('state')).data.document
  assert.equal(state.json.content[0].type, 'heading'); assert.equal(state.json.content[2].type, 'table')
  assert.ok(state.json.content.every(n => n.attrs?.id), 'imported blocks get ids')
  assert.equal(state.frontmatter.source, 'obsidian')
  const exported = (await request('/api/documents/' + created.id + '/export.md')).data
  assert.match(exported, /source: obsidian/); assert.match(exported, /# Heading\n\nA paragraph with \*\*bold\*\*\./); assert.match(exported, /\| 1 +\| 2 +\|/)
  const untitled = await createDocument({ title: '', markdown: '# Title from heading\n\nBody.' })
  assert.equal(untitled.title, 'Title from heading')
  assert.equal((await createDocument({ title: '' })).title, 'Untitled')
})

test('tags relate documents and wikilinks become links', async t => {
  const { request, createDocument } = await startServer(t)
  const a = await createDocument({ title: 'Alpha', tags: ['k3s', 'office', 'gpu'] })
  const b = await createDocument({ title: 'Beta', tags: ['k3s', 'office'] })
  const c = await createDocument({ title: 'Gamma', tags: ['k3s'] })
  await createDocument({ title: 'Unrelated', tags: ['cooking'] })
  const related = (await request('/api/documents/' + a.id)).data.related
  assert.deepEqual(related.map(r => [r.title, r.sharedTags]), [['Beta', ['k3s', 'office']], ['Gamma', ['k3s']]])
  const tags = (await request('/api/tags')).data
  assert.deepEqual(tags.slice(0, 2), [{ tag: 'k3s', count: 3 }, { tag: 'office', count: 2 }])
  assert.deepEqual((await request('/api/tags/office')).data.map(d => d.title), ['Alpha', 'Beta'])

  await c.doc('sync', { json: docJson('See [[alpha]] and [[Beta|the beta doc]] and [[Missing]].'), expectedRevision: 0 })
  const links = (await request('/api/documents/' + c.id)).data.links
  assert.deepEqual(links.out.map(l => [l.title, l.kind]), [['Alpha', 'wikilink'], ['Beta', 'wikilink']], 'titles match case-insensitively; unknown titles are ignored')
  assert.deepEqual((await request('/api/documents/' + a.id)).data.links.in.map(l => l.title), ['Gamma'])
  await c.doc('sync', { json: docJson('Only [[Beta]] now.'), expectedRevision: 1 })
  assert.deepEqual((await request('/api/documents/' + c.id)).data.links.out.map(l => l.title), ['Beta'])
  assert.deepEqual((await request('/api/documents/' + a.id)).data.links.in, [])
})

test('search ranks titles over bodies, highlights snippets, filters, and falls back to trigram titles', async t => {
  const { request, createDocument } = await startServer(t)
  const title = await createDocument({ title: 'Kubernetes upgrade plan', folder: '/ops', tags: ['k3s'] })
  const body = await createDocument({ title: 'Weekly notes', folder: '/notes' })
  await createDocument({ title: 'Recipes', folder: '/home' })
  await title.doc('sync', { json: docJson('Steps for the cluster.'), expectedRevision: 0 })
  await body.doc('sync', { json: docJson('We should schedule the Kubernetes upgrade after the storage migration finishes, because the nodes need a reboot.'), expectedRevision: 0 })
  const results = (await request('/api/search?q=kubernetes%20upgrade')).data.results
  assert.deepEqual(results.map(r => r.title), ['Kubernetes upgrade plan', 'Weekly notes'])
  assert.ok(results[0].rank > results[1].rank)
  assert.match(results[1].snippet, /<mark>Kubernetes<\/mark> <mark>upgrade<\/mark>/)
  assert.equal(results[0].match, 'text')
  assert.deepEqual((await request('/api/search?q=kubernetes&folder=/notes')).data.results.map(r => r.title), ['Weekly notes'])
  assert.deepEqual((await request('/api/search?q=kubernetes&tag=k3s')).data.results.map(r => r.title), ['Kubernetes upgrade plan'])
  assert.deepEqual((await request('/api/search?q=%22storage%20migration%22')).data.results.map(r => r.title), ['Weekly notes'], 'phrases work')
  assert.deepEqual((await request('/api/search?q=kubernetes%20-storage')).data.results.map(r => r.title), ['Kubernetes upgrade plan'], 'exclusions work')
  const fuzzy = (await request('/api/search?q=kubenetes%20upgrde%20plan')).data.results
  assert.equal(fuzzy[0]?.title, 'Kubernetes upgrade plan'); assert.equal(fuzzy[0].match, 'title')
  assert.deepEqual((await request('/api/search?q=')).data.results, [])
  assert.deepEqual((await request('/api/search?q=zzzz')).data.results, [])
})

test('agent tokens: minted once, listed by prefix, accepted by the API and MCP, revocable', async t => {
  const dev = await startServer(t)
  const minted = (await dev.request('/api/tokens', { name: 'Laptop' })).data
  assert.match(minted.token, /^ndp_[A-Za-z0-9_-]{40}$/)
  assert.equal(minted.prefix, minted.token.slice(0, 10))
  const listed = (await dev.request('/api/tokens')).data
  assert.deepEqual(listed.map(x => [x.id, x.name, x.prefix, x.lastUsedAt]), [[minted.id, 'Laptop', minted.prefix, null]])
  assert.equal(JSON.stringify(listed).includes(minted.token), false, 'the token is shown once')
  const { id: docId } = await dev.createDocument({ title: 'Shared' })

  // A second server on the same database and bucket without the dev user: only real credentials count.
  const strict = await startServer(t, { AUTH_DEV_USER: undefined, OIDC_ISSUER: 'https://auth.example/realms/x', OIDC_JWKS_URL: 'http://127.0.0.1:9/certs', OIDC_CLIENT_ID: 'notebook-duplex' }, { backend: dev.backend })
  const as = token => ({ Authorization: 'Bearer ' + token })
  assert.equal((await fetch(strict.url + '/api/library', { headers: as('ndp_' + 'x'.repeat(40)) })).status, 401)
  const me = await fetch(strict.url + '/api/me', { headers: as(minted.token) })
  assert.equal(me.status, 200)
  assert.deepEqual(await me.json().then(({ mcpUrl, ...rest }) => rest), { sub: 'dev:dev@example.com', email: 'dev@example.com', name: 'dev', via: 'token' })
  assert.equal((await (await fetch(strict.url + '/api/library', { headers: as(minted.token) })).json()).documents[0].id, docId)
  await until(async () => (await dev.request('/api/tokens')).data[0].lastUsedAt !== null)

  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(strict.url + '/mcp'), { requestInit: { headers: as(minted.token) } }))
  t.after(() => client.close())
  const identity = text(await client.callTool({ name: 'identify_session', arguments: { name: 'token-session' } }))
  assert.equal(identity.user, 'dev')
  const docs = text(await client.callTool({ name: 'list_documents', arguments: {} }))
  assert.equal(docs.documents[0].title, 'Shared')
  const sessions = (await (await fetch(strict.url + `/api/d/${docId}/state?lite=1`, { headers: as(minted.token) })).json()).sessions
  assert.equal(sessions[0].user, 'dev')

  assert.equal((await dev.request('/api/tokens/' + minted.id, undefined, 'DELETE')).status, 200)
  assert.deepEqual((await dev.request('/api/tokens')).data, [])
  assert.equal((await fetch(strict.url + '/api/me', { headers: as(minted.token) })).status, 401, 'revoked tokens stop working')
  assert.equal((await dev.request('/api/tokens/' + minted.id, undefined, 'DELETE')).status, 404)
})

test('legacy state.json is imported once as the first document', async t => {
  const legacy = { document: { id: '0f1e2d3c-4b5a-4968-8777-665544332211', revision: 7, json: docJson('Imported body text.', 'Second paragraph with [[Nothing]].'), markdown: '', title: 'Working notes' }, jobs: [], proposals: [{ id: 'x', type: 'comment', status: 'resolved' }], activity: {} }
  const { request, dataDir, output } = await startServer(t, {}, { seed: dir => writeFile(join(dir, 'state.json'), JSON.stringify(legacy)) })
  const library = (await request('/api/library')).data
  assert.deepEqual(library.documents.map(d => [d.id, d.title, d.folder, d.wordCount, d.revision]), [[legacy.document.id, 'Working notes', '/', 7, 7]])
  const state = (await request(`/api/d/${legacy.document.id}/state`)).data
  assert.equal(state.document.json.content[0].content[0].text, 'Imported body text.')
  assert.equal(state.proposals.length, 1)
  assert.match(output(), /imported legacy state\.json/)
  await assert.rejects(readFile(join(dataDir, 'state.json')), /ENOENT/)
  assert.ok(JSON.parse(await readFile(join(dataDir, 'state.imported.json'), 'utf8')).document.title === 'Working notes')
  assert.match((await request(`/api/documents/${legacy.document.id}/export.md`)).data, /^---\ntitle: Working notes\n/)
})

test('MCP document tools: list, search, read and create', async t => {
  const { url, apiKey, request, createDocument } = await startServer(t)
  const a = await createDocument({ title: 'Runbook', folder: '/ops', tags: ['k3s'], markdown: '# Runbook\n\nDrain the node before upgrading.' })
  await createDocument({ title: 'Diary', folder: '/personal' })
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + apiKey } } }))
  t.after(() => client.close())
  const names = (await client.listTools()).tools.map(x => x.name)
  for (const name of ['list_documents', 'search_documents', 'get_document', 'create_document', 'get_document_snapshot']) assert.ok(names.includes(name), name)

  const all = text(await client.callTool({ name: 'list_documents', arguments: {} }))
  assert.deepEqual(all.folders, ['/', '/ops', '/personal'])
  assert.deepEqual(all.documents.map(d => d.title), ['Runbook', 'Diary'])
  assert.deepEqual(text(await client.callTool({ name: 'list_documents', arguments: { folder: '/ops' } })).documents.map(d => d.title), ['Runbook'])
  const found = text(await client.callTool({ name: 'search_documents', arguments: { query: 'drain node' } }))
  assert.equal(found.results[0].id, a.id); assert.match(found.results[0].snippet, /<mark>Drain<\/mark>/)
  assert.deepEqual(text(await client.callTool({ name: 'search_documents', arguments: { query: 'drain', tag: 'nope' } })).results, [])
  const markdown = (await client.callTool({ name: 'get_document', arguments: { documentId: a.id } })).content[0].text
  assert.match(markdown, /^---\ntitle: Runbook\ntags:\n  - k3s\nfolder: \/ops\n/); assert.match(markdown, /# Runbook\n\nDrain the node before upgrading\./)
  assert.equal((await client.callTool({ name: 'get_document', arguments: { documentId: '00000000-0000-0000-0000-000000000000' } })).isError, true)

  const created = text(await client.callTool({ name: 'create_document', arguments: { title: 'Agent notes', folder: '/ops/agent', markdown: '---\ntags: [agent]\n---\n\nWritten by the agent. See [[Runbook]].' } }))
  assert.equal(created.folder, '/ops/agent'); assert.deepEqual(created.tags, ['agent']); assert.equal(created.title, 'Agent notes')
  const detail = (await request('/api/documents/' + created.id)).data
  assert.equal(detail.owner, 'dev:dev@example.com')
  assert.deepEqual(detail.links.out.map(l => l.title), ['Runbook'])
  assert.deepEqual((await request('/api/documents/' + a.id)).data.links.in.map(l => l.title), ['Agent notes'])
  const state = (await request(`/api/d/${created.id}/state`)).data
  assert.equal(state.document.json.content[0].content[0].text, 'Written by the agent. See [[Runbook]].')
  assert.ok((await request('/api/library')).data.documents.some(d => d.id === created.id), 'the writer sees it in the library')
})
