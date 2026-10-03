import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

// [[Wikilinks]] render as links to the matching document when the title resolves, and stay plain text otherwise.
// Resolution comes from the library (titles) and the document's parsed `links.out`; the host pushes a resolver in via meta.
export type WikiResolver = (title: string) => { id: string; title: string } | undefined
type PluginState = { resolve: WikiResolver }
export const wikilinksKey = new PluginKey<PluginState>('wikilinks')
const pattern = /\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]*))?\]\]/g

export type WikiLink = { title: string; label: string; from: number; to: number }
export function findWikilinks(doc: PMNode): WikiLink[] {
  const found: WikiLink[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock || node.type.name === 'codeBlock') return
    const text = node.textContent
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) found.push({ title: match[1].trim(), label: (match[2] ?? match[1]).trim(), from: pos + 1 + match.index, to: pos + 1 + match.index + match[0].length })
  })
  return found
}

export const WikiLinks = Extension.create<{ onOpen: (id: string) => void }>({
  name: 'wikilinks',
  addOptions() { return { onOpen: () => {} } },
  addProseMirrorPlugins() {
    const onOpen = this.options.onOpen
    return [new Plugin<PluginState>({
      key: wikilinksKey,
      state: { init: () => ({ resolve: () => undefined }), apply: (tr, prev) => (tr.getMeta(wikilinksKey) as PluginState | undefined) ?? prev },
      props: {
        decorations(state) {
          const { resolve } = wikilinksKey.getState(state)!
          const decorations = findWikilinks(state.doc).map(l => {
            const target = resolve(l.title)
            return target
              // No href: the host navigates in-app, and a real anchor inside contenteditable would also open tabs on ⌘-click.
              ? Decoration.inline(l.from, l.to, { nodeName: 'a', class: 'wikilink resolved', role: 'link', 'data-doc': target.id, 'data-href': `/d/${target.id}`, title: `Open “${target.title}” (⌘-click while editing)` })
              : Decoration.inline(l.from, l.to, { class: 'wikilink unresolved', title: 'No document with this title yet' })
          })
          return DecorationSet.create(state.doc, decorations)
        },
        handleDOMEvents: {
          click(view, event) {
            const link = (event.target as HTMLElement).closest?.('a.wikilink[data-doc]') as HTMLElement | null
            if (!link) return false
            if (view.editable && !(event.metaKey || event.ctrlKey)) return false
            event.preventDefault(); onOpen(link.dataset.doc!); return true
          },
        },
      },
    })]
  },
})
