import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Hash } from 'lucide-react'
import { api } from '../api'
import type { DocumentSummary } from '../types'

export function TagPage() {
  const { tag = '' } = useParams()
  const [docs, setDocs] = useState<DocumentSummary[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    setDocs(undefined); setError('')
    api<DocumentSummary[] | { documents: DocumentSummary[] }>(`/api/tags/${encodeURIComponent(tag)}`).then(r => { if (!cancelled) setDocs(Array.isArray(r) ? r : r.documents ?? []) }).catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [tag])
  return (
    <main className="listing">
      <h1 className="page-title"><Hash size={20} aria-hidden /> {tag}</h1>
      <p className="caption">{docs ? `${docs.length} ${docs.length === 1 ? 'document' : 'documents'} tagged ${tag}` : 'Loading…'}</p>
      {error && <p className="gate-error" role="alert">{error}</p>}
      <div className="result-list">
        {docs?.map(d => (
          <Link key={d.id} className="result" to={`/d/${d.id}`}>
            <span className="result-title">{d.title}</span>
            <span className="caption">{d.folder !== '/' ? d.folder + ' · ' : ''}{d.wordCount} words · {new Date(d.updatedAt).toLocaleDateString()}</span>
            {d.tags?.length > 0 && <span className="result-tags">{d.tags.map(t => <span key={t} className={`tag-chip ${t === tag ? 'on' : ''}`}>#{t}</span>)}</span>}
          </Link>
        ))}
        {docs && !docs.length && <p className="caption">Nothing carries this tag any more.</p>}
      </div>
    </main>
  )
}
