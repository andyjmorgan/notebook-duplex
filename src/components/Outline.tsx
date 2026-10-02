export type Heading = { id: string; text: string; level: number; pos: number }
export function Outline({ headings, onJump, words }: { headings: Heading[]; onJump: (pos: number) => void; words: number }) {
  return (
    <nav className="outline" aria-label="Contents">
      <div className="outline-title">Contents</div>
      <div id="toc">
        {headings.length ? headings.map(h => <button key={h.id || 'pos-' + h.pos} data-position={h.pos} style={{ paddingLeft: (h.level - 1) * 12 + 12 }} onClick={() => onJump(h.pos)}>{h.text || 'Untitled section'}</button>) : <p>Add headings to build an outline.</p>}
      </div>
      <div className="outline-note">{words} words<br />Saved as you type.</div>
    </nav>
  )
}
