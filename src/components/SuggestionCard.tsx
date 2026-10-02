import { useEffect, useRef, useState } from 'react'
import type { Proposal, Session } from '../types'
import { DiffView } from './DiffView'

type Props = {
  proposal: Proposal
  session?: Session
  busy: boolean
  onAccept: (proposal: Proposal, edited: string) => Promise<void>
  onReject: (proposal: Proposal) => Promise<void>
  onReconsider: (proposal: Proposal, note: string) => Promise<void>
}

export function SuggestionCard({ proposal, session, busy, onAccept, onReject, onReconsider }: Props) {
  const [mode, setMode] = useState<'view' | 'edit' | 'reconsider'>('view')
  const [draft, setDraft] = useState(proposal.type === 'insert' ? proposal.markdown ?? '' : proposal.after ?? '')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (mode !== 'view') textarea.current?.focus() }, [mode])
  const edited = proposal.type === 'insert' ? draft !== (proposal.markdown ?? '') : draft !== (proposal.after ?? '')
  const run = (fn: () => Promise<void>) => fn().catch(e => setError(e.message))
  const who = session?.name ?? 'Claude'
  const kind = proposal.stale ? 'Paragraph changed' : proposal.type === 'insert' ? 'Suggested addition' : 'Suggested edit'

  return (
    <aside className={`suggestion ${proposal.type} ${proposal.stale ? 'stale' : ''}`} aria-label={kind} onKeyDown={e => { if (e.key === 'Escape' && mode !== 'view') { e.stopPropagation(); setMode('view') } }}>
      <header className="suggestion-head">
        <span className="suggestion-kind">{kind}</span>
        <span className="suggestion-who">{who}</span>
      </header>
      {proposal.stale ? (
        <p className="suggestion-text">You changed this part of the document after the suggestion was written, so it no longer applies.</p>
      ) : mode === 'edit' || (proposal.type === 'insert' && mode === 'view') ? (
        <textarea ref={textarea} className="suggestion-editor" value={draft} rows={Math.min(14, Math.max(2, draft.split('\n').length + 1))} onChange={e => setDraft(e.target.value)} aria-label="Proposed text" spellCheck />
      ) : (
        <DiffView before={proposal.before ?? ''} after={proposal.after ?? ''} />
      )}
      {proposal.explanation && !proposal.stale && <p className="suggestion-why">{proposal.explanation}</p>}
      {mode === 'reconsider' && !proposal.stale && (
        <form className="reconsider" onSubmit={e => { e.preventDefault(); if (note.trim()) run(() => onReconsider(proposal, note.trim())) }}>
          <textarea ref={textarea} value={note} rows={2} placeholder={`Tell ${who} what to change…`} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (note.trim()) run(() => onReconsider(proposal, note.trim())) } }} aria-label="Note for the agent" />
          <div className="suggestion-actions">
            <button type="submit" className="primary small" disabled={busy || !note.trim()}>Send note</button>
            <button type="button" className="quiet small" onClick={() => setMode('view')}>Back</button>
          </div>
        </form>
      )}
      {mode !== 'reconsider' && (
        <div className="suggestion-actions">
          {proposal.stale ? (
            <button className="quiet small" disabled={busy} onClick={() => run(() => onReject(proposal))}>Dismiss</button>
          ) : (
            <>
              <button className="primary small" disabled={busy || (proposal.type === 'insert' && !draft.trim())} onClick={() => run(() => onAccept(proposal, draft))}>{edited ? 'Accept edited' : 'Accept'}<kbd>⌘↵</kbd></button>
              <button className="quiet small" disabled={busy} onClick={() => run(() => onReject(proposal))}>Reject</button>
              <button className="quiet small" disabled={busy} onClick={() => { setNote(''); setMode('reconsider') }}>Reconsider…</button>
              {proposal.type === 'replace' && mode === 'view' && <button className="quiet small ghost" disabled={busy} onClick={() => setMode('edit')}>Edit</button>}
              {proposal.type === 'replace' && mode === 'edit' && <button className="quiet small ghost" onClick={() => { setDraft(proposal.after ?? ''); setMode('view') }}>Show diff</button>}
            </>
          )}
        </div>
      )}
      {error && <p className="suggestion-error" role="alert">{error}</p>}
    </aside>
  )
}
