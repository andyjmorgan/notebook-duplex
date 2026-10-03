import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Moon, Sun } from 'lucide-react'
import type { AuthUser } from '../auth'
import { useTheme } from '../theme'
import { Brand, GitHubIcon } from './Brand'
import { UserMenu } from './UserMenu'
export { Brand } from './Brand'

export const REPO_URL = 'https://github.com/andyjmorgan/notebook-duplex'

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return <button className="icon-button" type="button" onClick={toggle} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-label="Toggle theme">{theme === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}</button>
}

/** The top bar every page shares, laid out like the other DonkeyWork apps: brand, page middle, then GitHub, theme, account. */
export function AppBar({ user, middle, actions }: { user: AuthUser | undefined; middle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="appbar">
      <Link className="brand" to="/" aria-label="DonkeyWork Notebook home"><Brand /></Link>
      {middle ?? <span />}
      <div className="header-actions">
        {actions}
        <a className="icon-button" href={REPO_URL} target="_blank" rel="noreferrer noopener" title="View source on GitHub" aria-label="View source on GitHub"><GitHubIcon /></a>
        <ThemeToggle />
        {user && <UserMenu user={user} />}
      </div>
    </header>
  )
}
