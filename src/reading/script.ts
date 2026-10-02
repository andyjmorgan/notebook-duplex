import type { Node as PMNode } from '@tiptap/pm/model'
import { splitSentences, imageText, tableIntro, columnTitles, tableRowText } from '../../shared/narration.mjs'

export type UtteranceKind = 'text' | 'heading' | 'image' | 'diagram' | 'code' | 'table' | 'row'
export type Describe = { kind: 'diagram' | 'code'; source: string; language: string | null }
export type Utterance = { id: number; kind: UtteranceKind; text?: string; from: number; to: number; inline: boolean; describe?: Describe }

const TK = /\[tk:[^\]\n]*\]?/g

// Flatten a text block to a string whose every character maps back to a document position.
function flatten(node: PMNode, pos: number) {
  let text = '', prose = ''
  const map: number[] = []
  const add = (chunk: string, at: (i: number) => number, isProse = true) => { for (let i = 0; i < chunk.length; i++) { text += chunk[i]; prose += isProse ? chunk[i] : ' '; map.push(at(i)) } }
  node.forEach((child, offset) => {
    const base = pos + 1 + offset
    if (child.isText) add(child.text!, i => base + i)
    else if (child.type.name === 'image') add(` ${imageText(child.attrs.alt, true)} `, () => base, false)
    else if (child.type.name === 'hardBreak') add(' ', () => base)
    else add(child.textContent, () => base)
  })
  map.push(pos + 1 + node.content.size)
  // Directives are instructions for Claude, not prose: blank them while keeping the offsets aligned.
  const blank = (m: string) => ' '.repeat(m.length)
  return { text: text.replace(TK, blank), prose: prose.replace(TK, blank), map }
}

export function buildScript(doc: PMNode): Utterance[] {
  const script: Utterance[] = []
  const push = (u: Omit<Utterance, 'id'>) => { if (u.to > u.from) script.push({ ...u, id: script.length }) }
  doc.descendants((node, pos) => {
    if (node.type.name === 'table') {
      const rows: { node: PMNode; pos: number }[] = []
      node.forEach((row, offset) => rows.push({ node: row, pos: pos + 1 + offset }))
      const headerRow = rows[0] && rows[0].node.childCount > 0 && (() => { let all = true; rows[0].node.forEach(c => { if (c.type.name !== 'tableHeader') all = false }); return all })() ? rows[0] : undefined
      const body = headerRow ? rows.slice(1) : rows
      const columns = Math.max(...rows.map(r => r.node.childCount), 0)
      push({ kind: 'table', text: tableIntro(columns, body.length), from: pos, to: pos + node.nodeSize, inline: false })
      const titles = columnTitles(headerRow ? (() => { const h: string[] = []; headerRow.node.forEach(c => h.push(c.textContent)); return h })() : null, columns)
      for (const row of body) {
        const cells: string[] = []
        row.node.forEach(c => cells.push(c.textContent.replace(TK, '')))
        push({ kind: 'row', text: tableRowText(titles, cells), from: row.pos, to: row.pos + row.node.nodeSize, inline: false })
      }
      return false
    }
    if (node.type.name === 'codeBlock') {
      const language = (node.attrs.language as string | null) ?? null
      const source = node.textContent
      if (language === 'mermaid') push({ kind: 'diagram', from: pos, to: pos + node.nodeSize, inline: false, describe: { kind: 'diagram', source, language } })
      else push({ kind: 'code', from: pos, to: pos + node.nodeSize, inline: false, describe: { kind: 'code', source, language } })
      return false
    }
    if (!node.isTextblock) return true
    const { text, prose, map } = flatten(node, pos)
    const images: { pos: number; alt: string }[] = []
    node.forEach((child, offset) => { if (child.type.name === 'image') images.push({ pos: pos + 1 + offset, alt: child.attrs.alt ?? '' }) })
    if (images.length && !prose.trim()) {
      for (const image of images) push({ kind: 'image', text: imageText(image.alt) + '.', from: image.pos, to: image.pos + 1, inline: false })
      return false
    }
    if (node.type.name === 'heading') {
      const trimmed = text.trim()
      if (trimmed) { const start = text.indexOf(trimmed); push({ kind: 'heading', text: trimmed.replace(/\s+/g, ' '), from: map[start], to: map[start + trimmed.length], inline: true }) }
      return false
    }
    for (const s of splitSentences(text)) push({ kind: 'text', text: s.text.replace(/\s+/g, ' '), from: map[s.start], to: map[s.end], inline: true })
    return false
  })
  return script
}

// The utterance that contains a document position, or the first one after it.
export function utteranceAt(script: Utterance[], pos: number) {
  const inside = script.findIndex(u => pos >= u.from && pos < u.to)
  if (inside >= 0) return inside
  const after = script.findIndex(u => u.from >= pos)
  return after >= 0 ? after : Math.max(script.length - 1, 0)
}
