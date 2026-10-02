import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { startServer, until } from '../server/test-helpers.mjs'

const channel = z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string()) }) })
const shots = process.env.E2E_SHOTS

test('writer and agent collaborate end to end in the browser', async t => {
  const { url, apiKey, request, output } = await startServer(t, { STATIC_DIR: new URL('../dist/', import.meta.url).pathname })
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const shot = name => shots ? page.screenshot({ path: `${shots}/${name}.png` }) : Promise.resolve()

  await page.goto(url + '/')
  await page.fill('input[aria-label="Notebook key"]', 'wrong')
  await page.click('button[type=submit]')
  await page.waitForSelector('.gate-error')
  await page.fill('input[aria-label="Notebook key"]', apiKey)
  await page.click('button[type=submit]')
  await page.waitForSelector('.tiptap')
  await page.evaluate(() => { const w = window; w.__toasts = []; new MutationObserver(() => { const t = document.getElementById('toast')?.textContent; if (t) w.__toasts.push(t) }).observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true }) })
  const toasts = () => page.evaluate(() => window.__toasts)
  await until(async () => (await page.textContent('.save-state')) === 'Saved')
  const initial = (await request('/api/state')).data
  const paragraphs = initial.document.json.content.filter(n => n.type === 'paragraph')
  assert.ok(paragraphs.every(n => n.attrs.id), 'paragraphs carry stable IDs')
  assert.equal(new Set(paragraphs.map(n => n.attrs.id)).size, paragraphs.length)
  assert.equal(await page.locator('#toc button').count(), 3)

  // Local fixture: replace + insert proposals rendered inline
  await page.click('.tiptap > p:nth-of-type(2)')
  await page.click('button.test-button')
  await page.waitForSelector('.suggestion.replace')
  await page.waitForSelector('.suggestion.insert')
  assert.ok((await page.locator('.suggestion.replace ins').textContent()).includes('local test suggestion'))
  await shot('inline-suggestions')

  // Edit the insert text, then accept it: content lands after the anchor with new IDs
  assert.ok((await page.locator('.suggestion.insert .markdown-preview blockquote').count()) === 1, 'insert cards open on a rendered preview')
  await page.click('.suggestion.insert .view-tabs button:has-text("Edit")')
  await page.fill('.suggestion.insert textarea', '> Edited by the writer.\n\n- one\n- two')
  await page.click('.suggestion.insert button:has-text("Accept edited")')
  await until(async () => (await page.locator('.tiptap blockquote').count()) === 1)
  assert.equal(await page.locator('.tiptap blockquote').textContent(), 'Edited by the writer.')
  assert.equal(await page.locator('.tiptap ul li').count(), 2)

  // Typing elsewhere keeps the replace suggestion alive; editing its target makes it stale
  await page.click('.tiptap > p:nth-of-type(1)')
  await page.keyboard.press('End')
  await page.keyboard.type(' Still here.')
  await until(async () => (await page.textContent('.save-state')) === 'Saved')
  assert.equal(await page.locator('.suggestion.replace:not(.stale)').count(), 1)
  await page.click('.tiptap > p:nth-of-type(2)')
  await page.keyboard.press('End')
  await page.keyboard.type(' Changed.')
  await page.waitForSelector('.suggestion.stale', { timeout: 8000 })
  await shot('stale')
  await page.click('.suggestion.stale button:has-text("Dismiss")')
  await until(async () => (await page.locator('.suggestion').count()) === 0)

  // A remote Claude session connects over MCP
  const notifications = []
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} })
  client.setNotificationHandler(channel, e => notifications.push(e.params))
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + apiKey } } }))
  t.after(() => client.close())
  await client.callTool({ name: 'identify_session', arguments: { name: 'notebook-duplex', repo: '/home/writer/notebook-duplex' } })
  await until(async () => (await page.textContent('.connection')).includes('notebook-duplex'))

  // Writer asks from the keyboard without leaving the paragraph
  await page.click('.tiptap > p:nth-of-type(1)')
  await page.keyboard.press('Control+k')
  await page.waitForSelector('.command-bar')
  await page.keyboard.type('Make this sharper.')
  await shot('command-bar')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.command-bar', { state: 'detached' })
  const event = await until(() => notifications.find(n => /sharper/.test(n.content)))
  const jobId = event.meta.job_id
  await page.waitForSelector('.tiptap .agent-queued')

  // Agent claims, reports progress in the margin, proposes
  const claim = JSON.parse((await client.callTool({ name: 'claim_job', arguments: { jobId } })).content[0].text)
  const block = claim.snapshot.blocks.find(b => b.id === claim.blockIds[0])
  await client.callTool({ name: 'set_block_status', arguments: { jobId, state: 'writing', progress: 45, message: 'Tightening the sentence' } })
  await page.waitForSelector('.tiptap .agent-active')
  await until(async () => (await page.getAttribute('.tiptap .agent-active', 'data-agent')).includes('45%'))
  assert.ok((await page.textContent('.rail')).includes('Tightening the sentence'))
  await shot('agent-working')
  const after = 'Write beside your Claude session.'
  const proposal = JSON.parse((await client.callTool({ name: 'propose_changes', arguments: { jobId, type: 'replace', blockId: block.id, blockRevision: block.revision, before: block.text, after, explanation: 'Shorter and active.' } })).content[0].text)
  await client.callTool({ name: 'report_job_status', arguments: { jobId, status: 'completed', message: 'One suggestion.' } })
  await page.waitForSelector('.suggestion.replace')
  await page.waitForSelector('.tiptap .agent-active', { state: 'detached' })
  await shot('agent-suggestion')
  assert.equal(await page.locator('.suggestion.replace del').count() > 0, true, 'removed words are struck out: ' + await page.locator('.suggestion.replace').first().innerHTML())

  // Reconsider sends a follow-up job with the note
  await page.click('.suggestion.replace button:has-text("Reconsider")')
  await page.fill('.reconsider textarea', 'Keep the word session but mention flow.')
  await page.keyboard.press('Enter')
  const followUp = await until(() => notifications.find(n => n.meta.job_id !== jobId && /reconsider/i.test(n.content)))
  const followClaim = JSON.parse((await client.callTool({ name: 'claim_job', arguments: { jobId: followUp.meta.job_id } })).content[0].text)
  assert.match(followClaim.context.feedback, /mention flow/)
  const revised = JSON.parse((await client.callTool({ name: 'propose_changes', arguments: { jobId: followUp.meta.job_id, type: 'replace', blockId: block.id, blockRevision: block.revision, before: block.text, after: 'Write in flow, with your Claude session beside you.', explanation: 'Mentions flow.' } })).content[0].text)
  await page.waitForSelector(`.suggestion-host[data-proposal="${revised.id}"] .suggestion`, { timeout: 8000 }).catch(async e => {
    await shot('revised-missing')
    const hosts = await page.evaluate(() => [...document.querySelectorAll('.suggestion-host')].map(h => h.dataset.proposal + ':' + h.children.length))
    throw new Error(`${e.message}\nrevised=${JSON.stringify(revised)}\nhosts=${JSON.stringify(hosts)}\nserver=${output().slice(-3000)}`)
  })

  // Accept from the keyboard with the caret in the paragraph; undo restores it
  await page.click('.tiptap > p:nth-of-type(1)')
  await page.keyboard.press('Control+Enter')
  await until(async () => (await page.locator('.tiptap > p:nth-of-type(1)').textContent()) === 'Write in flow, with your Claude session beside you.').catch(async e => {
    await shot('accept-missing')
    throw new Error(`${e.message}\ntoasts=${JSON.stringify(await toasts())}\npara1=${await page.locator('.tiptap > p:nth-of-type(1)').textContent()}\nproposals=${JSON.stringify((await request('/api/state')).data.proposals.map(p => [p.id.slice(0, 8), p.type, p.status, p.stale, p.blockId?.slice(0, 8)]))}\nserver=${output().slice(-800)}`)
  })
  await until(async () => (await page.locator('.suggestion').count()) === 0)
  await until(async () => (await page.textContent('.save-state')) === 'Saved')
  assert.equal((await request('/api/state')).data.document.json.content[0].content[0].text, 'Write in flow, with your Claude session beside you.')
  await page.keyboard.press('Control+z')
  await until(async () => (await page.locator('.tiptap > p:nth-of-type(1)').textContent()).startsWith('Write with your Claude session'))

  // Formatted paragraphs are replaceable as inline Markdown, and an empty replacement removes a block
  await page.click('.tiptap > p:nth-of-type(1)', { clickCount: 3 })
  await page.click('.toolbar [data-action="bold"]')
  await until(async () => (await page.locator('.tiptap > p:nth-of-type(1) strong').count()) === 1)
  await until(async () => (await page.textContent('.save-state')) === 'Saved')
  const fmtState = (await request('/api/state')).data
  const fmtId = fmtState.document.json.content[0].attrs.id
  const { data: fmtJob } = await request('/api/jobs', { instruction: 'Better word', blockIds: [fmtId], sessionId: (await request('/api/state')).data.sessions[0].id })
  const fmtClaim = JSON.parse((await client.callTool({ name: 'claim_job', arguments: { jobId: fmtJob.id } })).content[0].text)
  const fmtBlock = fmtClaim.snapshot.blocks.find(b => b.id === fmtId)
  assert.match(fmtBlock.text, /^\*\*.*\*\*$/, 'bold paragraph is presented as inline markdown')
  const fmtProposal = JSON.parse((await client.callTool({ name: 'propose_changes', arguments: { jobId: fmtJob.id, type: 'replace', blockId: fmtId, blockRevision: fmtBlock.revision, before: fmtBlock.text, after: '**Write beside** your *Claude* session.', explanation: 'keeps the bold' } })).content[0].text)
  assert.ok(!fmtProposal.error && fmtProposal.id, 'formatted blocks are accepted as replace targets: ' + JSON.stringify(fmtProposal))
  await page.click(`.suggestion-host[data-proposal="${fmtProposal.id}"] button:has-text("Accept")`)
  await until(async () => (await page.locator('.tiptap > p:nth-of-type(1)').textContent()) === 'Write beside your Claude session.')
  assert.equal(await page.locator('.tiptap > p:nth-of-type(1) strong').textContent(), 'Write beside')
  assert.equal(await page.locator('.tiptap > p:nth-of-type(1) em').textContent(), 'Claude')
  const delTarget = (await request('/api/state')).data.document.json.content.filter(n => n.type === 'paragraph').at(-1)
  const { data: delJob } = await request('/api/jobs', { instruction: 'Remove duplicate', blockIds: [delTarget.attrs.id], sessionId: (await request('/api/state')).data.sessions[0].id })
  const delClaim = JSON.parse((await client.callTool({ name: 'claim_job', arguments: { jobId: delJob.id } })).content[0].text)
  const delBlock = delClaim.snapshot.blocks.find(b => b.id === delTarget.attrs.id)
  const delProposal = JSON.parse((await client.callTool({ name: 'propose_changes', arguments: { jobId: delJob.id, type: 'replace', blockId: delBlock.id, blockRevision: delBlock.revision, before: delBlock.text, after: '', explanation: 'redundant' } })).content[0].text)
  await page.waitForSelector(`.suggestion-host[data-proposal="${delProposal.id}"] .suggestion.removal`)
  await page.click(`.suggestion-host[data-proposal="${delProposal.id}"] button:has-text("Remove")`)
  await until(async () => !(await page.locator('.tiptap').textContent()).includes('[tk: Find a primary source'))
  await until(async () => (await page.textContent('.save-state')) === 'Saved')
  assert.equal((await request('/api/state')).data.document.json.content.some(n => n.attrs?.id === delTarget.attrs.id), false)

  // Comments: the agent responds in place without editing; the writer replies and the thread continues
  const cmtTarget = (await request('/api/state')).data.document.json.content.find(n => n.type === 'paragraph')
  const { data: cmtJob } = await request('/api/jobs', { instruction: 'Is this true?', blockIds: [cmtTarget.attrs.id], sessionId: (await request('/api/state')).data.sessions[0].id })
  await client.callTool({ name: 'claim_job', arguments: { jobId: cmtJob.id } })
  const cmt = JSON.parse((await client.callTool({ name: 'propose_changes', arguments: { jobId: cmtJob.id, type: 'comment', blockId: cmtTarget.attrs.id, text: 'Mostly. See **Kleppmann 2019** for the nuance.' } })).content[0].text)
  await page.waitForSelector(`.suggestion-host[data-proposal="${cmt.id}"] .suggestion.comment`)
  assert.equal(await page.locator(`.suggestion-host[data-proposal="${cmt.id}"] strong`).textContent(), 'Kleppmann 2019', 'comments render Markdown')
  await shot('comment')
  await page.click(`.suggestion-host[data-proposal="${cmt.id}"] button:has-text("Reply")`)
  await page.fill(`.suggestion-host[data-proposal="${cmt.id}"] textarea`, 'Add it as a footnote then.')
  await page.keyboard.press('Enter')
  const replyEvent = await until(() => notifications.find(n => n.meta.job_id !== cmtJob.id && /footnote/.test(n.content)))
  assert.match(replyEvent.content, /replied to one of your comments/)
  await until(async () => (await page.locator(`.suggestion-host[data-proposal="${cmt.id}"]`).count()) === 0)

  // Slash menu inserts a table; reading mode locks the editor
  assert.match(await page.locator('.tiptap > p:nth-of-type(1)').textContent(), /^Write beside your Claude session\./, 'earlier flows left the first paragraph intact')
  await page.click('.tiptap > p:nth-of-type(3)')
  await page.waitForTimeout(80)
  await page.keyboard.press('Control+End'); await page.waitForTimeout(80)
  await page.keyboard.press('Enter'); await page.waitForTimeout(80)
  await page.keyboard.type('/tab')
  await page.waitForSelector('#slash-menu [data-slash="table"]', { timeout: 8000 }).catch(async e => {
    throw new Error(e.message + '\nactive=' + await page.evaluate(() => document.activeElement?.className) + '\neditable=' + await page.getAttribute('.tiptap', 'contenteditable') + '\nparas=' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.tiptap > p')].map(p => p.textContent.slice(0, 30)))) + '\ntoasts=' + JSON.stringify(await toasts()))
  })
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('.tiptap table').count(), 2)
  await page.click('.segmented button:has-text("Reading")')
  assert.equal(await page.getAttribute('.tiptap', 'contenteditable'), 'false')
  await page.click('.segmented button:has-text("Editing")')
  assert.equal(await page.getAttribute('.tiptap', 'contenteditable'), 'true')

  // Inline [tk: …] directive fires on the closing bracket and shows its state in place
  await page.click('.tiptap > p:nth-of-type(2)')
  await page.keyboard.press('End')
  await page.keyboard.type(' [tk: cite a source')
  await page.waitForSelector('.tiptap .tk-chip.open')
  await page.keyboard.type(']')
  const tkEvent = await until(() => notifications.find(n => /cite a source/.test(n.content)))
  assert.match(tkEvent.content, /\[tk: cite a source\] note/)
  await page.waitForSelector('.tiptap .tk-chip.complete.tk-queued')
  await client.callTool({ name: 'claim_job', arguments: { jobId: tkEvent.meta.job_id } })
  await page.waitForSelector('.tiptap .tk-chip.tk-working')
  await shot('tk-chip')
  await page.keyboard.type(' and I keep writing.')
  assert.match(tkEvent.content, /insert after it/)
  const tkClaim = JSON.parse((await client.callTool({ name: 'claim_job', arguments: { jobId: tkEvent.meta.job_id } })).content[0].text)
  const tkInsert = JSON.parse((await client.callTool({ name: 'propose_changes', arguments: { jobId: tkClaim.id, type: 'insert', anchorBlockId: tkClaim.blockIds[0], placement: 'after', markdown: 'Source: Kleppmann et al., *Local-first software* (2019).', explanation: 'Cited.' } })).content[0].text)
  await client.callTool({ name: 'report_job_status', arguments: { jobId: tkEvent.meta.job_id, status: 'completed', message: 'ok' } })
  await page.waitForSelector('.tiptap .tk-chip.tk-done')
  await page.click(`.suggestion-host[data-proposal="${tkInsert.id}"] button:has-text("Accept")`)
  await until(async () => (await page.locator('.tiptap > p:nth-of-type(3)').textContent()).startsWith('Source: Kleppmann'))
  assert.ok(!(await page.locator('.tiptap > p:nth-of-type(2)').textContent()).includes('[tk:'), 'accepting removes the directive chip')
  assert.ok((await page.locator('.tiptap > p:nth-of-type(2)').textContent()).includes('and I keep writing.'), 'the writer\'s continued typing survives')

  // Right-click menu: ask about the highlighted text, and proofread a whole table from one cell
  await page.click('.tiptap > p:nth-of-type(1)')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.click('.tiptap > p:nth-of-type(1)', { button: 'right' })
  await page.waitForSelector('.context-menu')
  await page.waitForTimeout(200)
  await shot('context-menu')
  await page.click('.context-menu button:has-text("Ask agent about this")')
  await page.waitForSelector('.command-bar .command-selection')
  await page.keyboard.type('Is this claim true?')
  await page.keyboard.press('Enter')
  const askEvent = await until(() => notifications.find(n => /Is this claim true/.test(n.content)))
  assert.match(askEvent.content, /highlighted this text/)
  await page.click('.tiptap table >> nth=0 >> td >> nth=0', { button: 'right' })
  await page.waitForSelector('.context-menu')
  await page.click('.context-menu button:has-text("Proofread this")')
  const tableEvent = await until(() => notifications.find(n => /Proofread this table/.test(n.content)))
  assert.match(tableEvent.content, /whole table/)
  const tableJob = (await request('/api/state')).data.jobs.find(j => j.id === tableEvent.meta.job_id)
  assert.ok(tableJob.blockIds.length >= 5, 'table proofreading covers the table and every cell in one job')
  const tableClaim = JSON.parse((await client.callTool({ name: 'claim_job', arguments: { jobId: tableEvent.meta.job_id } })).content[0].text)
  await page.waitForSelector('.tiptap .tableWrapper.agent-active')
  await shot('table-working')
  // The agent rewrites the whole table as Markdown; the writer sees a cell diff and accepts from inside a cell
  const tableBlock = tableClaim.snapshot.blocks.find(b => b.type === 'table' && b.id === tableJob.blockIds[0])
  assert.ok(tableBlock && /^\| Idea \| Next step \|/.test(tableBlock.text), 'table block: ' + JSON.stringify({ ids: tableJob.blockIds.slice(0, 3), tables: tableClaim.snapshot.blocks.filter(b => b.type === 'table').map(b => [b.id, b.text.slice(0, 60)]) }))
  const newTable = tableBlock.text.replace('Write freely', 'Write without stopping') + '\n| Ship | Celebrate |'
  const tableProposal = JSON.parse((await client.callTool({ name: 'propose_changes', arguments: { jobId: tableClaim.id, type: 'replace', blockId: tableBlock.id, blockRevision: tableBlock.revision, before: tableBlock.text, after: newTable, explanation: 'Stronger verb, one more row.' } })).content[0].text)
  assert.equal(tableProposal.blockType, 'table')
  await page.waitForSelector('.suggestion .table-diff')
  assert.equal(await page.locator('.table-diff .row-ins').count(), 1)
  assert.ok((await page.locator('.table-diff .cell-changed').count()) >= 1)
  await page.evaluate(() => document.querySelector('.suggestion .table-diff')?.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  await shot('table-diff')
  await page.click('.tiptap table >> nth=0 >> td >> nth=0')
  await page.keyboard.press('Control+Enter')
  await until(async () => (await page.locator('.tiptap table >> nth=0 >> tr').count()) === 4)
  assert.ok((await page.locator('.tiptap table >> nth=0').textContent()).includes('Write without stopping'))
  await client.callTool({ name: 'report_job_status', arguments: { jobId: tableClaim.id, status: 'completed', message: 'done' } })

  // Off-screen marker: with a suggestion far below the viewport, a pill appears at the bottom
  await page.setViewportSize({ width: 1440, height: 560 })
  await page.evaluate(() => window.scrollTo(0, 0))
  const lastId = (await request('/api/state')).data.document.json.content.filter(n => n.type === 'paragraph' && n.content?.length).at(-1).attrs.id
  await request('/api/demo', { blockId: lastId })
  await page.waitForSelector('.offscreen-bottom .offscreen-pill')
  await shot('offscreen-pill')
  await page.click('.offscreen-bottom .offscreen-pill')
  await until(async () => (await page.locator('.offscreen-bottom .offscreen-pill').count()) === 0)
  await page.setViewportSize({ width: 1440, height: 940 })

  // Images parse from Markdown
  await page.evaluate(() => { const w = window; w.confirm = () => true })
  await page.setInputFiles('input[type=file]', { name: 'img.md', mimeType: 'text/markdown', buffer: Buffer.from('# Pictures\n\n![A dot](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)\n\nAfter the image.\n') })
  await page.waitForSelector('.tiptap img:not(.ProseMirror-separator)')
  assert.equal(await page.getAttribute('.tiptap img:not(.ProseMirror-separator)', 'alt'), 'A dot')

  // Pasting Markdown that contains an image renders the image
  await page.click('.tiptap > p:nth-of-type(1)'); await page.waitForTimeout(80); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter')
  await page.evaluate(text => { const dt = new DataTransfer(); dt.setData('text/plain', text); document.querySelector('.tiptap').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) }, '![Pasted logo](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)')
  await until(async () => (await page.locator('.tiptap img[alt="Pasted logo"]').count()) === 1)

  // Mermaid fences render as diagrams
  await page.setInputFiles('input[type=file]', { name: 'diagram.md', mimeType: 'text/markdown', buffer: Buffer.from('# Flow\n\n```mermaid\nflowchart LR\n  A[Write] --> B[Review]\n```\n') })
  await page.waitForSelector('.mermaid-preview svg', { timeout: 20000 })
  assert.ok((await page.locator('.mermaid-preview svg').innerHTML()).includes('Review'))
  assert.equal(await page.locator('.mermaid-block .code-block-source').isHidden(), true, 'diagram tab hides the source')
  await page.click('.code-tabs button:has-text("Source")')
  await page.waitForSelector('.mermaid-block .code-block-source:not([hidden])')
  const selAfterTab = await page.evaluate(() => { const s = window.getSelection(); return `${s?.anchorNode?.nodeName}:${(s?.anchorNode?.textContent ?? '').slice(0, 20)}@${s?.anchorOffset} active=${document.activeElement?.className?.slice(0, 14)}` })
  await page.keyboard.type('\n  B --> C[Ship]')
  const sourceText = await page.locator('.mermaid-block .code-block-source').textContent()
  assert.match(sourceText, /Review\]\s*B --> C\[Ship\]/, `typing continues at the end of the source; sel=${selAfterTab} text=${JSON.stringify(sourceText)} body=${JSON.stringify((await page.locator('.tiptap').textContent()).slice(0, 200))}`)
  await page.click('.tiptap > h1')
  await page.waitForSelector('.mermaid-block.showing-diagram', { timeout: 8000 }).catch(async e => { throw new Error(e.message + ' class=' + await page.evaluate(() => document.querySelector('.mermaid-block')?.className)) })
  await until(async () => (await page.locator('.mermaid-preview svg').innerHTML()).includes('Ship'), 20000)
  await shot('mermaid')
  assert.deepEqual(errors, [])
})
