import { Link } from 'react-router-dom'
import { ArrowUpRight, Link2, Tags } from 'lucide-react'
import type { DocumentMeta } from '../types'

/** End-of-document panel: documents sharing a tag, and documents that link here. */
export function RelatedPanel({ meta }: { meta: DocumentMeta | undefined }) {
  const related = meta?.related ?? []
  const backlinks = meta?.links?.in ?? []
  if (!related.length && !backlinks.length) return null
  return (
    <section className="related" aria-label="Related documents">
      {related.length > 0 && (
        <div className="related-group">
          <div className="section-label"><span><Tags size={12} aria-hidden /> Related</span><span>{related.length}</span></div>
          {related.map(r => <Link key={r.id} className="related-link" to={`/d/${r.id}`}><span className="related-title">{r.title}</span><span className="caption">{r.sharedTags.map(t => '#' + t).join(' ')}</span><ArrowUpRight size={14} aria-hidden /></Link>)}
        </div>
      )}
      {backlinks.length > 0 && (
        <div className="related-group">
          <div className="section-label"><span><Link2 size={12} aria-hidden /> Linked from</span><span>{backlinks.length}</span></div>
          {backlinks.map(b => <Link key={b.id} className="related-link" to={`/d/${b.id}`}><span className="related-title">{b.title}</span>{b.folder && b.folder !== '/' && <span className="caption">{b.folder}</span>}<ArrowUpRight size={14} aria-hidden /></Link>)}
        </div>
      )}
    </section>
  )
}
