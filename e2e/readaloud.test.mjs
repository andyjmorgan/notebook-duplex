import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { startServer, until } from '../server/test-helpers.mjs'

const channel = z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string()) }) })
const shots = process.env.E2E_SHOTS

// A quarter second of silence: WAV, 24 kHz, mono, 16-bit, the shape Kokoro returns.
function silentWav(seconds = 0.5) {
  const data = Buffer.alloc(Math.round(24000 * seconds) * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
const DOC = `# Read me

First sentence here. Second sentence follows it. Dr. Who stays in one piece.

A paragraph with a [tk: skip this note] directive in it.

| Idea | Next step |
| --- | --- |
| Write freely | Let the agent work in the margin |
| Review deliberately | Accept only what helps |

![A tiny dot](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)

\`\`\`mermaid
flowchart LR
  A[Write] --> B[Review]
\`\`\`

Last words after the diagram.
`

test('read-aloud narrates with highlights, interlocks with the agent, and empties on edit', async t => {
  const { url, apiKey, request, createDocument } = await startServer(t, { STATIC_DIR: new URL('../dist/', import.meta.url).pathname })
  const first = await createDocument({ title: 'Working notes' })
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const shot = name => shots ? page.screenshot({ path: `${shots}/${name}.png` }) : Promise.resolve()
  const current = () => page.url().split('/d/')[1]
  const doc = (action, body) => request(`/api/d/${current()}/${action}`, body)
  const state = async () => (await doc('state')).data
  const spoken = [], described = []
  // Kokoro and the describe model are not part of the test; the real server answers everything else.
  await page.route('**/api/tts', async route => { spoken.push(route.request().postDataJSON().text); await route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }) })
  await page.route('**/api/describe', async route => { const d = route.request().postDataJSON(); described.push(d); await route.fulfill({ json: { text: d.kind === 'diagram' ? 'A chart or diagram showing a flow from writing to review.' : 'A code block.', source: 'llm' } }) })

  await page.goto(url + '/')
  await page.waitForSelector('.tiptap')
  await until(async () => (await page.textContent('.save-state')) === 'Saved')
  await page.setInputFiles('input[type=file]', { name: 'read.md', mimeType: 'text/markdown', buffer: Buffer.from(DOC) })
  await until(() => /\/d\/[0-9a-f-]{36}$/.test(page.url()) && !page.url().endsWith(first.id))
  await page.waitForSelector('.mermaid-preview svg', { timeout: 20000 })
  await until(async () => (await page.textContent('.save-state')) === 'Saved')
  const highlighted = () => page.evaluate(() => [...document.querySelectorAll('.tiptap .reading-now, .tiptap .reading-now-block')].map(e => e.tagName + ':' + e.textContent.trim().slice(0, 60)).join('|'))
  const position = () => page.textContent('.player-position')
  assert.equal(await position(), 'Read aloud')
  assert.equal(await page.locator('.outline-note').textContent(), (await page.locator('.outline-note').textContent()).replace('Saved as you type.', ''), 'the saved-as-you-type line is gone')

  // Play: the heading is highlighted first and the highlight advances sentence by sentence
  await page.click('.player-main')
  await until(async () => /^SPAN:Read me$/.test(await highlighted()))
  await shot('readaloud-heading')
  assert.equal(await position(), '1 / 11')
  await until(async () => /^SPAN:First sentence here\.$/.test(await highlighted()), 6000)
  assert.equal(await position(), '2 / 11')
  await until(async () => /^SPAN:Second sentence follows it\.$/.test(await highlighted()), 6000)
  await shot('readaloud-sentence')
  assert.equal(spoken[0], 'Read me', 'the first utterance is requested first')
  assert.equal(spoken[1], 'First sentence here.')
  assert.ok(spoken.length >= 4, 'audio is fetched ahead of playback: ' + JSON.stringify(spoken))

  // Pause holds the position; resume continues
  await page.click('.player-main')
  await until(async () => (await page.getAttribute('.player', 'class')).includes('paused'))
  const pausedAt = await position()
  await page.waitForTimeout(900)
  assert.equal(await position(), pausedAt)
  await page.click('.player-main')
  await until(async () => (await page.getAttribute('.player', 'class')).includes('playing'))

  // The table is announced as a block, then read row by row; the image and the diagram are highlighted as nodes
  await until(async () => /^DIV:/.test(await highlighted()), 8000)
  assert.equal(await position(), '6 / 11')
  await shot('readaloud-table')
  await until(async () => /^TR:/.test(await highlighted()), 4000)
  await until(async () => /^IMG:/.test(await highlighted()), 6000)
  await until(async () => /^DIV:/.test(await highlighted()), 4000)
  await shot('readaloud-diagram')
  await until(async () => (await position()) === 'Read aloud', 10000)
  assert.equal(await highlighted(), '', 'highlight clears when the script ends')
  assert.deepEqual(spoken.slice(0, 11), ['Read me', 'First sentence here.', 'Second sentence follows it.', 'Dr. Who stays in one piece.', 'A paragraph with a directive in it.', 'A table with 2 columns and 2 rows.', 'Idea: Write freely. Next step: Let the agent work in the margin.', 'Idea: Review deliberately. Next step: Accept only what helps.', 'An image of A tiny dot.', 'A chart or diagram showing a flow from writing to review.', 'Last words after the diagram.'])
  assert.equal(described[0].kind, 'diagram')
  assert.match(described[0].source, /A\[Write\]/)
  assert.equal(await page.locator('.rail-section.held').count(), 0)

  // Read from here: right-click the table and start at its intro
  await page.click('.tiptap table td >> nth=0', { button: 'right' })
  await page.waitForSelector('.context-menu')
  await page.click('.context-menu button:has-text("Read from here")')
  await until(async () => /^DIV:/.test(await highlighted()), 6000)
  assert.equal(await position(), '6 / 11')
  // Speed is playbackRate: switching never refetches audio already cached for this recording
  const fetchedBefore = spoken.length
  await page.selectOption('.player-speed', '1.5')
  await until(async () => /^TR:/.test(await highlighted()), 4000)
  assert.equal(spoken.length, fetchedBefore, 'speed change does not refetch')
  await page.click('.tiptap table td >> nth=0', { button: 'right' })
  await page.waitForSelector('.context-menu button:has-text("Stop reading")')
  await page.click('.context-menu button:has-text("Stop reading")')
  await until(async () => (await position()) === 'Read aloud')
  assert.equal(await highlighted(), '')

  // While reading, asks are held and sent when reading stops; review actions are blocked
  const notifications = []
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} })
  client.setNotificationHandler(channel, e => notifications.push(e.params))
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + apiKey } } }))
  t.after(() => client.close())
  await client.callTool({ name: 'identify_session', arguments: { name: 'reader-test', repo: '/tmp/reader' } })
  await until(async () => (await page.textContent('.connection')).includes('reader-test'))
  await page.click('.player-main')
  await until(async () => /^SPAN:Read me$/.test(await highlighted()))
  await page.click('.tiptap > p:nth-of-type(1)')
  await page.keyboard.press('Control+k')
  await page.waitForSelector('.command-bar')
  await page.keyboard.type('Tighten this while I listen.')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.command-bar', { state: 'detached' })
  await page.waitForSelector('.rail-section.held')
  assert.match(await page.textContent('.rail-section.held'), /1 request held until you stop reading/)
  await shot('readaloud-held')
  await page.waitForTimeout(300)
  assert.equal((await state()).jobs.length, 0, 'nothing reaches the server while reading')
  assert.equal(await page.locator('.rail .proofreading input').isDisabled(), true)
  assert.equal(await page.locator('.test-button').isDisabled(), true)
  await page.click('.rail .stop-reading')
  const heldEvent = await until(() => notifications.find(n => /Tighten this while I listen/.test(n.content)))
  assert.ok(heldEvent)
  await until(async () => (await page.locator('.rail-section.held').count()) === 0)

  // Claude active: controls are disabled with a reason, and come back when the job finishes
  const jobId = heldEvent.meta.job_id
  await until(async () => (await page.locator('.player-main').isDisabled()), 4000).catch(async () => { throw new Error('queued job should disable play; class=' + await page.getAttribute('.player', 'class') + ' jobs=' + JSON.stringify((await state()).jobs.map(j => j.status))) })
  assert.match(await page.getAttribute('.player-main', 'title'), /Claude is working/)
  await client.callTool({ name: 'claim_job', arguments: { jobId } })
  await page.waitForSelector('.tiptap .agent-active')
  assert.equal(await page.locator('.player-main').isDisabled(), true)
  await page.click('.tiptap > p:nth-of-type(1)', { button: 'right' })
  await page.waitForSelector('.context-menu')
  assert.equal(await page.locator('.context-menu button:has-text("Read from here")').isDisabled(), true)
  await page.keyboard.press('Escape')
  await shot('readaloud-disabled')
  await client.callTool({ name: 'report_job_status', arguments: { jobId, status: 'completed', message: 'done' } })
  await until(async () => !(await page.locator('.player-main').isDisabled()), 6000)

  // Any edit empties the recording: playback stops, highlight and position reset, next play rebuilds from scratch
  await page.click('.player-main')
  await until(async () => /^SPAN:Read me$/.test(await highlighted()))
  const fetchedBeforeEdit = spoken.length
  await page.click('.tiptap > p:nth-of-type(1)')
  await page.keyboard.press('End')
  await page.keyboard.type(' Edited.')
  await until(async () => (await highlighted()) === '')
  assert.equal(await position(), 'Read aloud')
  assert.ok((await page.getAttribute('.player', 'class')).includes('idle'))
  await until(async () => (await page.textContent('.save-state')) === 'Saved')
  // A document opened from the library seeds its existing [tk] notes as already fired (import creates a new document now),
  // so the imported note stays quiet and nothing locks the player.
  await page.waitForTimeout(600)
  assert.equal(notifications.some(n => /skip this note/.test(n.content)), false, 'imported directives do not fire on open')
  await until(async () => !(await page.locator('.player-main').isDisabled()), 6000)
  await page.click('.player-main')
  await until(async () => /^SPAN:Read me$/.test(await highlighted()))
  await until(async () => spoken.length > fetchedBeforeEdit, 4000)
  assert.equal(spoken[fetchedBeforeEdit], 'Read me', 'audio cache was dropped with the edit')
  await page.click('.player-stop')
  await until(async () => (await position()) === 'Read aloud')

  // Reading mode: playback and the context menu still work with the editor locked
  await page.click('.segmented button:has-text("Reading")')
  assert.equal(await page.getAttribute('.tiptap', 'contenteditable'), 'false')
  await page.click('.player-main')
  await until(async () => /^SPAN:Read me$/.test(await highlighted()))
  await shot('readaloud-reading-mode')
  await page.click('.tiptap > p:nth-of-type(1)', { button: 'right' })
  await page.waitForSelector('.context-menu button:has-text("Stop reading")')
  assert.equal(await page.locator('.context-menu button:has-text("Ask agent")').count(), 0, 'reading mode offers only reading and copy')
  await page.click('.context-menu button:has-text("Stop reading")')
  await until(async () => (await position()) === 'Read aloud')
  await page.click('.segmented button:has-text("Editing")')
  assert.deepEqual(errors, [])
})
