import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

// The utterance being read: an inline range for sentences, a node range for images, diagrams, tables and rows.
export type ReadingRange = { from: number; to: number; inline: boolean } | null
export const readAloudKey = new PluginKey<ReadingRange>('read-aloud')

export const ReadAloudHighlight = Extension.create({
  name: 'readAloudHighlight',
  addProseMirrorPlugins() {
    return [new Plugin<ReadingRange>({
      key: readAloudKey,
      state: {
        init: () => null,
        // Any edit empties the recording, so a changed document simply drops the highlight.
        apply(tr, prev) { const meta = tr.getMeta(readAloudKey) as ReadingRange | undefined; if (meta !== undefined) return meta; return tr.docChanged ? null : prev },
      },
      props: {
        decorations(state) {
          const range = readAloudKey.getState(state)
          if (!range || range.to <= range.from || range.to > state.doc.content.size) return null
          const decoration = range.inline ? Decoration.inline(range.from, range.to, { class: 'reading-now' }) : Decoration.node(range.from, range.to, { class: 'reading-now-block' })
          return DecorationSet.create(state.doc, [decoration])
        },
      },
    })]
  },
})
