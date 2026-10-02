import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { TextSelection } from '@tiptap/pm/state'
import CodeBlock from '@tiptap/extension-code-block'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'

let mermaidModule: Promise<typeof import('mermaid')['default']> | undefined
function loadMermaid() {
  mermaidModule ??= import('mermaid').then(m => { m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: '"Noto Sans", sans-serif', fontSize: 15, flowchart: { padding: 12, nodeSpacing: 40, rankSpacing: 50 } }); return m.default })
  return mermaidModule
}
let counter = 0

export function MermaidPreview({ source }: { source: string }) {
  const [svg, setSvg] = useState('')
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
        const result = await mermaid.render(id.current + '-' + Date.now().toString(36), source)
        if (!cancelled) { setSvg(result.svg); setError('') }
      } catch (e) {
        const message = (e as Error).message ?? ''
        if (/dynamically imported module|Failed to fetch|Loading chunk|import\(/i.test(message)) window.dispatchEvent(new Event('notebook:chunk-failed'))
        if (!cancelled) setError(message.split('\n')[0] || 'Diagram could not be rendered')
        document.getElementById('d' + id.current)?.remove()
      }
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [source])
  if (!source.trim()) return <div className="mermaid-preview empty">Type a Mermaid diagram above to preview it here.</div>
  return (
    <div className={`mermaid-preview ${error ? 'has-error' : ''}`} contentEditable={false}>
      {svg && <div ref={host} className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
      {error && <div className="mermaid-error">{error}</div>}
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
      {isMermaid && (tab === 'diagram' || !editable) && <div onDoubleClick={editable ? focusSource : undefined} title={editable ? 'Double-click to edit the source' : undefined}><MermaidPreview source={node.textContent} /></div>}
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
