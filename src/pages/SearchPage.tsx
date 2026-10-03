import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import { api } from '../api'
import type { SearchResult } from '../types'

/** ts_headline marks matches with <b>; everything else is escaped so snippets are safe to render. */
export function snippetHtml(snippet: string) {
  const escaped = snippet.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
  return escaped.replace(/&lt;(\/?)(b|mark)&gt;/gi, '<$1mark>')
}
export function SearchPage() {
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''
  const [results, setResults] = useState<SearchResult[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    setResults(undefined); setError('')
    if (!q.trim()) { setResults([]); return }
    api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=50`).then(r => { if (!cancelled) setResults(r.results ?? []) }).catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [q])
  return (
    <main className="listing">
      <h1 className="page-title"><Search size={20} aria-hidden /> Search</h1>
      <p className="caption">{results ? `${results.length} ${results.length === 1 ? 'result' : 'results'} for “${q}”` : 'Searching…'}</p>
      {error && <p className="gate-error" role="alert">{error}</p>}
      <div className="result-list">
        {results?.map(r => (
          <Link key={r.id} className="result" to={`/d/${r.id}`}>
            <span className="result-title">{r.title}</span>
            {r.snippet && <span className="result-snippet" dangerouslySetInnerHTML={{ __html: snippetHtml(r.snippet) }} />}
            <span className="caption">{r.folder !== '/' ? r.folder + ' · ' : ''}{new Date(r.updatedAt).toLocaleDateString()}{r.tags?.length ? ' · ' + r.tags.map(t => '#' + t).join(' ') : ''}</span>
          </Link>
        ))}
        {results && !results.length && q && <p className="caption">No documents match. Try fewer words, or a tag from the library.</p>}
      </div>
    </main>
  )
}
