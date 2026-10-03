import { auth } from '../auth'
import { ThemeToggle } from '../components/AppBar'
import { AppleIcon, GitHubIcon, GoogleIcon, MicrosoftIcon } from '../components/Brand'

const providers = [
  { id: 'google', name: 'Google', Icon: GoogleIcon },
  { id: 'github', name: 'GitHub', Icon: GitHubIcon },
  { id: 'microsoft', name: 'Microsoft', Icon: MicrosoftIcon },
  { id: 'apple', name: 'Apple', Icon: AppleIcon },
]

export function SignIn({ status, error }: { status: 'loading' | 'signed-out' | 'error'; error?: string }) {
  const returnTo = location.pathname + location.search
  return (
    <div className="gate">
      <div className="gate-corner"><ThemeToggle /></div>
      <main className="gate-main">
        <img src="/donkeywork.png" alt="DonkeyWork" className="gate-logo" width={96} height={96} />
        <h1>Welcome back</h1>
        <p className="gate-sub">Sign in to open your notebooks</p>
        {status === 'loading' ? <p className="caption" role="status">Checking your session…</p> : (
          <div className="providers">
            {providers.map(p => <button key={p.id} type="button" className="provider" title={`Sign in with ${p.name}`} aria-label={`Sign in with ${p.name}`} onClick={() => void auth.signIn(returnTo, p.id)}><p.Icon size={p.id === 'github' ? 22 : undefined} /></button>)}
          </div>
        )}
        {error && <p className="gate-error" role="alert">{error}</p>}
      </main>
      <footer className="gate-footer">Built with questionable decisions and caffeine</footer>
    </div>
  )
}
