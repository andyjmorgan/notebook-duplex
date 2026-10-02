import { randomUUID, createHash } from 'node:crypto'

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const TEXT_BLOCKS = ['paragraph', 'heading']
const ACTIVE = ['queued', 'running', 'needs_permission']
const STATES = ['reading', 'thinking', 'writing', 'waiting', 'done']
export const ID_TYPES = ['paragraph', 'heading', 'table', 'tableRow', 'tableCell', 'tableHeader', 'listItem', 'blockquote', 'codeBlock', 'bulletList', 'orderedList']

export function blocksOf(doc) {
  const blocks = []
  const walk = (node, topLevelId) => {
    if (TEXT_BLOCKS.includes(node.type) && node.attrs?.id) {
      const plain = (node.content ?? []).every(n => n.type === 'text' && !n.marks?.length)
      blocks.push({ id: node.attrs.id, type: node.type, level: node.attrs.level, text: textOf(node), revision: hash(node), plain, topLevelId })
    }
    for (const child of node.content ?? []) walk(child, topLevelId ?? child.attrs?.id)
  }
  for (const child of doc.content ?? []) walk(child, child.attrs?.id)
  return blocks
}
export function textOf(node) {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(textOf).join('')
}
function findNode(node, id) {
  if (node.attrs?.id === id) return node
  for (const child of node.content ?? []) { const found = findNode(child, id); if (found) return found }
}
function topLevelIndex(doc, id) {
  return (doc.content ?? []).findIndex(child => child.attrs?.id === id || findNode(child, id))
}
function collectIds(node, out = new Set()) {
  if (node.attrs?.id) out.add(node.attrs.id)
  for (const child of node.content ?? []) collectIds(child, out)
  return out
}
function assignIds(node, taken) {
  if ((node.attrs && 'id' in node.attrs) || ID_TYPES.includes(node.type)) {
    node.attrs = { ...(node.attrs ?? {}) }
    if (!node.attrs.id || taken.has(node.attrs.id)) node.attrs.id = randomUUID()
    taken.add(node.attrs.id)
  }
  for (const child of node.content ?? []) assignIds(child, taken)
  return node
}

export function initialState() {
  return { document: { id: randomUUID(), revision: 0, json: null, markdown: '', title: 'Untitled' }, jobs: [], proposals: [], activity: {} }
}

export class Store {
  constructor(state = initialState()) { this.state = { ...initialState(), ...state }; this.state.activity ??= {} }

  sync({ json, markdown, title, expectedRevision }) {
    if (expectedRevision !== this.state.document.revision) throw new Error('Document revision changed; reload before syncing.')
    if (!json || json.type !== 'doc') throw new Error('Invalid document')
    const ids = blocksOf(json).map(b => b.id)
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate block IDs')
    if (hash(json) !== hash(this.state.document.json)) this.state.document.revision++
    Object.assign(this.state.document, { json, markdown: markdown ?? this.state.document.markdown, title: title ?? this.state.document.title })
    const current = new Map(blocksOf(json).map(block => [block.id, block.revision]))
    for (const job of this.state.jobs) {
      if (job.kind !== 'proofread' || !ACTIVE.includes(job.status)) continue
      if (job.blockIds.some(id => current.get(id) !== job.snapshot.blocks.find(block => block.id === id)?.revision)) this.finish(job, 'superseded')
    }
    return this.state.document
  }

  snapshot() { return { ...this.state.document, blocks: blocksOf(this.state.document.json ?? { type: 'doc' }) } }

  enqueue({ instruction, blockIds, sessionId, sessionName, kind = 'command', context }) {
    if (!instruction?.trim() || instruction.length > 10000) throw new Error('Enter a command under 10,000 characters.')
    const snapshot = structuredClone(this.snapshot())
    const known = new Set(snapshot.blocks.map(b => b.id))
    const selected = [...new Set(blockIds ?? [])].filter(id => known.has(id))
    const job = { id: randomUUID(), instruction, sessionId, sessionName, kind, blockIds: selected, documentId: snapshot.id, snapshot, status: 'queued', createdAt: Date.now(), context }
    this.state.jobs.push(job)
    if (this.state.jobs.length > 200) this.state.jobs.splice(0, this.state.jobs.length - 200)
    return job
  }

