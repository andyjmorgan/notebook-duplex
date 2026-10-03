import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { FilePlus } from 'lucide-react'
import { lastOpened, useLibrary } from '../library'

/** `/` opens the last document you had open, else the first in the library, else offers to start one. */
export function Home() {
  const { library, loaded, error, createDocument } = useLibrary()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  if (!loaded) return <main className="empty-library" role="status"><p className="caption">Opening your library…</p></main>
  const docs = library?.documents ?? []
  const last = lastOpened.get()
  const target = docs.find(d => d.id === last) ?? docs[0]
  if (target) return <Navigate to={`/d/${target.id}`} replace />
  const start = async () => { setBusy(true); try { const doc = await createDocument({ title: 'Working notes' }); navigate(`/d/${doc.id}`) } finally { setBusy(false) } }
  return (
    <main className="empty-library">
      <div className="empty-card">
        <h1>Your library is empty</h1>
        <p>Start a document, or import a Markdown file from the toolbar once you have one open. Claude sessions you connect can also create documents here.</p>
        {error && <p className="gate-error" role="alert">{error}</p>}
        <button className="primary" disabled={busy} onClick={() => void start()}><FilePlus size={16} aria-hidden /> New document</button>
      </div>
    </main>
  )
}
