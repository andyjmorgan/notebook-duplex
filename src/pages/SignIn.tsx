import { Moon, Sun } from 'lucide-react'
import { Brand } from '../components/AppBar'
import { auth } from '../auth'
import { useTheme } from '../theme'

export function SignIn({ status, error }: { status: 'loading' | 'signed-out' | 'error'; error?: string }) {
  const theme = useTheme()
  return (
    <main className="gate">
      <div className="gate-card">
        <Brand large />
        <h1>Notebook Duplex</h1>
        <p>A shared library of notebooks for you and your Claude sessions. Sign in with your lab account to open it.</p>
        {status === 'loading' ? <p className="caption" role="status">Checking your session…</p> : (
          <button className="primary" type="button" autoFocus onClick={() => void auth.signIn(location.pathname + location.search)}>Sign in</button>
        )}
        {error && <p className="gate-error" role="alert">{error}</p>}
        <button className="quiet small gate-theme" type="button" onClick={() => theme.set(theme.resolved === 'dark' ? 'light' : 'dark')}>{theme.resolved === 'dark' ? <Sun size={14} aria-hidden /> : <Moon size={14} aria-hidden />} {theme.resolved === 'dark' ? 'Light theme' : 'Dark theme'}</button>
      </div>
    </main>
  )
}
