import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react'
import { api, apiDelete } from '../api'
import type { AccessToken } from '../types'

export const mcpAddCommand = (token: string, origin = location.origin) => `claude mcp add --transport stdio --scope user notebook-duplex -- node <checkout>/agent/channel.mjs --url ${origin} --token ${token}`

async function copyText(text: string, label: string) {
  try { await navigator.clipboard.writeText(text); toast.success(label) } catch { toast.error('Copy failed. Select the text instead.') }
}

/** Personal access tokens for Claude sessions: list, mint (shown once), revoke. */
export default function TokensPage() {
  const [tokens, setTokens] = useState<AccessToken[]>()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fresh, setFresh] = useState<{ id: string; name: string; token: string }>()
  const [copied, setCopied] = useState<'token' | 'command' | ''>('')
  const load = () => api<AccessToken[]>('/api/tokens').then(t => setTokens(Array.isArray(t) ? t : [])).catch(e => setError(e.message))
  useEffect(() => { void load() }, [])
  const create = async () => {
    if (!name.trim() || busy) return
    setBusy(true); setError('')
    try { const t = await api<{ id: string; name: string; token: string }>('/api/tokens', { name: name.trim() }); setFresh(t); setName(''); setCopied(''); void load() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const revoke = async (t: AccessToken) => {
    if (!confirm(`Revoke “${t.name}”? Claude sessions using it stop working immediately.`)) return
    try { await apiDelete(`/api/tokens/${encodeURIComponent(t.id)}`); if (fresh?.id === t.id) setFresh(undefined); toast(`Revoked ${t.name}.`); void load() } catch (e) { toast.error((e as Error).message) }
  }
  const copy = async (what: 'token' | 'command') => { if (!fresh) return; await copyText(what === 'token' ? fresh.token : mcpAddCommand(fresh.token), what === 'token' ? 'Token copied.' : 'Command copied. Replace <checkout> with your clone path.'); setCopied(what) }
  return (
    <main className="settings">
      <h1 className="page-title"><KeyRound size={20} aria-hidden /> Agent access tokens</h1>
      <p className="settings-lead">A Claude Code session connects to this library with a personal token. Each token is shown once, stored hashed, and every job records which account asked. Revoke a token to disconnect anything using it.</p>

      <section className="card">
        <h2>Create a token</h2>
        <form className="token-form" onSubmit={e => { e.preventDefault(); void create() }}>
          <input value={name} placeholder="Name, e.g. laptop · notebook-duplex" aria-label="Token name" onChange={e => setName(e.target.value)} />
          <button type="submit" className="primary" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create token'}</button>
        </form>
        {error && <p className="gate-error" role="alert">{error}</p>}
        {fresh && (
          <div className="fresh-token" role="status">
            <p><strong>{fresh.name}</strong> is ready. Copy it now; it will not be shown again.</p>
            <div className="token-row"><code className="token-value" data-testid="fresh-token">{fresh.token}</code><button className="quiet small" onClick={() => void copy('token')}>{copied === 'token' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} Copy token</button></div>
            <p className="caption">Register the shim once, then launch Claude with the channel enabled:</p>
            <pre className="command"><code>{mcpAddCommand(fresh.token)}{'\n'}claude --dangerously-load-development-channels server:notebook-duplex</code></pre>
            <div className="setup-actions"><button className="quiet small" onClick={() => void copy('command')}>{copied === 'command' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} Copy command</button></div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Your tokens</h2>
        {!tokens ? <p className="caption">Loading…</p> : !tokens.length ? <p className="caption">No tokens yet.</p> : (
          <table className="token-table">
            <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {tokens.map(t => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td><code>{t.prefix}…</code></td>
                  <td>{new Date(t.createdAt).toLocaleDateString()}</td>
                  <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'Never'}</td>
                  <td><button className="quiet small danger" onClick={() => void revoke(t)}><Trash2 size={14} aria-hidden /> Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}
