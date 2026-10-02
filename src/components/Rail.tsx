import { useState } from 'react'
import type { Activity, Job, Proposal, Session } from '../types'

type Props = {
  sessions: Session[]; sessionId: string; onSession: (id: string) => void
  jobs: Job[]; activity: Activity[]; proposals: Proposal[]
  mcpUrl: string; apiKey: string
  proofread: boolean; onProofread: (on: boolean) => void
  onAsk: () => void; onDirective: () => void; onDemo: () => void; onCancel: (id: string) => Promise<void>; onLocate: (proposal: Proposal) => void
  onNotify: (message: string) => void
}
const active = (j: Job) => ['queued', 'running', 'needs_permission'].includes(j.status)
const stateVerb: Record<string, string> = { reading: 'Reading', thinking: 'Thinking', writing: 'Writing', waiting: 'Waiting on you', done: 'Finishing' }
const statusLabel: Record<string, string> = { queued: 'Queued', needs_permission: 'Needs permission in Claude\'s terminal', abandoned: 'Abandoned' }

export function Rail({ sessions, sessionId, onSession, jobs, activity, proposals, mcpUrl, apiKey, proofread, onProofread, onAsk, onDirective, onDemo, onCancel, onLocate, onNotify }: Props) {
  const [showKey, setShowKey] = useState(false)
  const connected = sessions.filter(s => s.connected)
  const current = connected.find(s => s.id === sessionId)
  const live = jobs.filter(active)
  const recent = [...jobs].filter(j => !active(j)).reverse().slice(0, 6)
  const pending = proposals.filter(p => p.status === 'pending')
  const origin = mcpUrl.replace(/\/mcp$/, '')
  const command = `claude mcp add --transport stdio --scope user notebook-duplex -- node <checkout>/agent/channel.mjs --url ${origin} --key ${showKey ? apiKey : '<notebook key>'}`
  const copy = async (text: string, label: string) => { try { await navigator.clipboard.writeText(text); onNotify(label) } catch { onNotify('Copy failed. Select the text instead.') } }
  return (
    <aside className="rail" aria-label="Collaboration">
      <section className="rail-section">
        <div className="rail-heading"><span className="eyebrow">COLLABORATOR</span></div>
        {connected.length ? (
          <>
            <label className="field-label" htmlFor="session">Claude session</label>
            <select id="session" value={sessionId} onChange={e => onSession(e.target.value)}>
              {connected.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <p className="repo">{current?.repo || 'Working directory not reported yet'}</p>
          </>
        ) : (
          <p className="rail-muted">No Claude session connected. Open <strong>Connect</strong> below to add this notebook to a session.</p>
        )}
        <div className="agent-actions">
          <button className="primary" onClick={onAsk} disabled={!connected.length}>✦ Ask<kbd>⌘K</kbd></button>
          <button className="quiet" onClick={onDirective} disabled={!connected.length} title="Run the [tk: …] directive in the current paragraph">Run [tk]</button>
        </div>
        <label className="proofreading"><input type="checkbox" checked={proofread} disabled={!connected.length} onChange={e => onProofread(e.target.checked)} /> Proofread settled paragraphs <span className="beta">EXPERIMENTAL</span></label>
      </section>

      <section className="rail-section">
        <div className="section-label"><span>Working</span><span>{live.length}</span></div>
        {live.length ? live.map(j => {
          const a = activity.find(x => x.jobId === j.id)
          const alive = sessions.some(s => s.id === j.sessionId && s.connected)
          return (
            <article key={j.id} className={`job ${j.status} ${alive ? '' : 'orphaned'}`}>
              <div className="job-top">
                <span className={`job-status ${j.status}`}>{j.status === 'needs_permission' ? statusLabel.needs_permission : a ? stateVerb[a.state] : statusLabel[j.status] ?? j.status.replace('_', ' ')}</span>
                {!alive && <span className="proofread-tag" title="The session that took this job is no longer connected. A session with the same name will pick it up; otherwise it expires.">session offline</span>}
                {j.kind === 'proofread' && <span className="proofread-tag">proofread</span>}
                <button className="quiet cancel" onClick={() => void onCancel(j.id)}>Cancel</button>
              </div>
              <p>{j.instruction.split('\n')[0]}</p>
              {a?.message && <small>{a.message}</small>}
              {a && <div className="progress" aria-hidden><span style={{ width: a.progress != null ? a.progress + '%' : undefined }} className={a.progress == null ? 'indeterminate' : ''} /></div>}
              {j.message && j.status === 'needs_permission' && <small>{j.message}</small>}
              {j.status === 'needs_permission' && <small>Approve or deny the tool prompt in that Claude session, or cancel here.</small>}
            </article>
          )
        }) : <p className="rail-muted small">Nothing in flight. Keep writing.</p>}
      </section>

      <section className="rail-section">
        <div className="section-label"><span>To review</span><span>{pending.length}</span></div>
        {pending.length ? pending.map(p => (
          <button key={p.id} className="review-link" onClick={() => onLocate(p)}>
            <span className={`review-dot ${p.stale ? 'stale' : p.type}`} />
            <span className="review-text">{p.type === 'comment' ? 'Comment · ' : p.stale ? 'Changed · ' : p.type === 'insert' ? 'Addition · ' : p.type === 'move' ? 'Move · ' : p.type === 'replace_text' ? `Replace ${p.count}× · ` : 'Edit · '}{(p.type === 'replace_text' ? `${p.find} → ${p.replace}` : p.text || p.explanation || p.after || p.markdown || p.preview?.[0] || '').split('\n')[0]}</span>
            <span className="review-go">↗</span>
          </button>
        )) : <p className="rail-muted small">Suggestions appear inside the document, right where they apply.</p>}
      </section>

      {recent.length > 0 && (
        <section className="rail-section">
          <div className="section-label"><span>Recent</span></div>
          {recent.map(j => <div key={j.id} className="recent" title={j.message ?? ''}><span className={`job-status ${j.status}`}>{j.status.replace('_', ' ')}</span><span>{j.instruction.split('\n')[0]}</span></div>)}
        </section>
      )}

      <details className="setup">
        <summary>Connect a Claude session</summary>
        <p>Claude Code channels run as a local stdio process. Clone the repo once, register its <code>agent/channel.mjs</code> shim (it proxies to this server), then launch with the channel enabled:</p>
        <pre><code>{command}{'\n'}claude --dangerously-load-development-channels server:notebook-duplex</code></pre>
        <div className="setup-actions">
          <button className="quiet small" onClick={() => copy(command.replace('<notebook key>', apiKey) + '\nclaude --dangerously-load-development-channels server:notebook-duplex', 'Commands copied with your key. Replace <checkout> with your clone path.')}>Copy with key</button>
          <button className="quiet small ghost" onClick={() => setShowKey(v => !v)}>{showKey ? 'Hide key' : 'Show key'}</button>
        </div>
        <p>Claude proposes; only you accept. Tool permissions stay in Claude's terminal.</p>
      </details>
      <button className="test-button" onClick={onDemo}>Try a local test suggestion</button>
      <p className="test-caption">No agent involved. Exercises accept, reject and reconsider on the current paragraph.</p>
    </aside>
  )
}
