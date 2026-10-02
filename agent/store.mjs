import { randomUUID, createHash } from 'node:crypto'
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function blocksOf(doc) {
  const blocks = []
  function walk(node) {
    if (['paragraph', 'heading'].includes(node.type) && node.attrs?.id) {
      const plain = (node.content ?? []).every(n => n.type === 'text' && !n.marks?.length)
      blocks.push({ id: node.attrs.id, type: node.type, text: textOf(node), revision: hash(node), plain })
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(doc)
  return blocks
}
function textOf(node) {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(textOf).join('')
}
function targetNode(doc, id) {
  if (doc.attrs?.id === id && ['paragraph','heading'].includes(doc.type)) return doc
  for (const child of doc.content ?? []) { const found = targetNode(child,id); if (found) return found }
}
export function initialState() {
  return { document: { id: randomUUID(), revision: 0, json: null, markdown: '', title: 'Untitled' }, jobs: [], proposals: [] }
}
export class Store {
  constructor(state = initialState()) { this.state = state }
  sync({ json, markdown, title, expectedRevision }) {
    if (expectedRevision !== this.state.document.revision) throw new Error('Document revision changed; reload before syncing.')
    if (!json || json.type !== 'doc') throw new Error('Invalid document')
    const ids = blocksOf(json).map(b=>b.id)
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate block IDs')
    if (hash(json) !== hash(this.state.document.json)) this.state.document.revision++
    Object.assign(this.state.document, { json, markdown, title })
    const current = new Map(blocksOf(json).map(block=>[block.id,block.revision]))
    for (const job of this.state.jobs) {
      if (job.kind !== 'proofread' || !['queued','running','needs_permission'].includes(job.status)) continue
      if (job.blockIds.some(id=>current.get(id)!==job.snapshot.blocks.find(block=>block.id===id)?.revision)) {
        job.status='superseded'
        for (const proposal of this.state.proposals.filter(p=>p.jobId===job.id&&p.status==='pending')) proposal.status='superseded'
      }
    }
    return this.state.document
  }
  snapshot() { return { ...this.state.document, blocks: blocksOf(this.state.document.json ?? { type:'doc' }) } }
  enqueue({ instruction, blockIds, sessionId, kind = 'command' }) {
    if (!instruction?.trim() || instruction.length > 10000) throw new Error('Enter a command under 10,000 characters.')
    const snapshot = structuredClone(this.snapshot())
    const selected = new Set(blockIds ?? [])
    const job = { id: randomUUID(), instruction, sessionId, kind, blockIds: [...selected], documentId: snapshot.id, snapshot, status:'queued', createdAt:Date.now() }
    this.state.jobs.push(job)
    return job
  }
  job(id, sessionId) {
    const job = this.state.jobs.find(j=>j.id===id)
    if (!job || job.sessionId !== sessionId) throw new Error('Job does not belong to this session')
    return job
  }
  claim(id, sessionId) {
    const job = this.job(id,sessionId)
    if (job.status === 'queued' || job.status === 'delivered') { job.status = 'running'; job.acknowledgedAt = Date.now() }
    else if (job.status !== 'running') throw new Error('Job is no longer available')
    return { id:job.id, instruction:job.instruction, blockIds:job.blockIds, snapshot:job.snapshot, status:job.status }
  }
  propose(input, sessionId) {
    const job = this.job(input.jobId,sessionId)
    if (job.status !== 'running') throw new Error('Claim this job before proposing changes.')
    const block = job.snapshot.blocks.find(b=>b.id===input.blockId)
    if (!block || (job.blockIds.length && !job.blockIds.includes(block.id))) throw new Error('Target outside job scope')
    if (!block.plain) throw new Error('Prototype proposals support plain-text paragraphs and headings only.')
    if (input.before !== block.text || input.blockRevision !== block.revision) throw new Error('Proposal must match the job snapshot')
    if (typeof input.after !== 'string' || input.after.length > 50000 || /[\r\n]/.test(input.after)) throw new Error('Replacement must be a single paragraph under 50,000 characters')
    const proposal = { id:randomUUID(), jobId:job.id, documentId:job.documentId, blockId:block.id, blockRevision:block.revision, before:input.before, after:input.after, explanation:input.explanation ?? '', status:'pending', createdAt:Date.now() }
    this.state.proposals.push(proposal)
    return proposal
  }
  status(id, sessionId, status, message) {
    const job = this.job(id,sessionId)
    if (['cancelled','superseded'].includes(job.status)) throw new Error('Job was cancelled')
    if (!['running','completed','failed','needs_permission'].includes(status)) throw new Error('Invalid job status')
    job.status = status; job.message = String(message ?? '').slice(0,4000)
    return job
  }
  cancel(id) {
    const job = this.state.jobs.find(j=>j.id===id)
    if (!job) throw new Error('Job not found')
    job.status = 'cancelled'
    for (const proposal of this.state.proposals.filter(p=>p.jobId===id && p.status==='pending')) proposal.status='cancelled'
  }
  review(id, decision) {
    const proposal = this.state.proposals.find(p=>p.id===id)
    if (!proposal || proposal.status !== 'pending') throw new Error('Proposal is no longer pending')
    if (decision === 'reject') { proposal.status = 'rejected'; return {proposal} }
    if (decision !== 'accept') throw new Error('Invalid review decision')
    const node = targetNode(this.state.document.json,proposal.blockId)
    if (!node || hash(node) !== proposal.blockRevision || textOf(node) !== proposal.before) {
      proposal.status = 'stale'; return { proposal, stale:true }
    }
    node.content = proposal.after ? [{ type:'text',text:proposal.after }] : []
    this.state.document.revision++
    proposal.status = 'accepted'
    return { proposal, document:this.state.document }
  }
  view() {
    const blocks = new Map(this.snapshot().blocks.map(b=>[b.id,b]))
    return { document:this.state.document, jobs:this.state.jobs.map(({snapshot,...job})=>job), proposals:this.state.proposals.map(p=>({...p, stale:p.status==='pending' && blocks.get(p.blockId)?.revision !== p.blockRevision})) }
  }
}
