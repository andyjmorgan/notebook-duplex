import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from './store.mjs'
const doc = () => ({ type: 'doc', content: [
  { type: 'paragraph', attrs: { id: 'a' }, content: [{ type: 'text', text: 'Original' }] },
  { type: 'bulletList', attrs: { id: 'list' }, content: [{ type: 'listItem', attrs: { id: 'li' }, content: [{ type: 'paragraph', attrs: { id: 'nested' }, content: [{ type: 'text', text: 'Nested' }] }] }] },
  { type: 'paragraph', attrs: { id: 'b' }, content: [{ type: 'text', text: 'Other' }] },
] })
function setup() {
  const store = new Store()
  store.sync({ json: doc(), markdown: 'Original\n\nOther', title: 'Test', expectedRevision: 0 })
  const job = store.enqueue({ instruction: 'Improve paragraph', sessionId: 's', blockIds: ['a'] })
  store.claim(job.id, 's')
  const block = job.snapshot.blocks[0]
  const proposal = store.propose({ jobId: job.id, blockId: 'a', blockRevision: block.revision, before: 'Original', after: 'Improved', explanation: 'Clearer' }, 's')
  return { store, job, proposal }
}
test('accept preserves unrelated writing', () => {
  const { store, proposal } = setup()
  const next = doc(); next.content[2].content[0].text = 'User keeps typing'
  store.sync({ json: next, expectedRevision: 1 })
  const result = store.review(proposal.id, 'accept')
  assert.equal(result.document.json.content[0].content[0].text, 'Improved')
  assert.equal(result.document.json.content[2].content[0].text, 'User keeps typing')
})
test('writer can edit the proposed text before accepting', () => {
  const { store, proposal } = setup()
  store.review(proposal.id, 'accept', { text: 'Improved by the writer' })
  assert.equal(store.snapshot().blocks[0].text, 'Improved by the writer')
  assert.equal(proposal.finalText, 'Improved by the writer')
})
test('changed target is stale and never overwritten', () => {
  const { store, proposal } = setup()
  const next = doc(); next.content[0].content[0].text = 'Writer rewrite'
  store.sync({ json: next, expectedRevision: 1 })
  assert.equal(store.view().proposals[0].stale, true)
  assert.equal(store.review(proposal.id, 'accept').stale, true)
  assert.equal(store.snapshot().blocks[0].text, 'Writer rewrite')
})
test('deleted target is stale', () => {
  const { store, proposal } = setup(); const next = doc(); next.content.shift()
  store.sync({ json: next, expectedRevision: 1 })
  assert.equal(store.review(proposal.id, 'accept').stale, true)
})
test('scope and session ownership are enforced', () => {
  const { store, job } = setup()
  assert.throws(() => store.claim(job.id, 'other'))
  const b = job.snapshot.blocks.find(x => x.id === 'b')
  assert.throws(() => store.propose({ jobId: job.id, blockId: b.id, blockRevision: b.revision, before: b.text, after: 'Wrong' }, 's'))
})
test('cancel invalidates proposals, activity and late results', () => {
  const { store, job, proposal } = setup()
  store.activity(job.id, 's', { state: 'writing', progress: 10 })
  store.cancel(job.id)
  assert.throws(() => store.review(proposal.id, 'accept'))
  assert.throws(() => store.propose({ jobId: job.id }, 's'))
  assert.equal(proposal.status, 'cancelled')
  assert.deepEqual(store.view().activity, [])
})
test('reject leaves canonical text intact', () => {
  const { store, proposal } = setup(); store.review(proposal.id, 'reject')
  assert.equal(store.snapshot().blocks[0].text, 'Original')
})
test('duplicate acceptance cannot apply twice', () => {
  const { store, proposal } = setup(); store.review(proposal.id, 'accept')
  assert.throws(() => store.review(proposal.id, 'accept'))
})
test('formatting change invalidates proposal even if text is unchanged', () => {
  const { store, proposal } = setup(); const next = doc(); next.content[0].content[0].marks = [{ type: 'bold' }]
  store.sync({ json: next, expectedRevision: 1 })
  assert.equal(store.review(proposal.id, 'accept').stale, true)
})
test('reconsider queues a follow-up job carrying the note', () => {
  const { store, job, proposal } = setup()
  assert.throws(() => store.review(proposal.id, 'reconsider', { feedback: '  ' }))
  const result = store.review(proposal.id, 'reconsider', { feedback: 'Too formal' })
  assert.equal(proposal.status, 'reconsidered')
  assert.equal(result.job.sessionId, 's')
  assert.deepEqual(result.job.blockIds, ['a'])
  assert.equal(result.job.context.reconsiders, proposal.id)
  assert.match(result.job.instruction, /Too formal/)
  assert.equal(store.claim(result.job.id, 's').context.previous.after, 'Improved')
  assert.notEqual(result.job.id, job.id)
})
test('insert proposals anchor to top-level blocks and accept parsed nodes with fresh ids', () => {
  const store = new Store()
  store.sync({ json: doc(), expectedRevision: 0 })
  const job = store.enqueue({ instruction: 'Add a summary', sessionId: 's', blockIds: [] })
  store.claim(job.id, 's')
  const proposal = store.propose({ jobId: job.id, type: 'insert', anchorBlockId: 'nested', placement: 'after', markdown: 'Summary', explanation: 'Adds context' }, 's')
  assert.equal(proposal.anchorBlockId, 'list', 'nested anchors resolve to their top-level block')
  const result = store.review(proposal.id, 'accept', { nodes: [{ type: 'paragraph', attrs: { id: 'a' }, content: [{ type: 'text', text: 'Summary' }] }, { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'H' }] }] })
  const content = result.document.json.content
  assert.equal(content.length, 5)
  assert.equal(content[2].content[0].text, 'Summary')
  assert.notEqual(content[2].attrs.id, 'a', 'colliding ids are replaced')
  assert.ok(content[3].attrs.id)
  assert.deepEqual(proposal.insertedIds, [content[2].attrs.id, content[3].attrs.id])
})
test('insert proposals go stale when the anchor disappears', () => {
  const store = new Store()
  store.sync({ json: doc(), expectedRevision: 0 })
  const job = store.enqueue({ instruction: 'Add', sessionId: 's', blockIds: [] }); store.claim(job.id, 's')
  const proposal = store.propose({ jobId: job.id, type: 'insert', anchorBlockId: 'b', markdown: 'X', explanation: '' }, 's')
  const next = doc(); next.content.pop()
  store.sync({ json: next, expectedRevision: 1 })
  assert.equal(store.review(proposal.id, 'accept', { nodes: [{ type: 'paragraph' }] }).stale, true)
})
test('activity is scoped to snapshot blocks and clamps progress', () => {
  const { store, job } = setup()
  const activity = store.activity(job.id, 's', { blockIds: ['a', 'missing'], state: 'thinking', progress: 140, message: 'x'.repeat(300) })
  assert.deepEqual(activity.blockIds, ['a'])
  assert.equal(activity.progress, 100)
  assert.equal(activity.message.length, 200)
  assert.throws(() => store.activity(job.id, 's', { state: 'dancing' }))
})
test('changed proofreading targets supersede jobs and reject late proposals', () => {
  const store = new Store()
  store.sync({ json: doc(), expectedRevision: 0 })
  const job = store.enqueue({ instruction: 'Proofread', sessionId: 's', blockIds: ['a'], kind: 'proofread' })
  store.claim(job.id, 's')
  const next = doc(); next.content[0].content[0].text = 'New draft'
  store.sync({ json: next, expectedRevision: 1 })
  assert.equal(job.status, 'superseded')
  const block = job.snapshot.blocks[0]
  assert.throws(() => store.propose({ jobId: job.id, blockId: block.id, blockRevision: block.revision, before: block.text, after: 'Old result' }, 's'))
})
test('job snapshots remain immutable through accepted edits', () => {
  const { store, job, proposal } = setup()
  store.review(proposal.id, 'accept')
  assert.equal(job.snapshot.blocks[0].text, 'Original')
  assert.equal(job.snapshot.json.content[0].content[0].text, 'Original')
})
