import { useEffect, useRef, useState } from 'react'
import CodeBlock from '@tiptap/extension-code-block'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'

let mermaidModule: Promise<typeof import('mermaid')['default']> | undefined
function loadMermaid() {
  mermaidModule ??= import('mermaid').then(m => { m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: '"Noto Sans", sans-serif' }); return m.default })
  return mermaidModule
}
let counter = 0

export function MermaidPreview({ source }: { source: string }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const id = useRef('mermaid-' + (++counter))
  useEffect(() => {
    if (!source.trim()) { setSvg(''); setError(''); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid()
        const result = await mermaid.render(id.current + '-' + Date.now().toString(36), source)
        if (!cancelled) { setSvg(result.svg); setError('') }
      } catch (e) {
        if (!cancelled) setError((e as Error).message.split('\n')[0] || 'Diagram could not be rendered')
        document.getElementById('d' + id.current)?.remove()
      }
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [source])
  if (!source.trim()) return <div className="mermaid-preview empty">Type a Mermaid diagram above to preview it here.</div>
  return (
    <div className={`mermaid-preview ${error ? 'has-error' : ''}`} contentEditable={false}>
      {svg && <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
      {error && <div className="mermaid-error">{error}</div>}
    </div>
  )
}

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const language = (node.attrs.language as string | null) ?? ''
  const isMermaid = language === 'mermaid'
  return (
    <NodeViewWrapper className={`code-block ${isMermaid ? 'mermaid-block' : ''}`}>
      <div className="code-block-head" contentEditable={false}>
        <select value={language} aria-label="Language" disabled={!editor.isEditable} onChange={e => updateAttributes({ language: e.target.value || null })}>
          <option value="">plain</option>
          {['mermaid', 'bash', 'json', 'yaml', 'typescript', 'javascript', 'python', 'go', 'rust', 'csharp', 'sql', 'html', 'css', 'markdown'].map(l => <option key={l} value={l}>{l === 'mermaid' ? 'mermaid diagram' : l}</option>)}
        </select>
      </div>
      <pre className="code-block-source"><NodeViewContent as={'code' as never} /></pre>
      {isMermaid && <MermaidPreview source={node.textContent} />}
    </NodeViewWrapper>
  )
}

export const NotebookCodeBlock = CodeBlock.extend({
  addNodeView() { return ReactNodeViewRenderer(CodeBlockView) },
})
