import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { startServer } from './test-helpers.mjs'

// Stand-ins for Kokoro and the describe model, so the tests never leave the machine.
async function mockUpstreams(t, { llmContent = 'a loop from writing to review' } = {}) {
  const calls = { tts: [], llm: [] }
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      const data = JSON.parse(body || '{}')
      if (req.url === '/v1/audio/speech') { calls.tts.push(data); res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(Buffer.from('RIFFfakewav')) }
      if (req.url === '/v1/chat/completions') { calls.llm.push(data); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: llmContent } }] })) }
      res.writeHead(404); res.end()
    })
  })
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok))
  t.after(() => srv.close())
  return { url: `http://127.0.0.1:${srv.address().port}`, calls }
}
// A port nothing listens on: bind, note the number, release it.
async function closedPort() { const srv = createServer(); await new Promise(ok => srv.listen(0, '127.0.0.1', ok)); const port = srv.address().port; await new Promise(ok => srv.close(ok)); return `http://127.0.0.1:${port}` }

test('tts proxies to Kokoro with the configured voice and returns the audio bytes', async t => {
  const mock = await mockUpstreams(t)
  const { url, headers } = await startServer(t, { KOKORO_URL: mock.url, KOKORO_FALLBACK_URL: '', KOKORO_VOICE: 'af_bella' })
  const res = await fetch(url + '/api/tts', { method: 'POST', headers, body: JSON.stringify({ text: ' Hello there. ', speed: 1.3 }) })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'audio/wav')
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'RIFFfakewav')
  assert.deepEqual(mock.calls.tts, [{ input: 'Hello there.', voice: 'af_bella', speed: 1.3, response_format: 'wav' }])
  const empty = await fetch(url + '/api/tts', { method: 'POST', headers, body: JSON.stringify({ text: '   ' }) })
  assert.equal(empty.status, 400)
  const fast = await fetch(url + '/api/tts', { method: 'POST', headers, body: JSON.stringify({ text: 'x', speed: 9 }) })
  assert.equal(fast.status, 200)
  assert.equal(mock.calls.tts.at(-1).speed, 2, 'speed is clamped')
})

test('tts falls back to the second Kokoro base when the first is unreachable', async t => {
  const mock = await mockUpstreams(t)
  const { url, headers } = await startServer(t, { KOKORO_URL: await closedPort(), KOKORO_FALLBACK_URL: mock.url })
  const res = await fetch(url + '/api/tts', { method: 'POST', headers, body: JSON.stringify({ text: 'Fallback please.' }) })
  assert.equal(res.status, 200)
  assert.equal(mock.calls.tts.length, 1)
  const again = await fetch(url + '/api/tts', { method: 'POST', headers, body: JSON.stringify({ text: 'Again.' }) })
  assert.equal(again.status, 200)
  assert.equal(mock.calls.tts.length, 2)
})

test('tts reports an error when no Kokoro is reachable', async t => {
  const { url, headers } = await startServer(t, { KOKORO_URL: await closedPort(), KOKORO_FALLBACK_URL: '' })
  const res = await fetch(url + '/api/tts', { method: 'POST', headers, body: JSON.stringify({ text: 'Nobody home.' }) })
  assert.equal(res.status, 502)
  assert.match((await res.json()).error, /unreachable/)
})

test('describe composes the spoken intro with the model answer and caches by content', async t => {
  const mock = await mockUpstreams(t, { llmContent: '**a loop** from writing to review.\n\nFeedback returns to the start.' })
  const { request } = await startServer(t, { DESCRIBE_LLM_URL: mock.url, DESCRIBE_LLM_MODEL: 'test-model' })
  const source = 'flowchart LR\n  A[Write] --> B[Review]\n  B --> A'
  const first = await request('/api/describe', { kind: 'diagram', source })
  assert.equal(first.data.text, 'A chart or diagram showing a loop from writing to review. Feedback returns to the start.')
  assert.equal(first.data.source, 'llm')
  assert.equal(mock.calls.llm[0].model, 'test-model')
  assert.match(mock.calls.llm[0].messages[1].content, /A\[Write\]/)
  const second = await request('/api/describe', { kind: 'diagram', source })
  assert.equal(second.data.cached, true)
  assert.equal(mock.calls.llm.length, 1, 'same source is served from the cache')
  const code = await request('/api/describe', { kind: 'code', language: 'python', source: 'print(1)' })
  assert.equal(code.data.text, 'A Python code block. A loop from writing to review. Feedback returns to the start.')
  assert.equal(mock.calls.llm.length, 2)
})

test('describe falls back to a deterministic description when the model is unreachable', async t => {
  const { request } = await startServer(t, { DESCRIBE_LLM_URL: await closedPort() })
  const diagram = await request('/api/describe', { kind: 'diagram', source: 'flowchart TD\n  A --> B\n  B --> C\n  C --> D' })
  assert.deepEqual(diagram.data, { text: 'A chart or diagram showing a flowchart with 4 nodes: A, B, C, D.', source: 'fallback' })
  const code = await request('/api/describe', { kind: 'code', language: 'bash', source: 'ls\npwd' })
  assert.equal(code.data.text, 'A shell code block with 2 lines.')
  const empty = await request('/api/describe', { kind: 'diagram', source: '' })
  assert.equal(empty.data.text, 'An empty diagram.')
})
