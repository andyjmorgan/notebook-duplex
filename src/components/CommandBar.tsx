import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Session } from '../types'

type Props = {
  open: boolean
  anchor: { top: number; left: number } | null
  initial: string
  scopeLabel: string
  sessions: Session[]
  sessionId: string
  onSessionChange: (id: string) => void
  onSubmit: (instruction: string, wholeDocument: boolean) => Promise<void>
  onClose: () => void
}

export function CommandBar({ open, anchor, initial, scopeLabel, sessions, sessionId, onSessionChange, onSubmit, onClose }: Props) {
  const [text, setText] = useState(initial)
  const [whole, setWhole] = useState(false)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (open) { setText(initial); setWhole(false); setError('') } }, [open, initial])
  useLayoutEffect(() => { if (open) input.current?.focus() }, [open])
  if (!open || !anchor) return null
  const connected = sessions.filter(s => s.connected)
  const send = async () => {
    if (!text.trim() || sending) return
    setSending(true); setError('')
    try { await onSubmit(text.trim(), whole) } catch (e) { setError((e as Error).message) } finally { setSending(false) }
  }
  return (
    <div className="command-bar" role="dialog" aria-label="Ask your agent" style={{ top: anchor.top, left: anchor.left }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }}>
      <div className="command-row">
        <span className="command-spark" aria-hidden>✦</span>
        <textarea ref={input} autoFocus value={text} rows={1} placeholder={connected.length ? 'Ask for a rewrite, a source, a counter-argument…' : 'Connect a Claude session to send commands'} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} aria-label="Command for the agent" />
        <button className="primary small" onClick={() => void send()} disabled={!text.trim() || !connected.length || sending}>{sending ? 'Sending…' : 'Send'}<kbd>↵</kbd></button>
      </div>
      <div className="command-meta">
        <div className="scope-toggle" role="radiogroup" aria-label="Scope">
          <button role="radio" aria-checked={!whole} className={!whole ? 'on' : ''} onClick={() => setWhole(false)}>{scopeLabel}</button>
          <button role="radio" aria-checked={whole} className={whole ? 'on' : ''} onClick={() => setWhole(true)}>Whole document</button>
        </div>
        {connected.length > 1 && (
          <select value={sessionId} onChange={e => onSessionChange(e.target.value)} aria-label="Claude session">{connected.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        )}
        {connected.length === 1 && <span className="command-session">→ {connected[0].name}</span>}
        <span className="command-hint"><kbd>esc</kbd> back to writing</span>
      </div>
      {error && <p className="command-error" role="alert">{error}</p>}
    </div>
  )
}
