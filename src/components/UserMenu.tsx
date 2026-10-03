import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { KeyRound, LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { auth, initials, type AuthUser } from '../auth'
import { useTheme, type ThemeChoice } from '../theme'

const themes: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [{ value: 'system', label: 'System', Icon: Monitor }, { value: 'light', label: 'Light', Icon: Sun }, { value: 'dark', label: 'Dark', Icon: Moon }]

export function UserMenu({ user }: { user: AuthUser }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const theme = useTheme()
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])
  return (
    <div className="user-menu" ref={ref}>
      <button className="avatar" aria-label="Account menu" aria-haspopup="menu" aria-expanded={open} title={user.name} onClick={() => setOpen(o => !o)}>{initials(user.name || user.email)}</button>
      {open && (
        <div className="menu-card" role="menu">
          <div className="menu-identity"><span className="avatar large" aria-hidden>{initials(user.name || user.email)}</span><div><strong>{user.name}</strong>{user.email && <span className="caption">{user.email}</span>}</div></div>
          <div className="menu-separator" />
          <div className="menu-theme" role="radiogroup" aria-label="Theme">
            <span className="caption">Theme</span>
            <div className="segmented">{themes.map(t => <button key={t.value} role="radio" aria-checked={theme.choice === t.value} className={theme.choice === t.value ? 'on' : ''} onClick={() => theme.set(t.value)} title={t.label}><t.Icon size={14} aria-hidden /><span>{t.label}</span></button>)}</div>
          </div>
          <div className="menu-separator" />
          <Link className="menu-item" role="menuitem" to="/settings/tokens" onClick={() => setOpen(false)}><KeyRound size={16} aria-hidden /><span>Agent access tokens</span></Link>
          <button className="menu-item" role="menuitem" onClick={() => void auth.signOut()}><LogOut size={16} aria-hidden /><span>Sign out</span></button>
        </div>
      )}
    </div>
  )
}
