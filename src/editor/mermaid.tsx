import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { flushSync } from 'react-dom'
import { TextSelection } from '@tiptap/pm/state'
import CodeBlock from '@tiptap/extension-code-block'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'

let mermaidModule: Promise<typeof import('mermaid')['default']> | undefined
function loadMermaid() {
  mermaidModule ??= Promise.all([import('mermaid'), import('@mermaid-js/layout-elk'), import('@mermaid-js/layout-tidy-tree')]).then(([m, elk, tidy]) => {
    m.default.registerLayoutLoaders(elk.default)
    m.default.registerLayoutLoaders(tidy.default)
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: '"Inter", system-ui, sans-serif', fontSize: 15, flowchart: { padding: 12, nodeSpacing: 40, rankSpacing: 50 } })
    return m.default
  })
  return mermaidModule
}

// Diagrams without an explicit theme follow the app theme: neutral in light mode, Mermaid's dark theme in dark mode.
function useDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}
function themedSource(source: string) {
  if (!document.documentElement.classList.contains('dark') || readFrontmatter(source).config.theme) return source
  return writeFrontmatter(source, { ...readFrontmatter(source).config, theme: 'dark' })
}

// Per-diagram tuning lives in Mermaid's YAML front matter. These helpers read and rewrite it.
export type DiagramConfig = { theme?: string; look?: string; layout?: string }
export function readFrontmatter(source: string): { config: DiagramConfig; body: string; raw: string } {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!match) return { config: {}, body: source, raw: '' }
  const config: DiagramConfig = {}
  for (const key of ['theme', 'look', 'layout'] as const) { const m = match[1].match(new RegExp(`^\\s+${key}:\\s*([^\\n#]+)`, 'm')); if (m) config[key] = m[1].trim().replace(/^['"]|['"]$/g, '') }
  return { config, body: source.slice(match[0].length), raw: match[0] }
}
export function writeFrontmatter(source: string, next: DiagramConfig): string {
  const { body, raw } = readFrontmatter(source)
  const entries = Object.entries(next).filter(([, v]) => v && v !== 'default')
  if (!entries.length) return body
  // Preserve any other config keys the writer put in by hand.
  const kept = raw ? raw.split('\n').filter(l => /^\s{2,}\S/.test(l) && !/^\s+(theme|look|layout):/.test(l)) : []
  return `---\nconfig:\n${entries.map(([k, v]) => `  ${k}: ${v}`).join('\n')}${kept.length ? '\n' + kept.join('\n') : ''}\n---\n${body}`
}
export function diagramKind(source: string) {
  const first = readFrontmatter(source).body.trim().split('\n')[0]?.trim().toLowerCase() ?? ''
  if (first.startsWith('mindmap')) return 'mindmap'
  if (/^(flowchart|graph|statediagram|classdiagram|erdiagram|block)/.test(first)) return 'graph'
  return 'other'
}
const THEMES = ['default', 'neutral', 'forest', 'dark', 'base']
const LOOKS: [string, string][] = [['default', 'classic'], ['handDrawn', 'hand drawn'], ['neo', 'neo']]
const LAYOUTS: Record<string, [string, string][]> = { mindmap: [['default', 'cose'], ['tidy-tree', 'tidy tree']], graph: [['default', 'dagre'], ['elk', 'elk']], other: [] }
let counter = 0

export function MermaidPreview({ source, onAsk }: { source: string; onAsk?: () => void }) {
  const [svg, setSvg] = useState('')
  const dark = useDarkMode()
  const [error, setError] = useState('')
  const id = useRef('mermaid-' + (++counter))
  const host = useRef<HTMLDivElement>(null)
  // Mermaid pins the SVG to its natural size; let small diagrams grow (up to 1.8×) while big ones still shrink to fit.
  useEffect(() => {
    const el = host.current?.querySelector('svg')
    if (!el) return
    const natural = el.viewBox?.baseVal?.width || el.getBoundingClientRect().width
    el.style.maxWidth = 'none'
    el.style.width = natural ? `min(100%, ${Math.round(natural * 1.8)}px)` : '100%'
    el.style.height = 'auto'
  }, [svg])
  useEffect(() => {
    if (!source.trim()) { setSvg(''); setError(''); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid()
        const result = await mermaid.render(id.current + '-' + Date.now().toString(36), themedSource(source))
        if (!cancelled) { setSvg(result.svg); setError('') }
      } catch (e) {
        const message = (e as Error).message ?? ''
        if (/dynamically imported module|Failed to fetch|Loading chunk|import\(/i.test(message)) window.dispatchEvent(new Event('notebook:chunk-failed'))
        if (!cancelled) setError(message.split('\n')[0] || 'Diagram could not be rendered')
        document.getElementById('d' + id.current)?.remove()
      }
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [source, dark])
  const [expanded, setExpanded] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const d = dialog.current; if (!d) return; if (expanded && !d.open) d.showModal(); if (!expanded && d.open) d.close() }, [expanded])
  if (!source.trim()) return <div className="mermaid-preview empty">Type a Mermaid diagram above to preview it here.</div>
  return (
    <div className={`mermaid-preview ${error ? 'has-error' : ''}`} contentEditable={false}>
      {svg && <div className="mermaid-tools"><button type="button" className="mermaid-expand" title="Expand diagram" aria-label="Expand diagram" onMouseDown={e => e.preventDefault()} onClick={() => setExpanded(true)}>⤢</button>{onAsk && <button type="button" className="mermaid-expand mermaid-ask" title="Ask Claude about this diagram" aria-label="Ask Claude about this diagram" onMouseDown={e => e.preventDefault()} onClick={onAsk}><span className="claude-mark" aria-hidden /></button>}</div>}
      {svg && <div ref={host} className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
      {error && <div className="mermaid-error">{error}</div>}
      {expanded && createPortal(
        <dialog ref={dialog} className="mermaid-modal" onClose={() => setExpanded(false)} onClick={e => { if (e.target === dialog.current) setExpanded(false) }}>
          <div className="mermaid-modal-body">
            <button type="button" className="quiet small mermaid-close" onClick={() => setExpanded(false)} aria-label="Close">Close <kbd>esc</kbd></button>
            <div className="mermaid-modal-svg" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        </dialog>, document.body)}
    </div>
  )
}

function CodeBlockView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const language = (node.attrs.language as string | null) ?? ''
  const isMermaid = language === 'mermaid'
  const hasSource = node.textContent.trim().length > 0
  const [tab, setTab] = useState<'diagram' | 'source'>(hasSource ? 'diagram' : 'source')
  const [editable, setEditable] = useState(editor.isEditable)
  // Follow the caret: editing the source shows the source, leaving the block shows the diagram.
  useEffect(() => {
    if (!isMermaid) return
    const onSelection = () => {
      const pos = typeof getPos === 'function' ? getPos() : undefined
      if (pos === undefined) return
      const { from, to } = editor.state.selection
      const current = editor.state.doc.nodeAt(pos)
      const size = current?.nodeSize ?? node.nodeSize
      const inside = from >= pos + 1 && to <= pos + size - 1
      if (inside) setTab('source')
      else if ((current?.textContent ?? node.textContent).trim()) setTab('diagram')
    }
    const onEditable = () => setEditable(editor.isEditable)
    editor.on('selectionUpdate', onSelection); editor.on('update', onEditable); editor.on('transaction', onEditable)
    return () => { editor.off('selectionUpdate', onSelection); editor.off('update', onEditable); editor.off('transaction', onEditable) }
  }, [editor, getPos, isMermaid, node])
  const tuning = readFrontmatter(node.textContent).config
  const kind = diagramKind(node.textContent)
  const retune = (patch: DiagramConfig) => {
    const pos = typeof getPos === 'function' ? getPos() : undefined
    if (pos === undefined) return
    const current = editor.state.doc.nodeAt(pos)
    if (!current) return
    const nextText = writeFrontmatter(current.textContent, { ...readFrontmatter(current.textContent).config, ...patch })
    editor.view.dispatch(editor.state.tr.insertText(nextText, pos + 1, pos + 1 + current.content.size))
  }
  const focusSource = () => {
    flushSync(() => setTab('source'))
    const pos = typeof getPos === 'function' ? getPos() : undefined
    if (pos === undefined) return
    const end = pos + (editor.state.doc.nodeAt(pos)?.nodeSize ?? node.nodeSize) - 1
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)).scrollIntoView())
    editor.view.focus()
  }
  const showSource = !isMermaid || tab === 'source'
  return (
    <NodeViewWrapper className={`code-block ${isMermaid ? 'mermaid-block' : ''} ${isMermaid && tab === 'diagram' ? 'showing-diagram' : ''}`}>
      <div className="code-block-head" contentEditable={false}>
        {isMermaid && editable && (
          <div className="diagram-tuning" aria-label="Diagram tuning">
            <select value={tuning.theme ?? 'default'} aria-label="Theme" title="Theme (front matter config.theme)" onChange={e => retune({ theme: e.target.value })}>{THEMES.map(t => <option key={t} value={t}>{t === 'default' ? 'theme' : t}</option>)}</select>
            <select value={tuning.look ?? 'default'} aria-label="Look" title="Look (front matter config.look)" onChange={e => retune({ look: e.target.value })}>{LOOKS.map(([v, l]) => <option key={v} value={v}>{v === 'default' ? 'look' : l}</option>)}</select>
            {LAYOUTS[kind].length > 0 && <select value={tuning.layout ?? 'default'} aria-label="Layout" title="Layout engine (front matter config.layout)" onChange={e => retune({ layout: e.target.value })}>{LAYOUTS[kind].map(([v, l]) => <option key={v} value={v}>{v === 'default' ? 'layout' : l}</option>)}</select>}
          </div>
        )}
        {isMermaid && editable && (
          <div className="code-tabs" role="tablist" aria-label="Diagram view">
            <button role="tab" aria-selected={tab === 'diagram'} className={tab === 'diagram' ? 'on' : ''} onMouseDown={e => e.preventDefault()} onClick={() => setTab('diagram')} disabled={!hasSource}>Diagram</button>
            <button role="tab" aria-selected={tab === 'source'} className={tab === 'source' ? 'on' : ''} onMouseDown={e => e.preventDefault()} onClick={focusSource}>Source</button>
          </div>
        )}
        <select value={language} aria-label="Language" disabled={!editable} onChange={e => updateAttributes({ language: e.target.value || null })}>
          <option value="">plain</option>
          {['mermaid', 'bash', 'json', 'yaml', 'typescript', 'javascript', 'python', 'go', 'rust', 'csharp', 'sql', 'html', 'css', 'markdown'].map(l => <option key={l} value={l}>{l === 'mermaid' ? 'mermaid diagram' : l}</option>)}
        </select>
      </div>
      <pre className="code-block-source" hidden={isMermaid && (!showSource || !editable)}><NodeViewContent as={'code' as never} /></pre>
      {isMermaid && (tab === 'diagram' || !editable) && <div onDoubleClick={editable ? focusSource : undefined} title={editable ? 'Double-click to edit the source' : undefined}><MermaidPreview source={node.textContent} onAsk={editable ? () => window.dispatchEvent(new CustomEvent('notebook:ask', { detail: { blockId: node.attrs.id, label: 'This diagram' } })) : undefined} /></div>}
    </NodeViewWrapper>
  )
}

export const NotebookCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView, {
      // Tabs, the language select and the diagram are ours; keep ProseMirror from treating clicks on them as caret placement.
      stopEvent: ({ event }) => Boolean((event.target as HTMLElement | null)?.closest?.('.code-block-head, .mermaid-preview')),
    })
  },
})
