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
      blocks.push({ id: node.attrs.id, type: node.type, level: node.attrs.level, text: inlineMarkdown(node), plain, revision: hash(node), topLevelId })
    } else if (node.type === 'table' && node.attrs?.id) {
      blocks.push({ id: node.attrs.id, type: 'table', text: tableMarkdown(node), revision: hash(node), plain: tableIsPlain(node), topLevelId, rows: tableRows(node).length })
    }
    for (const child of node.content ?? []) walk(child, topLevelId ?? child.attrs?.id)
  }
  for (const child of doc.content ?? []) walk(child, child.attrs?.id)
  return blocks
}
// Tables are addressed as one block whose text is their GFM Markdown.
export function tableRows(table) {
  return (table.content ?? []).filter(r => r.type === 'tableRow').map(row => ({ header: (row.content ?? []).every(c => c.type === 'tableHeader'), cells: (row.content ?? []).map(cell => ({ node: cell, text: (cell.content ?? []).map(textOf).join('\n').trim() })) }))
}
export function tableIsPlain(table) {
  return tableRows(table).every(r => r.cells.every(c => (c.node.content ?? []).every(p => p.type === 'paragraph' && (p.content ?? []).every(n => n.type === 'text' && !n.marks?.length))))
}
const escapeCell = text => text.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
export function tableMarkdown(table) {
  const rows = tableRows(table)
  if (!rows.length) return ''
  const width = Math.max(...rows.map(r => r.cells.length))
  const line = cells => '| ' + Array.from({ length: width }, (_, i) => escapeCell(cells[i]?.text ?? '')).join(' | ') + ' |'
  const out = [line(rows[0].cells), '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |']
  for (const row of rows.slice(1)) out.push(line(row.cells))
  return out.join('\n')
}
export function parseTableMarkdown(markdown) {
  const lines = String(markdown).split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('|'))
  const split = l => l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
  const rows = lines.filter(l => !/^\|(\s*:?-{3,}:?\s*\|)+$/.test(l)).map(split)
  if (!rows.length) throw new Error('A table replacement must be a GFM Markdown table')
  const width = Math.max(...rows.map(r => r.length))
  return rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''))
}
export function blockText(node) { return node.type === 'table' ? tableMarkdown(node) : TEXT_BLOCKS.includes(node.type) ? inlineMarkdown(node) : textOf(node) }
// Inline Markdown for a paragraph or heading: what the agent reads as `before` and writes as `after`.
const MARK_WRAP = { bold: '**', italic: '*', strike: '~~', code: '`' }
export function inlineMarkdown(node) {
  let out = ''
  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') { out += '  \n'; continue }
    if (child.type !== 'text') continue
    let text = child.text ?? ''
    const marks = child.marks ?? []
    const link = marks.find(m => m.type === 'link')
    for (const m of marks) if (MARK_WRAP[m.type]) text = MARK_WRAP[m.type] + text + MARK_WRAP[m.type]
    if (link?.attrs?.href) text = `[${text}](${link.attrs.href})`
    out += text
  }
  return out
}
const INLINE_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link', 'underline', 'highlight', 'subscript', 'superscript'])
export function validateInlineContent(content) {
  if (!Array.isArray(content) || content.length > 2000) throw new Error('Replacement content must be a list of inline nodes')
  return content.map(n => {
    if (n?.type === 'hardBreak') return { type: 'hardBreak' }
    if (n?.type !== 'text' || typeof n.text !== 'string' || !n.text) throw new Error('Replacement content may only contain text and line breaks')
    const marks = (n.marks ?? []).filter(m => INLINE_MARKS.has(m?.type)).map(m => m.type === 'link' ? { type: 'link', attrs: { href: String(m.attrs?.href ?? '').match(/^(https?:|mailto:|#|\/)/) ? String(m.attrs.href) : '#', target: '_blank', rel: 'noopener noreferrer nofollow' } } : { type: m.type })
    return marks.length ? { type: 'text', text: n.text, marks } : { type: 'text', text: n.text }
  })
}
export function textOf(node) {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(textOf).join('')
}
function rebuildTable(table, rows, taken) {
  const old = tableRows(table)
  const headerFirst = old[0]?.header ?? true
  const content = rows.map((cells, r) => {
    const oldRow = old[r]
    const rowNode = { type: 'tableRow', attrs: { ...(oldRow ? (table.content.filter(x => x.type === 'tableRow')[r].attrs ?? {}) : {}) }, content: cells.map((text, c) => {
      const oldCell = oldRow?.cells[c]?.node
      const oldParagraph = oldCell?.content?.find(p => p.type === 'paragraph')
      const cellType = r === 0 && headerFirst ? 'tableHeader' : 'tableCell'
      return { type: cellType, attrs: { ...(oldCell?.attrs ?? {}), colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', attrs: { ...(oldParagraph?.attrs ?? {}) }, content: text ? [{ type: 'text', text }] : [] }] }
    }) }
    return rowNode
  })
  const next = { ...table, content }
  // Fresh ids for new rows/cells, keep the table's own id.
  const keep = new Set(); collectIds(table, keep)
  const seen = new Set()
  const fix = node => {
    if (node.attrs && 'id' in node.attrs) { if (!node.attrs.id || seen.has(node.attrs.id)) node.attrs = { ...node.attrs, id: randomUUID() }; seen.add(node.attrs.id); taken.add(node.attrs.id) }
    else if (ID_TYPES.includes(node.type)) { node.attrs = { ...(node.attrs ?? {}), id: randomUUID() }; taken.add(node.attrs.id) }
    for (const child of node.content ?? []) fix(child)
  }
  seen.add(next.attrs.id)
  for (const row of next.content) fix(row)
  return next
}
function removeNode(parent, id) {
  const index = (parent.content ?? []).findIndex(c => c.attrs?.id === id)
  if (index !== -1) { parent.content.splice(index, 1); if (!parent.content.length && parent.type !== 'doc') parent.content = [{ type: 'paragraph', attrs: { id: randomUUID() } }]; return true }
  for (const child of parent.content ?? []) if (removeNode(child, id)) return true
  return false
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
    const safeContext = context && typeof context === 'object' ? { ...context, selection: typeof context.selection === 'string' ? context.selection.slice(0, 4000) : undefined } : undefined
    const job = { id: randomUUID(), instruction, sessionId, sessionName, kind, blockIds: selected, documentId: snapshot.id, snapshot, status: 'queued', createdAt: Date.now(), context: safeContext, directive: typeof safeContext?.tk === 'string' ? safeContext.tk.slice(0, 500) : undefined }
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
      if (block.type === 'table' && !block.plain) throw new Error('This table has formatted or nested cells; propose an insert with a new table instead.')
      if (input.before !== block.text || input.blockRevision !== block.revision) throw new Error('Proposal must match the job snapshot: use before and blockRevision from claim_job.')
      if (block.type === 'table') parseTableMarkdown(input.after); else validateText(input.after)
      if (typeof input.after !== 'string' || input.after.length > 50000) throw new Error('Replacement must be under 50,000 characters')
      if (input.after === block.text) throw new Error('Proposal is identical to the current text')
      const proposal = { ...base, blockId: block.id, blockType: block.type, blockRevision: block.revision, before: block.text, after: input.after }
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
    if (type === 'comment') {
      const block = job.snapshot.blocks.find(b => b.id === input.blockId)
      if (!block) throw new Error('blockId must be a block from the job snapshot')
      const text = String(input.text ?? input.explanation ?? '').trim()
      if (!text || text.length > 8000) throw new Error('A comment needs text under 8,000 characters')
      const proposal = { ...base, blockId: block.id, blockType: block.type, text, explanation: '' }
      this.state.proposals.push(proposal)
      return proposal
    }
    throw new Error('type must be replace, insert or comment')
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
    if (proposal.type === 'comment') return !findNode(doc, proposal.blockId)
    const node = findNode(doc, proposal.blockId)
    return !node || hash(node) !== proposal.blockRevision || blockText(node) !== proposal.before
  }

  review(id, decision, options = {}) {
    const proposal = this.state.proposals.find(p => p.id === id)
    if (!proposal || proposal.status !== 'pending') throw new Error('Proposal is no longer pending')
    if (decision === 'reject') { proposal.status = 'rejected'; proposal.reviewedAt = Date.now(); return { proposal } }
    if (proposal.type === 'comment') {
      if (decision === 'reply') return this.reply(proposal, options.feedback)
      if (decision === 'resolve' || decision === 'accept') { proposal.status = 'resolved'; proposal.reviewedAt = Date.now(); return { proposal } }
      throw new Error('Comments can be resolved, replied to, or dismissed')
    }
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
    } else if (proposal.blockType === 'table') {
      const text = typeof options.text === 'string' ? options.text : proposal.after
      const rows = parseTableMarkdown(text)
      const index = topLevelIndex(doc, proposal.blockId)
      const node = findNode(doc, proposal.blockId)
      const rebuilt = rebuildTable(node, rows, collectIds(doc))
      if (index !== -1 && doc.content[index].attrs?.id === proposal.blockId) doc.content[index] = rebuilt
      else Object.assign(node, rebuilt)
      proposal.finalText = text
      this.state.document.revision++
      proposal.status = 'accepted'
      proposal.reviewedAt = Date.now()
      return { proposal, document: this.state.document, node: rebuilt }
    } else {
      const text = typeof options.text === 'string' ? options.text : proposal.after
      validateText(text)
      const node = findNode(doc, proposal.blockId)
      if (!text.trim()) {
        removeNode(doc, proposal.blockId)
        proposal.finalText = ''
        proposal.removed = true
        this.state.document.revision++
        proposal.status = 'accepted'
        proposal.reviewedAt = Date.now()
        return { proposal, document: this.state.document, removed: true }
      }
      node.content = options.content ? validateInlineContent(options.content) : [{ type: 'text', text }]
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

  reply(proposal, feedback) {
    if (!feedback?.trim()) throw new Error('Write a reply first.')
    const original = this.state.jobs.find(j => j.id === proposal.jobId)
    if (!original) throw new Error('Original job not found')
    proposal.status = 'replied'
    proposal.feedback = feedback.slice(0, 4000)
    proposal.reviewedAt = Date.now()
    const instruction = `${original.instruction}\n\nYou left this comment on block ${proposal.blockId}:\n${proposal.text}\n\nThe writer replied: ${proposal.feedback}\n\nContinue the conversation: answer with another comment on the same block, or propose an edit if one is now warranted.`
    const job = this.enqueue({ instruction, blockIds: original.blockIds.length ? original.blockIds : [proposal.blockId], sessionId: original.sessionId, sessionName: original.sessionName, kind: original.kind, context: { repliesTo: proposal.id, comment: proposal.text, feedback: proposal.feedback } })
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
