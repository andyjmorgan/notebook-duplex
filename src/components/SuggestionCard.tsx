import { useEffect, useRef, useState } from 'react'
import type { Proposal, Session } from '../types'
import { DiffView, TableDiff } from './DiffView'
import { MarkdownPreview } from './MarkdownPreview'

type Props = {
  proposal: Proposal
  session?: Session
  busy: boolean
  parseMarkdown: (markdown: string) => any[]
  onAccept: (proposal: Proposal, edited: string) => Promise<void>
  onReject: (proposal: Proposal) => Promise<void>
  onReconsider: (proposal: Proposal, note: string) => Promise<void>
  onResolve: (proposal: Proposal) => Promise<void>
  onReply: (proposal: Proposal, note: string) => Promise<void>
}

export function SuggestionCard({ proposal, session, busy, parseMarkdown, onAccept, onReject, onReconsider, onResolve, onReply }: Props) {
  const [mode, setMode] = useState<'view' | 'edit' | 'reconsider' | 'preview'>(proposal.type === 'insert' ? 'preview' : 'view')
  const [draft, setDraft] = useState(proposal.type === 'insert' ? proposal.markdown ?? '' : proposal.after ?? '')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (mode !== 'view') textarea.current?.focus() }, [mode])
  const edited = proposal.type === 'insert' ? draft !== (proposal.markdown ?? '') : draft !== (proposal.after ?? '')
  const run = (fn: () => Promise<void>) => fn().catch(e => setError(e.message))
  const who = session?.name ?? 'Claude'
  const removal = proposal.type === 'replace' && (proposal.after ?? '') === ''
  const kind = proposal.type === 'comment' ? (proposal.stale ? 'Comment · section removed' : 'Comment') : proposal.stale ? (proposal.blockType === 'table' ? 'Table changed' : 'Paragraph changed') : proposal.type === 'insert' ? 'Suggested addition' : removal ? 'Suggested removal' : proposal.blockType === 'table' ? 'Suggested table edit' : 'Suggested edit'

  if (proposal.type === 'comment') {
    return (
      <aside className={`suggestion comment ${proposal.stale ? 'stale' : ''}`} aria-label="Comment" onKeyDown={e => { if (e.key === 'Escape' && mode !== 'view') { e.stopPropagation(); setMode('view') } }}>
        <header className="suggestion-head"><span className="suggestion-kind">{kind}</span><span className="suggestion-who">{who}</span></header>
        <MarkdownPreview markdown={proposal.text ?? ''} parse={parseMarkdown} />
        {mode === 'reconsider' ? (
          <form className="reconsider" onSubmit={e => { e.preventDefault(); if (note.trim()) run(() => onReply(proposal, note.trim())) }}>
            <textarea ref={textarea} value={note} rows={2} placeholder={`Reply to ${who}…`} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (note.trim()) run(() => onReply(proposal, note.trim())) } }} aria-label="Reply" />
            <div className="suggestion-actions"><button type="submit" className="primary small" disabled={busy || !note.trim()}>Send reply</button><button type="button" className="quiet small" onClick={() => setMode('view')}>Back</button></div>
          </form>
        ) : (
          <div className="suggestion-actions">
            <button className="primary small" disabled={busy} onClick={() => run(() => onResolve(proposal))}>Resolve</button>
            <button className="quiet small" disabled={busy} onClick={() => { setNote(''); setMode('reconsider') }}>Reply…</button>
          </div>
        )}
        {error && <p className="suggestion-error" role="alert">{error}</p>}
      </aside>
    )
  }

  return (
    <aside className={`suggestion ${proposal.type} ${proposal.stale ? 'stale' : ''} ${removal ? 'removal' : ''}`} aria-label={kind} onKeyDown={e => { if (e.key === 'Escape' && mode !== 'view') { e.stopPropagation(); setMode('view') } }}>
      <header className="suggestion-head">
        <span className="suggestion-kind">{kind}</span>
        <span className="suggestion-who">{who}</span>
      </header>
      {proposal.stale ? (
        <p className="suggestion-text">You changed this part of the document after the suggestion was written, so it no longer applies.</p>
      ) : mode === 'preview' ? (
        <MarkdownPreview markdown={draft} parse={parseMarkdown} inline={proposal.type === 'replace' && proposal.blockType !== 'table'} />
      ) : mode === 'edit' || (proposal.type === 'insert' && mode === 'view') ? (
        <textarea ref={textarea} className="suggestion-editor" value={draft} rows={Math.min(14, Math.max(2, draft.split('\n').length + 1))} onChange={e => setDraft(e.target.value)} aria-label="Proposed text" spellCheck />
      ) : proposal.blockType === 'table' ? (
        <TableDiff before={proposal.before ?? ''} after={proposal.after ?? ''} />
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
              <button className="primary small" disabled={busy || (proposal.type === 'insert' && !draft.trim())} onClick={() => run(() => onAccept(proposal, draft))}>{edited ? 'Accept edited' : removal ? 'Remove' : 'Accept'}<kbd>⌘↵</kbd></button>
              <button className="quiet small" disabled={busy} onClick={() => run(() => onReject(proposal))}>Reject</button>
              <button className="quiet small" disabled={busy} onClick={() => { setNote(''); setMode('reconsider') }}>Reconsider…</button>
              {proposal.type === 'insert' && <span className="view-tabs"><button className={`quiet small ${mode === 'preview' ? 'on' : ''}`} onClick={() => setMode('preview')}>Preview</button><button className={`quiet small ${mode !== 'preview' ? 'on' : ''}`} onClick={() => setMode('edit')}>Edit</button></span>}
              {proposal.type === 'replace' && !removal && <span className="view-tabs">
                <button className={`quiet small ${mode === 'view' ? 'on' : ''}`} onClick={() => setMode('view')}>Diff</button>
                <button className={`quiet small ${mode === 'preview' ? 'on' : ''}`} onClick={() => setMode('preview')}>Preview</button>
                <button className={`quiet small ${mode === 'edit' ? 'on' : ''}`} disabled={busy} onClick={() => setMode('edit')}>Edit</button>
              </span>}
            </>
          )}
        </div>
      )}
      {error && <p className="suggestion-error" role="alert">{error}</p>}
    </aside>
  )
}
