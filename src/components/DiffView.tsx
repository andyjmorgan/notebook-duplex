import { useMemo } from 'react'
import { diffWords } from '../../shared/diff.mjs'
export function DiffView({ before, after }: { before: string; after: string }) {
  const segments = useMemo(() => diffWords(before, after) as { type: 'equal' | 'del' | 'ins'; text: string }[], [before, after])
  if (!before) return <p className="diff-line"><ins>{after || '(empty paragraph)'}</ins></p>
  if (!after) return <p className="diff-line"><del>{before}</del> <span className="diff-note">removes this paragraph</span></p>
  return <p className="diff-line">{segments.map((s, i) => s.type === 'equal' ? <span key={i}>{s.text}</span> : s.type === 'del' ? <del key={i}>{s.text}</del> : <ins key={i}>{s.text}</ins>)}</p>
}
