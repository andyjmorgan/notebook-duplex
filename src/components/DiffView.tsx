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

export function CodeDiff({ before, after }: { before: string; after: string }) {
  const segments = useMemo(() => {
    const a = before.split('\n'), b = after.split('\n')
    const n = a.length, m = b.length
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    const out: { type: 'equal' | 'del' | 'ins'; text: string }[] = []
    let i = 0, j = 0
    while (i < n && j < m) { if (a[i] === b[j]) { out.push({ type: 'equal', text: a[i] }); i++; j++ } else if (table[i + 1][j] >= table[i][j + 1]) out.push({ type: 'del', text: a[i++] }); else out.push({ type: 'ins', text: b[j++] }) }
    while (i < n) out.push({ type: 'del', text: a[i++] }); while (j < m) out.push({ type: 'ins', text: b[j++] })
    return out
  }, [before, after])
  return <pre className="code-diff">{segments.map((s, i) => <div key={i} className={`code-line ${s.type}`}><span className="gutter">{s.type === 'del' ? '−' : s.type === 'ins' ? '+' : ' '}</span>{s.text || ' '}</div>)}</pre>
}