  job(id, sessionId) {
    const job = this.state.jobs.find(j => j.id === id)
    if (!job || job.sessionId !== sessionId) throw new Error('Job does not belong to this session')
    return job
  }

  claim(id, sessionId) {
    const job = this.job(id, sessionId)
    if (job.status === 'queued') { job.status = 'running'; job.acknowledgedAt = Date.now() }
    else if (job.status !== 'running') throw new Error('Job is no longer available')
    if (!this.state.activity[job.id]) this.state.activity[job.id] = { jobId: job.id, sessionId, blockIds: job.blockIds, state: 'reading', progress: null, message: 'Reading the document', updatedAt: Date.now() }
    const { snapshot, ...rest } = job
    return { ...rest, snapshot, context: job.context }
  }

  activity(id, sessionId, { blockIds, state, progress, message }) {
    const job = this.job(id, sessionId)
    if (job.status !== 'running') throw new Error('Claim this job before reporting activity.')
    if (!STATES.includes(state)) throw new Error('State must be one of ' + STATES.join(', '))
    const known = new Set(job.snapshot.blocks.map(b => b.id))
    const ids = [...new Set(blockIds ?? job.blockIds)].filter(id => known.has(id))
    const pct = progress == null ? null : Math.max(0, Math.min(100, Math.round(Number(progress))))
    if (pct !== null && Number.isNaN(pct)) throw new Error('Progress must be a number from 0 to 100')
    this.state.activity[job.id] = { jobId: job.id, sessionId, blockIds: ids, state, progress: pct, message: String(message ?? '').slice(0, 200), updatedAt: Date.now() }
    return this.state.activity[job.id]
  }

  propose(input, sessionId) {
    const job = this.job(input.jobId, sessionId)
    if (job.status !== 'running') throw new Error('Claim this job before proposing changes.')
    const type = input.type ?? 'replace'
    const base = { id: randomUUID(), type, jobId: job.id, sessionId, documentId: job.documentId, explanation: String(input.explanation ?? '').slice(0, 4000), status: 'pending', createdAt: Date.now() }
    if (type === 'replace') {
      const block = job.snapshot.blocks.find(b => b.id === input.blockId)
      if (!block || (job.blockIds.length && !job.blockIds.includes(block.id))) throw new Error('Target outside job scope')
      if (!block.plain) throw new Error('Replacement proposals support plain-text paragraphs and headings only. Use an insert proposal for formatted content.')
      if (input.before !== block.text || input.blockRevision !== block.revision) throw new Error('Proposal must match the job snapshot: use before and blockRevision from claim_job.')
      validateText(input.after)
      if (input.after === block.text) throw new Error('Proposal is identical to the current text')
      const proposal = { ...base, blockId: block.id, blockRevision: block.revision, before: block.text, after: input.after }
      this.state.proposals.push(proposal)
      return proposal
    }
    if (type === 'insert') {
      const anchor = job.snapshot.blocks.find(b => b.id === input.anchorBlockId)
      if (!anchor) throw new Error('anchorBlockId must be a block from the job snapshot')
      if (!['before', 'after'].includes(input.placement ?? 'after')) throw new Error('placement must be before or after')
      if (typeof input.markdown !== 'string' || !input.markdown.trim() || input.markdown.length > 50000) throw new Error('markdown must be non-empty and under 50,000 characters')
      const proposal = { ...base, anchorBlockId: anchor.topLevelId ?? anchor.id, placement: input.placement ?? 'after', markdown: input.markdown }
      this.state.proposals.push(proposal)
      return proposal
    }
    throw new Error('type must be replace or insert')
  }

  status(id, sessionId, status, message) {
    const job = this.job(id, sessionId)
    if (['cancelled', 'superseded'].includes(job.status)) throw new Error('Job was cancelled')
    if (!['running', 'completed', 'failed', 'needs_permission'].includes(status)) throw new Error('Invalid job status')
    job.message = String(message ?? '').slice(0, 4000)
    if (status === 'running') job.status = 'running'
    else this.finish(job, status)
    return job
  }

  finish(job, status) {
    job.status = status
    job.finishedAt = Date.now()
    delete this.state.activity[job.id]
    if (status !== 'completed') for (const p of this.state.proposals) if (p.jobId === job.id && p.status === 'pending') p.status = status === 'failed' ? 'pending' : status
  }

