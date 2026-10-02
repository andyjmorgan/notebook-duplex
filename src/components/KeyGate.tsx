import { useState } from 'react'
export function KeyGate({ onSubmit, error }: { onSubmit: (key: string) => Promise<void>; error?: string }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <main className="gate">
      <form className="gate-card" onSubmit={async e => { e.preventDefault(); setBusy(true); try { await onSubmit(value.trim()) } finally { setBusy(false) } }}>
        <span className="logo large" aria-hidden>N</span>
        <h1>Notebook Duplex</h1>
        <p>A shared notebook for you and your Claude session. Enter the notebook key to open it.</p>
        <input type="password" autoFocus value={value} onChange={e => setValue(e.target.value)} placeholder="Notebook key" aria-label="Notebook key" autoComplete="current-password" />
        <button className="primary" type="submit" disabled={!value.trim() || busy}>{busy ? 'Opening…' : 'Open notebook'}</button>
        {error && <p className="gate-error" role="alert">{error}</p>}
      </form>
    </main>
  )
}
