import { useMemo } from 'react'
import { diffWords } from '../../shared/diff.mjs'
export function DiffView({ before, after }: { before: string; after: string }) {
  const segments = useMemo(() => diffWords(before, after) as { type: 'equal' | 'del' | 'ins'; text: string }[], [before, after])
  if (!before) return <p className="diff-line"><ins>{after || '(empty paragraph)'}</ins></p>
  if (!after) return <p className="diff-line"><del>{before}</del> <span className="diff-note">removes this paragraph</span></p>
  return <p className="diff-line">{segments.map((s, i) => s.type === 'equal' ? <span key={i}>{s.text}</span> : s.type === 'del' ? <del key={i}>{s.text}</del> : <ins key={i}>{s.text}</ins>)}</p>
}

function parseTable(markdown: string): string[][] {
  const lines = markdown.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('|'))
  const rows = lines.filter(l => !/^\|(\s*:?-{3,}:?\s*\|)+$/.test(l)).map(l => l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|')))
  const width = Math.max(0, ...rows.map(r => r.length))
  return rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''))
}
export function TableDiff({ before, after }: { before: string; after: string }) {
  const a = useMemo(() => parseTable(before), [before]), b = useMemo(() => parseTable(after), [after])
  const rows = Math.max(a.length, b.length), cols = Math.max(a[0]?.length ?? 0, b[0]?.length ?? 0)
  return (
    <div className="table-diff-wrap">
      <table className="table-diff">
        <tbody>
          {Array.from({ length: rows }, (_, r) => {
            const removed = r >= b.length, added = r >= a.length
            return (
              <tr key={r} className={removed ? 'row-del' : added ? 'row-ins' : ''}>
                {Array.from({ length: cols }, (_, c) => {
                  const x = a[r]?.[c] ?? '', y = b[r]?.[c] ?? ''
                  const colRemoved = c >= (b[0]?.length ?? 0), colAdded = c >= (a[0]?.length ?? 0)
                  const Cell = r === 0 ? 'th' : 'td'
                  const cls = removed || colRemoved ? 'cell-del' : added || colAdded ? 'cell-ins' : x !== y ? 'cell-changed' : ''
                  return <Cell key={c} className={cls}>{removed || colRemoved ? <del>{x}</del> : added || colAdded ? <ins>{y}</ins> : x === y ? x : <DiffView before={x} after={y} />}</Cell>
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
