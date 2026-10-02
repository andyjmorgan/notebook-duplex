import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

export type Directive = { blockId: string; text: string; from: number; to: number; complete: boolean }
export type DirectiveStatus = Map<string, 'queued' | 'working' | 'done' | 'failed'>
export const directiveKey = (d: { blockId: string; text: string }) => `${d.blockId}|${d.text}`
export const directivesPluginKey = new PluginKey<DirectiveStatus>('tk-directives')

const pattern = /\[tk:([^\]\n]*)(\]?)/g

export function findDirectives(doc: PMNode): Directive[] {
  const found: Directive[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock || !node.attrs?.id) return
    const text = node.textContent
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      const complete = match[2] === ']'
      found.push({ blockId: node.attrs.id, text: match[1].trim(), from: pos + 1 + match.index, to: pos + 1 + match.index + match[0].length, complete })
    }
  })
  return found
}

export const TkDirectives = Extension.create({
  name: 'tkDirectives',
  addProseMirrorPlugins() {
    return [new Plugin<DirectiveStatus>({
      key: directivesPluginKey,
      state: { init: () => new Map(), apply: (tr, prev) => (tr.getMeta(directivesPluginKey) as DirectiveStatus | undefined) ?? prev },
      props: {
        decorations(state) {
          const status = directivesPluginKey.getState(state) ?? new Map()
          const decorations = findDirectives(state.doc).map(d => {
            const s = d.complete ? status.get(directiveKey(d)) : undefined
            const cls = ['tk-chip', d.complete ? 'complete' : 'open', s ? `tk-${s}` : ''].filter(Boolean).join(' ')
            return Decoration.inline(d.from, d.to, { class: cls, 'data-tk': d.text })
          })
          return DecorationSet.create(state.doc, decorations)
        },
      },
    })]
  },
})