  cancel(id) {
    const job = this.state.jobs.find(j => j.id === id)
    if (!job) throw new Error('Job not found')
    this.finish(job, 'cancelled')
  }

  isStale(proposal) {
    const doc = this.state.document.json
    if (!doc) return true
    if (proposal.type === 'insert') return topLevelIndex(doc, proposal.anchorBlockId) === -1
    const node = findNode(doc, proposal.blockId)
    return !node || hash(node) !== proposal.blockRevision || textOf(node) !== proposal.before
  }

  review(id, decision, options = {}) {
    const proposal = this.state.proposals.find(p => p.id === id)
    if (!proposal || proposal.status !== 'pending') throw new Error('Proposal is no longer pending')
    if (decision === 'reject') { proposal.status = 'rejected'; proposal.reviewedAt = Date.now(); return { proposal } }
    if (decision === 'reconsider') return this.reconsider(proposal, options.feedback)
    if (decision !== 'accept') throw new Error('Invalid review decision')
    if (this.isStale(proposal)) { proposal.status = 'stale'; return { proposal, stale: true } }
    const doc = this.state.document.json
    if (proposal.type === 'insert') {
      const nodes = options.nodes
      if (!Array.isArray(nodes) || !nodes.length) throw new Error('Insert acceptance requires the parsed content nodes')
      const taken = collectIds(doc)
      const inserted = nodes.map(node => assignIds(structuredClone(node), taken))
      const index = topLevelIndex(doc, proposal.anchorBlockId)
      doc.content.splice(proposal.placement === 'before' ? index : index + 1, 0, ...inserted)
      proposal.insertedIds = inserted.map(n => n.attrs?.id).filter(Boolean)
      if (typeof options.markdown === 'string') proposal.finalMarkdown = options.markdown
      this.state.document.revision++
      proposal.status = 'accepted'
      proposal.reviewedAt = Date.now()
      return { proposal, document: this.state.document, inserted }
    } else {
      const text = typeof options.text === 'string' ? options.text : proposal.after
      validateText(text)
      const node = findNode(doc, proposal.blockId)
      node.content = text ? [{ type: 'text', text }] : []
      proposal.finalText = text
    }
    this.state.document.revision++
    proposal.status = 'accepted'
    proposal.reviewedAt = Date.now()
    return { proposal, document: this.state.document }
  }

  reconsider(proposal, feedback) {
    if (!feedback?.trim()) throw new Error('Add a note explaining what to reconsider.')
    const original = this.state.jobs.find(j => j.id === proposal.jobId)
    if (!original) throw new Error('Original job not found')
    proposal.status = 'reconsidered'
    proposal.feedback = feedback.slice(0, 4000)
    proposal.reviewedAt = Date.now()
    const summary = proposal.type === 'insert'
      ? `You proposed inserting this content ${proposal.placement} block ${proposal.anchorBlockId}:\n\n${proposal.markdown}`
      : `You proposed replacing block ${proposal.blockId}:\n  before: ${proposal.before}\n  after: ${proposal.after}`
    const instruction = `${original.instruction}\n\nThe writer reviewed your earlier proposal and asked you to reconsider.\n${summary}\n\nWriter's note: ${proposal.feedback}\n\nSubmit a revised proposal that addresses the note.`
    const job = this.enqueue({ instruction, blockIds: original.blockIds, sessionId: original.sessionId, sessionName: original.sessionName, kind: original.kind, context: { reconsiders: proposal.id, feedback: proposal.feedback, previous: { type: proposal.type, before: proposal.before, after: proposal.after, markdown: proposal.markdown, explanation: proposal.explanation } } })
    return { proposal, job }
  }

  view() {
    return {
      document: this.state.document,
      jobs: this.state.jobs.map(({ snapshot, context, ...job }) => job),
      proposals: this.state.proposals.map(p => ({ ...p, stale: p.status === 'pending' && this.isStale(p) })),
      activity: Object.values(this.state.activity),
    }
  }
}

function validateText(text) {
  if (typeof text !== 'string' || text.length > 50000 || /[\r\n]/.test(text)) throw new Error('Replacement must be a single paragraph under 50,000 characters')
}
