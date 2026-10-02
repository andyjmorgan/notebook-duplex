import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

// Literal `![alt](src)` text inside a text block becomes an inline image node, whether it was
// typed, pasted as plain text, or arrived through an agent's replacement.
const pattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g
export const ImageMarkdown = Extension.create({
  name: 'imageMarkdown',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('image-markdown'),
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some(t => t.docChanged)) return null
        const image = state.schema.nodes.image
        if (!image) return null
        const edits: { from: number; to: number; attrs: Record<string, string> }[] = []
        state.doc.descendants((node, pos) => {
          if (!node.isTextblock || node.type.name === 'codeBlock') return
          const text = node.textContent
          if (!text.includes('![')) return
          pattern.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = pattern.exec(text))) {
            if (!/^(https?:|data:image\/|\/)/.test(match[2])) continue
            edits.push({ from: pos + 1 + match.index, to: pos + 1 + match.index + match[0].length, attrs: { src: match[2], alt: match[1], title: match[3] ?? '' } })
          }
        })
        if (!edits.length) return null
        let tr = state.tr
        for (const edit of edits.sort((a, b) => b.from - a.from)) tr = tr.replaceWith(edit.from, edit.to, image.create(edit.attrs))
        return tr
      },
    })]
  },
})
