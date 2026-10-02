import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Activity, Job, Proposal, Session } from '../types'

export type Annotations = { proposals: Proposal[]; activity: Activity[]; queued: Job[]; sessions: Session[] }
export const annotationsKey = new PluginKey<Annotations>('notebook-annotations')
const empty: Annotations = { proposals: [], activity: [], queued: [], sessions: [] }

// Widget hosts outlive individual decoration renders so React portals keep their state.
const hosts = new Map<string, HTMLElement>()
export function hostFor(id: string) {
  let host = hosts.get(id)
  if (!host) {
    host = document.createElement('div')
    host.className = 'suggestion-host'
    host.contentEditable = 'false'
    host.dataset.proposal = id
    hosts.set(id, host)
  }
  return host
}
export function releaseHosts(keep: Set<string>) { for (const id of [...hosts.keys()]) if (!keep.has(id)) hosts.delete(id) }

const stateLabel: Record<Activity['state'], string> = { reading: 'reading', thinking: 'thinking', writing: 'writing', waiting: 'waiting on you', done: 'finishing' }

function topLevelPositions(doc: PMNode) {
  const map = new Map<string, { pos: number; node: PMNode }>()
  doc.forEach((node, offset) => { if (node.attrs?.id) map.set(node.attrs.id, { pos: offset, node }) })
  return map
}

export function buildDecorations(doc: PMNode, { proposals, activity, queued, sessions }: Annotations) {
  const decorations: Decoration[] = []
  const nodeClasses = new Map<string, { classes: Set<string>; attrs: Record<string, string> }>()
  const mark = (id: string, cls: string, attrs: Record<string, string> = {}) => {
    const entry = nodeClasses.get(id) ?? { classes: new Set(), attrs: {} }
    entry.classes.add(cls); Object.assign(entry.attrs, attrs); nodeClasses.set(id, entry)
  }
  const sessionName = (id: string) => sessions.find(s => s.id === id)?.name ?? 'Claude'
  for (const a of activity) for (const id of a.blockIds) mark(id, `agent-active agent-${a.state}`, { 'data-agent': `${sessionName(a.sessionId)} · ${a.message || stateLabel[a.state]}${a.progress != null ? ` · ${a.progress}%` : ''}`, style: a.progress != null ? `--progress:${a.progress}%` : '--progress:0%' })
  for (const j of queued) for (const id of j.blockIds) if (!activity.some(a => a.jobId === j.id)) mark(id, 'agent-queued', { 'data-agent': `${j.sessionName ?? 'Claude'} · queued` })
  for (const p of proposals) if (p.type === 'replace' && p.blockId) mark(p.blockId, p.stale ? 'has-suggestion stale' : 'has-suggestion')
  for (const p of proposals) if (p.type === 'comment' && p.blockId) mark(p.blockId, 'has-comment')

  const topLevel = topLevelPositions(doc)
  // Blocks inside a table: lift agent presence onto the table itself, keep the cells quiet.
  const tableOf = new Map<string, PMNode>()
  doc.forEach(top => { if (top.type.name === 'table') top.descendants(n => { if (n.attrs?.id) tableOf.set(n.attrs.id, top) }) })
  for (const [id, entry] of [...nodeClasses]) {
    const table = tableOf.get(id)
    if (!table?.attrs?.id) continue
    const lifted = nodeClasses.get(table.attrs.id) ?? { classes: new Set(), attrs: {} }
    for (const c of entry.classes) lifted.classes.add(c)
    Object.assign(lifted.attrs, entry.attrs)
    nodeClasses.set(table.attrs.id, lifted)
    nodeClasses.set(id, { classes: new Set([...entry.classes].map(c => c + '-cell')), attrs: {} })
  }
  doc.descendants((node, pos) => {
    const id = node.attrs?.id
    if (!id || !nodeClasses.has(id)) return
    const { classes, attrs } = nodeClasses.get(id)!
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: [...classes].join(' '), ...attrs }))
  })
  for (const p of proposals) {
    let at: number | undefined
    if ((p.type === 'replace' || p.type === 'comment') && p.blockId) {
      const table = tableOf.get(p.blockId)
      if (table?.attrs?.id && topLevel.has(table.attrs.id)) { const t = topLevel.get(table.attrs.id)!; at = t.pos + t.node.nodeSize }
      else doc.descendants((node, pos) => { if (node.attrs?.id === p.blockId) { at = pos + node.nodeSize; return false } return at === undefined })
    } else if (p.type === 'insert' && p.anchorBlockId) {
      const anchor = topLevel.get(p.anchorBlockId)
      if (anchor) at = p.placement === 'before' ? anchor.pos : anchor.pos + anchor.node.nodeSize
    }
    if (at === undefined) continue
    decorations.push(Decoration.widget(at, () => hostFor(p.id), { key: `proposal-${p.id}-${p.stale ? 'stale' : 'live'}`, side: p.placement === 'before' ? -1 : 1, ignoreSelection: true, stopEvent: () => true }))
  }
  return DecorationSet.create(doc, decorations)
}

export const NotebookAnnotations = Extension.create({
  name: 'notebookAnnotations',
  addProseMirrorPlugins() {
    return [new Plugin<Annotations>({
      key: annotationsKey,
      state: { init: () => empty, apply: (tr, prev) => (tr.getMeta(annotationsKey) as Annotations | undefined) ?? prev },
      props: { decorations(state) { return buildDecorations(state.doc, annotationsKey.getState(state) ?? empty) } },
    })]
  },
})
